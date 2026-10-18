import assert from 'node:assert/strict';
import test from 'node:test';
import { LayeredWorkflow } from '@architecture-studies/layered';
import { HexagonalWorkflow, InMemoryJobRepository } from '@architecture-studies/hex-adapters';
import { EventDrivenWorkflow } from '@architecture-studies/event-driven';
import { JobNotFoundError, InvalidTransitionError, IdempotencyConflictError } from '@architecture-studies/contracts';
// Focused internal tests exercise event delivery and conflict failure boundaries.
import { JobProjection } from '../packages/event-driven/dist/projection.js';
import { InMemoryEventStore } from '../packages/event-driven/dist/store.js';

const factories = { layered: () => new LayeredWorkflow(), hexagonal: () => new HexagonalWorkflow(), events: () => new EventDrivenWorkflow() };

function mutateIfWritable(object, key, value) {
  try {
    object[key] = value;
  } catch (error) {
    assert(error instanceof TypeError);
  }
}

for (const [name, create] of Object.entries(factories)) {
  test(`${name}: tenant-scoped idempotency keys have no delimiter or prototype collisions`, () => {
    const workflow = create();
    const first = workflow.submit("customer:region", "request", "one.pdf");
    const second = workflow.submit("customer", "region:request", "two.pdf");
    const third = workflow.submit("__proto__", "constructor", "three.pdf");
    const fourth = workflow.submit("customer", "__proto__", "four.pdf");
    assert.equal(new Set([first.id, second.id, third.id, fourth.id]).size, 4);
    assert.equal(workflow.submit("customer:region", "request", "one.pdf").id, first.id);
    assert.equal(workflow.submit("customer", "region:request", "two.pdf").id, second.id);
    assert.equal(workflow.submit("__proto__", "constructor", "three.pdf").id, third.id);
    assert.throws(() => workflow.submit("customer", "region:request", "other.pdf"), IdempotencyConflictError);
    assert.equal(workflow.list("customer").length, 2);
    assert.equal(workflow.list("customer:region").length, 1);
    assert.equal(workflow.list("__proto__").length, 1);
  });

  test(`${name}: returned views cannot rewrite stored lifecycle or tenant ownership`, () => {
    const workflow = create();
    const submitted = workflow.submit("owner", "one", "private.pdf");
    const id = submitted.id;
    mutateIfWritable(submitted, "tenantId", "attacker");
    mutateIfWritable(submitted, "state", "completed");
    mutateIfWritable(submitted, "text", "forged");
    mutateIfWritable(submitted, "version", 999);
    assert.equal(workflow.get("owner", id).state, "queued");
    assert.equal(workflow.get("owner", id).tenantId, "owner");
    assert.equal(workflow.get("owner", id).text, null);
    assert.equal(workflow.get("owner", id).version, 1);
    assert.throws(() => workflow.get("attacker", id), JobNotFoundError);
    const listed = workflow.list("owner");
    mutateIfWritable(listed[0], "failure", "external mutation");
    assert.equal(workflow.get("owner", id).failure, null);
    const fetched = workflow.get("owner", id);
    workflow.start("owner", id);
    assert.equal(fetched.state, "queued", "previous snapshots must not change after later commands");
  });

  test(`${name}: every cross-tenant command is hidden and leaves owner state intact`, () => {
    const workflow = create();
    const job = workflow.submit("owner", "one", "private.pdf");
    const before = workflow.get("owner", job.id);
    for (const action of [
      () => workflow.get("attacker", job.id),
      () => workflow.start("attacker", job.id),
      () => workflow.complete("attacker", job.id, "stolen"),
      () => workflow.fail("attacker", job.id, "tamper"),
      () => workflow.retry("attacker", job.id),
    ]) {
      assert.throws(action, JobNotFoundError);
      assert.deepEqual(workflow.get("owner", job.id), before);
    }
    assert.deepEqual(workflow.list("attacker"), []);
    const independentlySubmitted = workflow.submit("attacker", "one", "private.pdf");
    assert.notEqual(independentlySubmitted.id, job.id);
  });

  test(`${name}: rejected transitions are atomic and failed jobs require explicit retry`, () => {
    const workflow = create();
    const job = workflow.submit("tenant", "one", "file.pdf");
    function unchangedAfter(action) {
      const before = workflow.get("tenant", job.id);
      assert.throws(action, InvalidTransitionError);
      assert.deepEqual(workflow.get("tenant", job.id), before);
    }
    unchangedAfter(() => workflow.complete("tenant", job.id, "too early"));
    unchangedAfter(() => workflow.fail("tenant", job.id, "too early"));
    unchangedAfter(() => workflow.retry("tenant", job.id));
    workflow.start("tenant", job.id);
    unchangedAfter(() => workflow.start("tenant", job.id));
    unchangedAfter(() => workflow.retry("tenant", job.id));
    workflow.fail("tenant", job.id, "decoder failed");
    unchangedAfter(() => workflow.start("tenant", job.id));
    unchangedAfter(() => workflow.complete("tenant", job.id, "bypassed retry"));
    const queued = workflow.retry("tenant", job.id);
    assert.equal(queued.state, "queued");
    assert.equal(queued.failure, null);
    assert.equal(queued.attemptCount, 1);
    const restarted = workflow.start("tenant", job.id);
    assert.equal(restarted.attemptCount, 2);
    const completed = workflow.complete("tenant", job.id, "provided text");
    assert.equal(completed.text, "provided text");
    assert.equal(completed.failure, null);
    assert.equal(completed.version, 6);
    unchangedAfter(() => workflow.retry("tenant", job.id));
    unchangedAfter(() => workflow.start("tenant", job.id));
    unchangedAfter(() => workflow.fail("tenant", job.id, "after completion"));
  });

  test(`${name}: idempotent resubmission after completion returns current state`, () => {
    const workflow = create();
    const job = workflow.submit("tenant", "one", "file.pdf");
    workflow.start("tenant", job.id);
    const completed = workflow.complete("tenant", job.id, "provided text");
    const resubmitted = workflow.submit("tenant", "one", "file.pdf");
    assert.deepEqual(resubmitted, completed);
    assert.equal(workflow.list("tenant").length, 1);
    assert.throws(() => workflow.submit("tenant", "one", "different.pdf"), IdempotencyConflictError);
    assert.deepEqual(workflow.get("tenant", job.id), completed);
  });

  test(`${name}: invalid payloads cannot partially advance a processing job`, () => {
    const workflow = create();
    const job = workflow.submit("tenant", "one", "file.pdf");
    workflow.start("tenant", job.id);
    const before = workflow.get("tenant", job.id);
    for (const value of [null, undefined, 123, {}, []]) {
      assert.throws(() => workflow.complete("tenant", job.id, value), TypeError);
      assert.deepEqual(workflow.get("tenant", job.id), before);
    }
    for (const reason of [null, undefined, 123, "", " \t\n"]) {
      assert.throws(() => workflow.fail("tenant", job.id, reason), TypeError);
      assert.deepEqual(workflow.get("tenant", job.id), before);
    }
  });
}

test("hexagonal: a failed repository save cannot leak aggregate mutations", () => {
  class FailingRepository extends InMemoryJobRepository {
    shouldFail = false;
    save(job) {
      if (this.shouldFail) throw new Error("storage unavailable");
      super.save(job);
    }
  }
  const repository = new FailingRepository();
  const workflow = new HexagonalWorkflow(repository);
  const job = workflow.submit("tenant", "one", "file.pdf");
  repository.shouldFail = true;
  assert.throws(() => workflow.start("tenant", job.id), /storage unavailable/);
  repository.shouldFail = false;
  assert.deepEqual(workflow.get("tenant", job.id), job);
});

test("CQRS: pending commands use write state while queries retain the prior projection", () => {
  const workflow = new EventDrivenWorkflow({ autoProject: false });
  const first = workflow.submit("owner", "same-key", "one.pdf");
  assert.equal(workflow.pendingEventCount, 1);
  assert.deepEqual(workflow.list("owner"), []);
  assert.throws(() => workflow.get("owner", first.id), JobNotFoundError);
  workflow.start("owner", first.id);
  const completed = workflow.complete("owner", first.id, "first result");
  assert.equal(workflow.pendingEventCount, 3);
  assert.deepEqual(workflow.submit("owner", "same-key", "one.pdf"), completed);
  assert.equal(workflow.pendingEventCount, 3, "resubmission must not append another event");
  assert.throws(() => workflow.get("attacker", first.id), JobNotFoundError);
  workflow.projectPending();
  assert.equal(workflow.pendingEventCount, 0);
  assert.deepEqual(workflow.get("owner", first.id), completed);
  workflow.projectPending();
  assert.equal(workflow.list("owner").length, 1);

  const second = workflow.submit("owner", "two", "two.pdf");
  const otherTenant = workflow.submit("attacker", "same-key", "other.pdf");
  workflow.start("owner", second.id);
  const failed = workflow.fail("owner", second.id, "decoder failed");
  assert.equal(workflow.pendingEventCount, 4);
  assert.equal(workflow.list("owner").length, 1, "read model should not expose unprojected jobs");
  assert.deepEqual(workflow.list("attacker"), []);
  workflow.rebuildProjection();
  assert.equal(workflow.pendingEventCount, 0);
  assert.deepEqual(workflow.get("owner", second.id), failed);
  assert.equal(workflow.list("owner").length, 2);
  assert.deepEqual(workflow.get("attacker", otherTenant.id), otherTenant);
  assert.throws(() => workflow.get("owner", otherTenant.id), JobNotFoundError);
  const before = workflow.list("owner");
  workflow.rebuildProjection();
  assert.deepEqual(workflow.list("owner"), before);
});

test("projection: version gaps fail atomically and redelivery never repeats an attempt", () => {
  const projection = new JobProjection();
  const submitted = { tenantId: "owner", jobId: "one", version: 1, payload: { type: "submitted", key: "one", name: "one.pdf" } };
  projection.apply(submitted);
  const before = projection.get("owner", "one");
  assert.throws(() => projection.apply({ ...submitted, version: 3, payload: { type: "started" } }), /stream order/);
  assert.deepEqual(projection.get("owner", "one"), before);
  const started = { ...submitted, version: 2, payload: { type: "started" } };
  projection.apply(started);
  projection.apply(started);
  projection.apply(submitted);
  assert.equal(projection.get("owner", "one").attemptCount, 1);
  assert.equal(projection.get("owner", "one").version, 2);
  assert.equal(projection.get("owner", "one").state, "processing");
});

test("projection: equal stream IDs in different tenants keep their own data and versions", () => {
  const projection = new JobProjection();
  for (const tenantId of ["owner", "other"]) {
    projection.apply({ tenantId, jobId: "same-id", version: 1, payload: { type: "submitted", key: "same", name: `${tenantId}.pdf` } });
  }
  projection.apply({ tenantId: "owner", jobId: "same-id", version: 2, payload: { type: "started" } });
  assert.equal(projection.get("owner", "same-id").documentName, "owner.pdf");
  assert.equal(projection.get("owner", "same-id").state, "processing");
  assert.equal(projection.get("other", "same-id").documentName, "other.pdf");
  assert.equal(projection.get("other", "same-id").state, "queued");
  assert.equal(projection.get("other", "same-id").version, 1);
});

test("event store: optimistic conflicts do not append or poison submission indexes", () => {
  const store = new InMemoryEventStore();
  store.append("owner", "one", 0, { type: "submitted", key: "one", name: "one.pdf" });
  const before = store.all();
  assert.throws(() => store.append("owner", "one", 0, { type: "submitted", key: "poison", name: "other.pdf" }), /version/);
  assert.deepEqual(store.all(), before);
  assert.equal(store.findSubmission("owner", "one"), "one");
  assert.equal(store.findSubmission("owner", "poison"), undefined);
  const exposed = store.read("owner", "one");
  mutateIfWritable(exposed[0].payload, "name", "forged.pdf");
  exposed.length = 0;
  assert.equal(store.read("owner", "one").length, 1);
  assert.equal(store.read("owner", "one")[0].payload.name, "one.pdf");
});
