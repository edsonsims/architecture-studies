import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as rawRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createJobApi } from '@architecture-studies/http-api';
import { EventDrivenWorkflow } from '@architecture-studies/event-driven';

const architectures = ['layered', 'hexagonal', 'cqrs'];
async function request(address, method, path, body, tenant = 'tenant-a', key = 'upload-1') {
  const headers = { 'x-tenant-id': tenant, 'idempotency-key': key };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(address + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function start(architecture, databasePath) {
  const app = await createJobApi({ architecture, databasePath });
  return { app, address: await app.listen({ host: '127.0.0.1', port: 0 }) };
}

for (const architecture of architectures) {
  test(`${architecture}: HTTP lifecycle persists across closed/reopened server and SQLite connections`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'architecture-api-'));
    const path = join(dir, 'jobs.sqlite');
    let running = await start(architecture, path);
    t.after(async () => { await running.app.close(); await rm(dir, { recursive: true, force: true }); });
    const created = await request(running.address, 'POST', '/v1/jobs', { documentName: 'note.txt' });
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.equal((await request(running.address, 'POST', `/v1/jobs/${id}/start`, {})).body.version, 2);
    assert.equal((await request(running.address, 'POST', `/v1/jobs/${id}/fail`, { reason: 'worker unavailable' })).body.state, 'failed');
    const beforeRestart = (await request(running.address, 'GET', `/v1/jobs/${id}`)).body;
    await running.app.close();
    running = await start(architecture, path);
    assert.deepEqual((await request(running.address, 'GET', `/v1/jobs/${id}`)).body, beforeRestart);
    assert.deepEqual((await request(running.address, 'POST', '/v1/jobs', { documentName: 'note.txt' })).body, beforeRestart);
    assert.equal((await request(running.address, 'POST', '/v1/jobs', { documentName: 'different.txt' })).status, 409);
    assert.equal((await request(running.address, 'GET', `/v1/jobs/${id}`, undefined, 'tenant-b')).status, 404);
    assert.deepEqual((await request(running.address, 'GET', '/v1/jobs', undefined, 'tenant-b')).body, { jobs: [] });
    for (const command of ['start', 'retry', 'complete', 'fail']) {
      const payload = command === 'complete' ? { text: 'wrong tenant' } : command === 'fail' ? { reason: 'wrong tenant' } : {};
      assert.equal((await request(running.address, 'POST', `/v1/jobs/${id}/${command}`, payload, 'tenant-b')).status, 404);
    }
    assert.equal((await request(running.address, 'POST', `/v1/jobs/${id}/retry`, {})).body.version, 4);
    assert.equal((await request(running.address, 'POST', `/v1/jobs/${id}/start`, {})).body.attemptCount, 2);
    const completed = await request(running.address, 'POST', `/v1/jobs/${id}/complete`, { text: 'Supplied text, persisted in SQLite.' });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.version, 6);
    assert.equal(completed.body.state, 'completed');
    assert.equal((await request(running.address, 'POST', `/v1/jobs/${id}/retry`, {})).status, 409);
    await running.app.close();
    running = await start(architecture, path);
    assert.deepEqual((await request(running.address, 'GET', `/v1/jobs/${id}`)).body, completed.body);
  });

  test(`${architecture}: real SQL write failure rolls back state and returns a sanitized HTTP error`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'architecture-rollback-'));
    const path = join(dir, 'jobs.sqlite');
    const running = await start(architecture, path);
    const db = new DatabaseSync(path);
    t.after(async () => { db.close(); await running.app.close(); await rm(dir, { recursive: true, force: true }); });
    const created = await request(running.address, 'POST', '/v1/jobs', { documentName: 'rollback.txt' });
    const id = created.body.id;
    const processing = (await request(running.address, 'POST', `/v1/jobs/${id}/start`, {})).body;
    const target = architecture === 'cqrs' ? 'BEFORE INSERT ON cqrs_events' : `BEFORE UPDATE ON ${architecture === 'layered' ? 'layered_jobs' : 'hex_jobs'}`;
    db.exec(`CREATE TRIGGER reject_write ${target} BEGIN SELECT RAISE(ABORT,'private-database-detail'); END;`);
    const failed = await request(running.address, 'POST', `/v1/jobs/${id}/complete`, { text: 'should not persist' });
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { error: { code: 'internal_error', message: 'The request could not be completed.' } });
    assert.ok(!JSON.stringify(failed.body).includes('private-database-detail'));
    assert.deepEqual((await request(running.address, 'GET', `/v1/jobs/${id}`)).body, processing);
    db.exec('DROP TRIGGER reject_write;');
    const recovered = await request(running.address, 'POST', `/v1/jobs/${id}/complete`, { text: 'now committed' });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.version, 3);
  });
}

test('HTTP schema rejects malformed/types/unknown fields and enforces bytes without advancing state', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'architecture-validation-'));
  const running = await start('hexagonal', join(dir, 'jobs.sqlite'));
  t.after(async () => { await running.app.close(); await rm(dir, { recursive: true, force: true }); });
  assert.deepEqual(await (await fetch(running.address + '/healthz')).json(), { status: 'ok', architecture: 'hexagonal' });
  for (const payload of [null, [], {}, { documentName: 123 }, { documentName: ' ' }, { documentName: 'a.txt', unknown: true }, { documentName: '\ud800' }]) {
    assert.equal((await request(running.address, 'POST', '/v1/jobs', payload)).status, 400);
  }
  assert.equal((await fetch(running.address + '/v1/jobs')).status, 400);
  assert.equal((await fetch(running.address + '/v1/jobs', { method: 'POST', headers: { 'x-tenant-id': 'tenant-a', 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(running.address + '/v1/jobs', { method: 'POST', headers: { 'x-tenant-id': 'tenant-a', 'content-type': 'text/plain' }, body: 'hello' })).status, 415);
  assert.equal((await fetch(running.address + '/missing')).status, 404);
  assert.equal((await request(running.address, 'GET', '/v1/jobs?unknown=1')).status, 400);
  const job = (await request(running.address, 'POST', '/v1/jobs', { documentName: 'validation.txt' })).body;
  const processing = (await request(running.address, 'POST', `/v1/jobs/${job.id}/start`, {})).body;
  assert.equal((await request(running.address, 'POST', `/v1/jobs/${job.id}/complete`, { text: '🙂'.repeat(16385) })).status, 413);
  assert.equal((await request(running.address, 'POST', `/v1/jobs/${job.id}/complete`, { text: 'a'.repeat(270000) })).status, 413);
  assert.deepEqual((await request(running.address, 'GET', `/v1/jobs/${job.id}`)).body, processing);
  assert.equal((await request(running.address, 'POST', `/v1/jobs/${job.id}/complete`, { text: '🙂'.repeat(16384) })).status, 200);
});

test('CQRS event append and submission index roll back together if the index write fails', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'architecture-event-rollback-'));
  const path = join(dir, 'jobs.sqlite');
  const running = await start('cqrs', path);
  const db = new DatabaseSync(path);
  t.after(async () => { db.close(); await running.app.close(); await rm(dir, { recursive: true, force: true }); });
  db.exec("CREATE TRIGGER reject_index BEFORE INSERT ON cqrs_submissions BEGIN SELECT RAISE(ABORT,'index unavailable'); END;");
  assert.equal((await request(running.address, 'POST', '/v1/jobs', { documentName: 'atomic.txt' })).status, 500);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cqrs_events').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cqrs_submissions').get().n, 0);
  assert.deepEqual((await request(running.address, 'GET', '/v1/jobs')).body, { jobs: [] });
  db.exec('DROP TRIGGER reject_index;');
  assert.equal((await request(running.address, 'POST', '/v1/jobs', { documentName: 'atomic.txt' })).status, 201);
});

test('HTTP rejects repeated tenant and idempotency headers instead of joining identities', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'architecture-headers-'));
  const running = await start('hexagonal', join(dir, 'jobs.sqlite'));
  t.after(async () => { await running.app.close(); await rm(dir, { recursive: true, force: true }); });
  const body = JSON.stringify({ documentName: 'headers.txt' });
  for (const ambiguous of [
    ['X-Tenant-Id', 'owner', 'x-tenant-id', 'other', 'Idempotency-Key', 'key'],
    ['X-Tenant-Id', 'owner', 'Idempotency-Key', 'one', 'idempotency-key', 'two'],
  ]) {
    const status = await new Promise((resolveStatus, reject) => {
      const req = rawRequest(running.address + '/v1/jobs', { method: 'POST', headers: [
        'Host', new URL(running.address).host, 'Content-Type', 'application/json', 'Content-Length', String(Buffer.byteLength(body)), ...ambiguous,
      ] }, response => { response.resume(); response.on('end', () => resolveStatus(response.statusCode)); });
      req.on('error', reject); req.end(body);
    });
    assert.equal(status, 400);
  }
  assert.deepEqual((await request(running.address, 'GET', '/v1/jobs', undefined, 'owner')).body, { jobs: [] });
});

test('CQRS recovers a committed command after projection delivery fails and the process state is discarded', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'architecture-recovery-'));
  const path = join(dir, 'jobs.sqlite');
  const workflow = new EventDrivenWorkflow({ databasePath: path });
  const job = workflow.submit('tenant-a', 'key', 'recover.txt');
  workflow.projection.apply = () => { throw new Error('simulated delivery failure after COMMIT'); };
  assert.throws(() => workflow.start('tenant-a', job.id), /delivery failure/);
  workflow.close();
  const running = await start('cqrs', path);
  t.after(async () => { await running.app.close(); await rm(dir, { recursive: true, force: true }); });
  const recovered = await request(running.address, 'GET', `/v1/jobs/${job.id}`);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.state, 'processing');
  assert.equal(recovered.body.version, 2);
  assert.equal(recovered.body.attemptCount, 1);
});

async function processServer(architecture, databasePath) {
  const child = spawn(process.execPath, [resolve('packages/http-api/dist/cli.js')], {
    env: { ...process.env, ARCHITECTURE: architecture, DB_PATH: databasePath, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const address = await new Promise((resolveAddress, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Server startup timed out.')); }, 10000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      const line = output.split('\n')[0];
      if (!line) return;
      try { const value = JSON.parse(line); clearTimeout(timer); resolveAddress(value.address); } catch { /* Wait for the complete line. */ }
    });
  });
  return { address, close: async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  } };
}

for (const architecture of architectures) {
  test(`${architecture}: separate Node processes serialize duplicate submissions and conflicting starts`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'architecture-concurrency-'));
    const path = join(dir, 'jobs.sqlite');
    const processes = [];
    t.after(async () => {
      await Promise.all(processes.map(server => server.close()));
      await rm(dir, { recursive: true, force: true });
    });
    let first = await processServer(architecture, path);
    processes.push(first);
    const second = await processServer(architecture, path);
    processes.push(second);
    const duplicates = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      request(i % 2 ? first.address : second.address, 'POST', '/v1/jobs', { documentName: 'same.txt' })));
    assert.ok(duplicates.every(result => result.status === 201));
    const ids = new Set(duplicates.map(result => result.body.id));
    assert.equal(ids.size, 1);
    const id = duplicates[0].body.id;
    const starts = await Promise.all([first, second].map(server => request(server.address, 'POST', `/v1/jobs/${id}/start`, {})));
    assert.deepEqual(starts.map(result => result.status).sort(), [200, 409]);
    for (const server of [first, second]) {
      const state = (await request(server.address, 'GET', `/v1/jobs/${id}`)).body;
      assert.equal(state.version, 2);
      assert.equal(state.attemptCount, 1);
      assert.equal(state.state, 'processing');
      assert.equal((await request(server.address, 'GET', '/v1/jobs')).body.jobs.length, 1);
    }
    const terminal = await Promise.all([
      request(first.address, 'POST', `/v1/jobs/${id}/complete`, { text: 'race completion' }),
      request(second.address, 'POST', `/v1/jobs/${id}/fail`, { reason: 'race failure' }),
    ]);
    assert.deepEqual(terminal.map(result => result.status).sort(), [200, 409]);
    const final = terminal.find(result => result.status === 200).body;
    assert.equal(final.version, 3);
    assert.deepEqual((await request(second.address, 'GET', `/v1/jobs/${id}`)).body, final);
    await first.close();
    first = await processServer(architecture, path);
    processes.push(first);
    assert.deepEqual((await request(first.address, 'GET', `/v1/jobs/${id}`)).body, final,
      'A genuinely new Node process recovers the same persisted state.');
  });
}
