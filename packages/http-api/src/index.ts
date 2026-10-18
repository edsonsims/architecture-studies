import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { IdempotencyConflictError, InvalidTransitionError, JobNotFoundError, type JobWorkflow } from '@architecture-studies/contracts';
import { LayeredWorkflow } from '@architecture-studies/layered';
import { HexagonalWorkflow, SqliteJobRepository } from '@architecture-studies/hex-adapters';
import { EventDrivenWorkflow } from '@architecture-studies/event-driven';
import * as schema from './schemas.js';

export type Architecture = 'layered' | 'hexagonal' | 'cqrs';
type TenantHeaders = { 'x-tenant-id': string };
type SubmissionHeaders = TenantHeaders & { 'idempotency-key': string };
type JobParams = { id: string };

class RequestError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function wellFormed(...values: string[]): void {
  if (values.some(value => Buffer.from(value, 'utf8').toString('utf8') !== value))
    throw new RequestError(400, 'String values must contain valid Unicode.');
}

function openWorkflow(architecture: Architecture, databasePath: string): { workflow: JobWorkflow; close: () => void } {
  switch (architecture) {
    case 'layered': {
      const workflow = new LayeredWorkflow({ databasePath });
      return { workflow, close: () => workflow.close() };
    }
    case 'hexagonal': {
      const repository = new SqliteJobRepository(databasePath);
      return { workflow: new HexagonalWorkflow(repository), close: () => repository.close() };
    }
    case 'cqrs': {
      const workflow = new EventDrivenWorkflow({ databasePath });
      return { workflow, close: () => workflow.close() };
    }
    default: throw new Error('Unknown architecture.');
  }
}

export async function createJobApi(options: { architecture: Architecture; databasePath: string }): Promise<FastifyInstance> {
  if (!['layered', 'hexagonal', 'cqrs'].includes(options.architecture)) throw new Error('Unknown architecture.');
  if (typeof options.databasePath !== 'string' || !options.databasePath.trim()) throw new Error('A database path is required.');
  if (options.databasePath !== ':memory:') mkdirSync(dirname(resolve(options.databasePath)), { recursive: true });
  const resource = openWorkflow(options.architecture, options.databasePath);
  const workflow = resource.workflow;
  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
  });
  app.addHook('onClose', async () => resource.close());
  app.addHook('preValidation', async request => {
    // Node joins repeated string headers. Reject ambiguity before schema checks
    // can mistake the joined value for one tenant or idempotency identity.
    for (const name of ['x-tenant-id', 'idempotency-key']) {
      let occurrences = 0;
      for (let index = 0; index < request.raw.rawHeaders.length; index += 2)
        if (request.raw.rawHeaders[index]?.toLowerCase() === name) occurrences++;
      if (occurrences > 1) throw new RequestError(400, `Header ${name} must occur once.`);
    }
    if (request.method === 'POST' && request.url.startsWith('/v1/')) {
      const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') throw new RequestError(415, 'Content-Type must be application/json.');
    }
    const tenant = request.headers['x-tenant-id'];
    const key = request.headers['idempotency-key'];
    if (typeof tenant === 'string') wellFormed(tenant);
    if (typeof key === 'string') wellFormed(key);
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Route was not found.' } }));
  app.setErrorHandler((error, _request, reply) => {
    let status = 500; let code = 'internal_error'; let message = 'The request could not be completed.';
    if (error instanceof JobNotFoundError) { status = 404; code = 'job_not_found'; message = 'Job was not found.'; }
    else if (error instanceof IdempotencyConflictError) { status = 409; code = 'idempotency_conflict'; message = error.message; }
    else if (error instanceof InvalidTransitionError) { status = 409; code = 'invalid_transition'; message = error.message; }
    else if (error instanceof RequestError) {
      status = error.statusCode; code = status === 413 ? 'payload_too_large' : status === 415 ? 'unsupported_media_type' : 'invalid_request';
      message = error.message;
    } else if (error && typeof error === 'object') {
      const framework = error as { validation?: unknown; statusCode?: number };
      if (framework.validation || framework.statusCode === 400 || error instanceof TypeError) {
        status = 400; code = 'invalid_request'; message = 'Request validation failed.';
      } else if (framework.statusCode === 413) {
        status = 413; code = 'payload_too_large'; message = 'Request body exceeds the limit.';
      } else if (framework.statusCode === 415) {
        status = 415; code = 'unsupported_media_type'; message = 'Content-Type must be application/json.';
      }
    }
    void reply.code(status).send({ error: { code, message } });
  });

  app.get('/healthz', { schema: { querystring: schema.noQuery } }, async () => ({ status: 'ok', architecture: options.architecture }));
  app.post<{ Headers: SubmissionHeaders; Body: { documentName: string } }>('/v1/jobs', {
    schema: { headers: schema.submissionHeaders, body: schema.submissionBody, querystring: schema.noQuery, response: { 201: schema.job } },
  }, async (request, reply) => {
    wellFormed(request.body.documentName);
    const job = workflow.submit(request.headers['x-tenant-id'], request.headers['idempotency-key'], request.body.documentName);
    return reply.code(201).send(job);
  });
  app.get<{ Headers: TenantHeaders }>('/v1/jobs', {
    schema: { headers: schema.headers, querystring: schema.noQuery,
      response: { 200: { type: 'object', required: ['jobs'], properties: { jobs: { type: 'array', items: schema.job } } } } },
  }, async request => ({ jobs: workflow.list(request.headers['x-tenant-id']) }));
  app.get<{ Headers: TenantHeaders; Params: JobParams }>('/v1/jobs/:id', {
    schema: { headers: schema.headers, params: schema.params, querystring: schema.noQuery, response: { 200: schema.job } },
  }, async request => workflow.get(request.headers['x-tenant-id'], request.params.id));
  for (const command of ['start', 'retry'] as const) {
    app.post<{ Headers: TenantHeaders; Params: JobParams; Body: Record<string, never> }>(`/v1/jobs/:id/${command}`, {
      schema: { headers: schema.headers, params: schema.params, body: schema.emptyBody, querystring: schema.noQuery, response: { 200: schema.job } },
    }, async request => workflow[command](request.headers['x-tenant-id'], request.params.id));
  }
  app.post<{ Headers: TenantHeaders; Params: JobParams; Body: { text: string } }>('/v1/jobs/:id/complete', {
    schema: { headers: schema.headers, params: schema.params, body: schema.completeBody, querystring: schema.noQuery, response: { 200: schema.job } },
  }, async request => {
    wellFormed(request.body.text);
    if (Buffer.byteLength(request.body.text, 'utf8') > 65536) throw new RequestError(413, 'Text exceeds 65536 UTF-8 bytes.');
    return workflow.complete(request.headers['x-tenant-id'], request.params.id, request.body.text);
  });
  app.post<{ Headers: TenantHeaders; Params: JobParams; Body: { reason: string } }>('/v1/jobs/:id/fail', {
    schema: { headers: schema.headers, params: schema.params, body: schema.failBody, querystring: schema.noQuery, response: { 200: schema.job } },
  }, async request => {
    wellFormed(request.body.reason);
    return workflow.fail(request.headers['x-tenant-id'], request.params.id, request.body.reason);
  });

  try { await app.ready(); return app; }
  catch (error) { await app.close(); throw error; }
}
