import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fc from 'fast-check';
import { InvalidTransitionError } from '@architecture-studies/contracts';
import { LayeredWorkflow } from '@architecture-studies/layered';
import { HexagonalWorkflow, SqliteJobRepository } from '@architecture-studies/hex-adapters';
import { EventDrivenWorkflow } from '@architecture-studies/event-driven';

const factories = {
  layered: path => { const workflow = new LayeredWorkflow({ databasePath: path }); return { workflow, close: () => workflow.close() }; },
  hexagonal: path => { const repository = new SqliteJobRepository(path); return { workflow: new HexagonalWorkflow(repository), close: () => repository.close() }; },
  cqrs: path => { const workflow = new EventDrivenWorkflow({ databasePath: path }); return { workflow, close: () => workflow.close() }; },
};

// Public lifecycle specification, independent of aggregate/storage internals.
const transitions = {
  queued: { start: 'processing' },
  processing: { complete: 'completed', fail: 'failed' },
  failed: { retry: 'queued' },
  completed: {},
};
const sequences = fc.array(fc.constantFrom('start', 'complete', 'fail', 'retry', 'restart'), { minLength: 1, maxLength: 45 });
for (const [name, create] of Object.entries(factories)) {
  test(`${name}: generated lifecycle/restart sequences obey the public state model`, () => {
    const parameters = { numRuns: 30, verbose: true };
    if (process.env.FC_SEED) parameters.seed = Number(process.env.FC_SEED);
    if (process.env.FC_PATH) parameters.path = process.env.FC_PATH;
    fc.assert(fc.property(sequences, operations => {
      const directory = mkdtempSync(join(tmpdir(), 'architecture-model-'));
      const path = join(directory, 'jobs.sqlite');
      let resource = create(path);
      try {
        const submitted = resource.workflow.submit('model-tenant', 'model-key', 'model.txt');
        const id = submitted.id;
        const model = { state: 'queued', version: 1, attemptCount: 0, text: null, failure: null };
        for (const operation of operations) {
          if (operation === 'restart') {
            resource.close(); resource = create(path);
          } else {
            const before = resource.workflow.get('model-tenant', id);
            const expected = transitions[model.state][operation];
            const run = () => operation === 'complete' ? resource.workflow.complete('model-tenant', id, 'model output')
              : operation === 'fail' ? resource.workflow.fail('model-tenant', id, 'model failure')
              : resource.workflow[operation]('model-tenant', id);
            if (!expected) {
              assert.throws(run, InvalidTransitionError);
              assert.deepEqual(resource.workflow.get('model-tenant', id), before);
            } else {
              run(); model.state = expected; model.version++;
              if (operation === 'start') model.attemptCount++;
              if (operation === 'complete') model.text = 'model output';
              if (operation === 'fail') model.failure = 'model failure';
              if (operation === 'retry') model.failure = null;
            }
          }
          const actual = resource.workflow.get('model-tenant', id);
          for (const [field, value] of Object.entries(model)) assert.equal(actual[field], value, `${name}/${operation}/${field}`);
          assert.equal(resource.workflow.list('model-tenant').length, 1);
          assert.deepEqual(resource.workflow.list('another-tenant'), []);
          assert.deepEqual(resource.workflow.submit('model-tenant', 'model-key', 'model.txt'), actual,
            'Generated command sequences must not weaken persisted submission idempotency.');
        }
      } finally { resource.close(); rmSync(directory, { recursive: true, force: true }); }
    }), parameters);
    // fast-check reports the failing seed, replay path and shrunk sequence.
  });
}
