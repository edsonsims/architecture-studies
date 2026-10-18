import test from 'node:test';
import assert from 'node:assert/strict';
import { IdempotencyConflictError, InvalidTransitionError, JobNotFoundError } from '@architecture-studies/contracts';
import { LayeredWorkflow } from '@architecture-studies/layered';
import { HexagonalWorkflow } from '@architecture-studies/hex-adapters';
import { EventDrivenWorkflow } from '@architecture-studies/event-driven';

const factories = [
  ['layered', () => new LayeredWorkflow()],
  ['ports and adapters', () => new HexagonalWorkflow()],
  ['CQRS and events', () => new EventDrivenWorkflow()],
];

for (const [name, create] of factories) {
  test(`${name}: submit, start and complete follow the same contract`, () => {
    const workflow = create();
    const submitted = workflow.submit('tenant-a', 'request-1', 'note.txt');
    assert.equal(submitted.state, 'queued');
    assert.equal(submitted.attemptCount, 0);
    assert.equal(submitted.version, 1);
    assert.equal(submitted.text, null);
    const started = workflow.start('tenant-a', submitted.id);
    assert.equal(started.state, 'processing');
    assert.equal(started.attemptCount, 1);
    assert.equal(started.version, 2);
    const completed = workflow.complete('tenant-a', submitted.id, 'Supplied plain text');
    assert.equal(completed.state, 'completed');
    assert.equal(completed.text, 'Supplied plain text');
    assert.equal(completed.version, 3);
    assert.deepEqual(workflow.get('tenant-a', submitted.id), completed);
    assert.deepEqual(workflow.list('tenant-a'), [completed]);
    assert.equal(submitted.state, 'queued', 'Previously returned snapshots do not change.');
  });

  test(`${name}: failure, retry and a second attempt preserve identity`, () => {
    const workflow = create();
    const job = workflow.submit('tenant-a', 'request-1', 'note.txt');
    workflow.start('tenant-a', job.id);
    const failed = workflow.fail('tenant-a', job.id, 'Simulated transient failure');
    assert.equal(failed.state, 'failed');
    assert.equal(failed.failure, 'Simulated transient failure');
    const retry = workflow.retry('tenant-a', job.id);
    assert.equal(retry.id, job.id);
    assert.equal(retry.failure, null);
    assert.equal(retry.state, 'queued');
    assert.equal(retry.attemptCount, 1, 'Retry queues work; it does not start an attempt.');
    assert.equal(workflow.start('tenant-a', job.id).attemptCount, 2);
    assert.equal(workflow.complete('tenant-a', job.id, '').version, 6);
  });

  test(`${name}: submission keys are idempotent and tenant scoped`, () => {
    const workflow = create();
    const job = workflow.submit('tenant-a', 'same-key', 'note.txt');
    assert.deepEqual(workflow.submit('tenant-a', 'same-key', 'note.txt'), job);
    workflow.start('tenant-a', job.id);
    const duplicate = workflow.submit('tenant-a', 'same-key', 'note.txt');
    assert.equal(duplicate.id, job.id);
    assert.equal(duplicate.state, 'processing');
    assert.equal(duplicate.version, 2);
    assert.throws(() => workflow.submit('tenant-a', 'same-key', 'different.txt'), IdempotencyConflictError);
    const other = workflow.submit('tenant-b', 'same-key', 'note.txt');
    assert.notEqual(other.id, job.id);
    assert.equal(workflow.list('tenant-a').length, 1);
    assert.equal(workflow.list('tenant-b').length, 1);
  });

  test(`${name}: every tenant-scoped command hides another tenant's job`, () => {
    const workflow = create();
    const job = workflow.submit('tenant-a', 'key', 'note.txt');
    for (const action of [
      () => workflow.get('tenant-b', job.id),
      () => workflow.start('tenant-b', job.id),
      () => workflow.complete('tenant-b', job.id, 'text'),
      () => workflow.fail('tenant-b', job.id, 'reason'),
      () => workflow.retry('tenant-b', job.id),
      () => workflow.get('tenant-a', 'missing-id'),
    ]) assert.throws(action, JobNotFoundError);
    assert.deepEqual(workflow.list('tenant-b'), []);
    assert.deepEqual(workflow.get('tenant-a', job.id), job);
  });

  test(`${name}: invalid transitions leave state and version unchanged`, () => {
    const workflow = create();
    const job = workflow.submit('tenant-a', 'key', 'note.txt');
    for (const action of [
      () => workflow.complete('tenant-a', job.id, 'too early'),
      () => workflow.fail('tenant-a', job.id, 'too early'),
      () => workflow.retry('tenant-a', job.id),
    ]) assert.throws(action, InvalidTransitionError);
    assert.deepEqual(workflow.get('tenant-a', job.id), job);
    workflow.start('tenant-a', job.id);
    assert.throws(() => workflow.start('tenant-a', job.id), InvalidTransitionError);
    const completed = workflow.complete('tenant-a', job.id, 'finished');
    for (const action of [
      () => workflow.start('tenant-a', job.id),
      () => workflow.complete('tenant-a', job.id, 'again'),
      () => workflow.fail('tenant-a', job.id, 'too late'),
      () => workflow.retry('tenant-a', job.id),
    ]) assert.throws(action, InvalidTransitionError);
    assert.deepEqual(workflow.get('tenant-a', job.id), completed);
  });

  test(`${name}: invalid input does not create or partially complete work`, () => {
    const workflow = create();
    for (const args of [['', 'key', 'a.txt'], ['tenant', ' ', 'a.txt'], ['tenant', 'key', '']])
      assert.throws(() => workflow.submit(...args), TypeError);
    assert.deepEqual(workflow.list('tenant'), []);
    const job = workflow.submit('tenant', 'key', 'a.txt');
    const processing = workflow.start('tenant', job.id);
    assert.throws(() => workflow.complete('tenant', job.id, null), TypeError);
    assert.throws(() => workflow.fail('tenant', job.id, ' '), TypeError);
    assert.deepEqual(workflow.get('tenant', job.id), processing);
  });
}

test('CQRS: commands return write state while queries wait for projection delivery', () => {
  const workflow = new EventDrivenWorkflow({ autoProject: false });
  const job = workflow.submit('tenant-a', 'key', 'note.txt');
  assert.equal(workflow.pendingEventCount, 1);
  assert.deepEqual(workflow.list('tenant-a'), []);
  assert.throws(() => workflow.get('tenant-a', job.id), JobNotFoundError);
  workflow.projectPending();
  assert.equal(workflow.get('tenant-a', job.id).state, 'queued');
  const processing = workflow.start('tenant-a', job.id);
  assert.equal(processing.state, 'processing');
  assert.equal(workflow.get('tenant-a', job.id).state, 'queued');
  assert.equal(workflow.submit('tenant-a', 'key', 'note.txt').state, 'processing');
  assert.equal(workflow.pendingEventCount, 1, 'Resubmission creates no additional event.');
  workflow.projectPending();
  assert.deepEqual(workflow.get('tenant-a', job.id), processing);
  assert.equal(workflow.pendingEventCount, 0);
});

test('CQRS: rebuild and repeated catch-up retain versions, attempts and tenant boundaries', () => {
  const workflow = new EventDrivenWorkflow();
  const first = workflow.submit('tenant-a', 'key', 'note.txt');
  workflow.start('tenant-a', first.id);
  workflow.fail('tenant-a', first.id, 'temporary');
  workflow.retry('tenant-a', first.id);
  workflow.start('tenant-a', first.id);
  const completed = workflow.complete('tenant-a', first.id, 'result');
  const second = workflow.submit('tenant-b', 'key', 'other.txt');
  workflow.rebuildProjection();
  workflow.projectPending();
  workflow.rebuildProjection();
  assert.deepEqual(workflow.list('tenant-a'), [completed]);
  assert.deepEqual(workflow.list('tenant-b'), [second]);
  assert.equal(workflow.pendingEventCount, 0);
});
