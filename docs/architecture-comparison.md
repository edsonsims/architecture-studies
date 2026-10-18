# Follow one job through three architectures

Submit `note.txt`, start processing, fail once, retry, start again, and complete with supplied text. The final snapshot has `state=completed`, `attemptCount=2`, and `version=6` in every implementation.

## The behavioral agreement

| Operation | Allowed state | Result |
| --- | --- | --- |
| New tenant/key submission | No existing submission | Queued, zero attempts, version 1 |
| Same tenant/key/name | Any current state | Current snapshot; no new version or event |
| Existing tenant/key, different name | Any current state | Idempotency conflict |
| Start | Queued | Processing; attempts and version increase |
| Complete | Processing | Completed; supplied text stored, version increases |
| Fail | Processing | Failed; reason stored, version increases |
| Retry | Failed | Queued; failure cleared, version increases; attempts unchanged |

Tenant identifiers and keys must be nonempty strings. Different tenants may use the same key. Another tenant's job is treated like a missing job. Invalid transitions leave stored state unchanged. Empty text is valid; a missing/non-string payload is not.

These are method-level rules. A real application still needs to establish the caller's tenant identity. The study does not authenticate a caller or inspect document bytes.

## Layered: decisions in the service

[LayeredWorkflow.start()](../packages/layered/src/index.ts) loads a row from its concrete data layer, checks the state, changes the row, and returns a frozen snapshot. [The model](../packages/layered/src/model.ts) holds data and does not decide which transitions are legal.

The service now selects either its original in-memory data class or [SqliteJobData](../packages/layered/src/sqlite-data.ts). In persistent mode, a transaction encloses the read, transition check, and versioned update. A failed SQL update rolls back; the next query reads the unchanged database row.

The path is short and easy to inspect. Storage is still a concrete service dependency. Swapping to another database means changing that data class and its construction rather than implementing an application-owned port.

## Ports and adapters: decisions inside, details outside

The dependency direction is enforced by separate workspace packages and TypeScript references:

```text
hex-adapters → hex-application → hex-domain
      ↓
   contracts
```

[JobApplication](../packages/hex-application/src/index.ts) coordinates each use case through `JobRepository` and `IdGenerator` ports. [DocumentJob](../packages/hex-domain/src/index.ts) owns transitions. The domain imports no other package. The application imports only the domain. Neither receives Node's ambient types.

[The in-memory adapter](../packages/hex-adapters/src/index.ts) and [SQLite adapter](../packages/hex-adapters/src/sqlite-repository.ts) both restore a detached aggregate for each load. The application wraps each write use case in the repository's transaction port. The SQLite implementation supplies that transaction, tenant/key uniqueness, and an expected-version update. If `save()` throws, rollback preserves the stored copy; the modified aggregate is discarded. Tests inject both a repository error and an actual SQLite trigger failure.

The extra types and translation help when testing storage failures or replacing infrastructure. For a small script, they also add navigation and maintenance.

## CQRS: writes and reads can disagree temporarily

[Commands](../packages/event-driven/src/index.ts) load a [write aggregate](../packages/event-driven/src/aggregate.ts), decide whether the transition is legal, and append an event with an expected stream version. [Queries](../packages/event-driven/src/projection.ts) read a separate map populated by those events.

Delivery is immediate by default, so the shared synchronous contract tests apply. Pause it to observe the boundary:

```ts
const workflow = new EventDrivenWorkflow({ autoProject: false });
const job = workflow.submit('team-a', 'request-1', 'note.txt');
workflow.list('team-a');                    // []: submission not projected yet
workflow.projectPending();
workflow.start('team-a', job.id);           // write result says processing
workflow.get('team-a', job.id).state;       // queued: read model is behind
workflow.projectPending();
workflow.get('team-a', job.id).state;       // processing
workflow.rebuildProjection();              // clear and replay the local journal
```

The projector rejects version gaps and ignores applied versions, so redelivery does not repeat an attempt. The original in-memory store remains available for the demo. The [SQLite event store](../packages/event-driven/src/sqlite-store.ts) adds a durable journal, an atomic submission index, and expected stream versions.

The write transaction commits before projection delivery. An append/index error rolls back and cannot enter the projection. A later projector error has a different outcome: the command is already committed, and replay recovers it. A test deliberately fails delivery after commit, discards the workflow instance, then verifies that a new HTTP server reconstructs the committed state. A caller receiving an error after a write must inspect current state before retrying a transition blindly.

Persistent startup reconstructs the projection from the journal. The HTTP service also catches up before every query, including events written by another local process. The in-memory checkpoint is rebuilt on restart; it is not a second durable authority. Manual `autoProject:false` mode remains a library exercise for observing stale reads and explicit catch-up. There is no broker or transactional outbox.

History and rebuild are useful for studying audit trails and query evolution. They cost more code, separate write/read representations, and an explicit recovery rule. This implementation rereads the journal and reconstructs individual streams, so its work grows with history. It is a small local example, with no throughput or distributed-delivery claim.

## SQLite boundaries and observed concurrency

| Variant | Persistent tables | Transaction boundary | Read path after restart |
| --- | --- | --- | --- |
| Layered | `layered_jobs` | Concrete data transaction around the service's full write | SQL row → immutable response snapshot |
| Ports/adapters | `hex_jobs` | Application-owned transaction port, implemented by SQLite | SQL snapshot → domain aggregate → response DTO |
| CQRS | `cqrs_events`, `cqrs_submissions` | Expected-version check, event append, and new submission index in one transaction | Journal replay → in-memory read projection |

All stores use parameterized statements, WAL mode, a five-second busy timeout, and `BEGIN IMMEDIATE` before checking a key or state that a command will change. SQLite permits one active writer; these transactions serialize the competing writes tested here. See [SQLite transaction semantics](https://www.sqlite.org/lang_transaction.html) and [WAL behavior](https://www.sqlite.org/wal.html).

The integration suite starts two actual Node processes against one file for each architecture. Repeated concurrent submissions produce one ID; racing starts produce one success; competing complete/fail commands produce one terminal transition. Reads from both processes agree, and a fresh CLI process recovers the persisted state. This is local contention and restart evidence, not a distributed consensus or power-loss test.

`node:sqlite` uses synchronous calls, so SQL work and lock waiting block that server process's event loop. Node 24 LTS is the recommended local runtime; the package minimum is Node 22.16. The module remains experimental in Node 22 and is a release candidate in the verified Node 24 version. See the [official Node SQLite API](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html). A higher-throughput design would need measured workload evidence before choosing worker threads, an asynchronous driver, or another database.

## Compare a change

| Change | Layered | Ports and adapters | CQRS/event-driven |
| --- | --- | --- | --- |
| Retry limit | Service rule and tests | Aggregate rule and tests | Command decision and replay/projection tests |
| Another database | Replace concrete SQL data class | Implement the repository/transaction port | Preserve append/index atomicity and stream ordering |
| Queue dashboard | Query the same rows | Add query/use case or read port | Extend projection and rebuild |
| Restart recovery | Reload SQLite rows | Reload aggregate snapshots | Rebuild projection from committed journal |

The [HTTP API guide](node-api.md) gives launch commands, routes, limits, and error semantics. The same thin Fastify adapter fronts all three workflows; HTTP parsing and validation are not copied into the domain or application packages. Fastify schemas reject unknown body fields and type coercion; see [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/).

## The generated-state harness

[Persistent model tests](../tests/persistent-model.test.mjs) use fast-check to generate command/restart sequences against a separate public lifecycle table. Each run checks legal outcomes, unchanged versions after illegal transitions, attempts, payloads, tenant isolation, and persisted resubmission identity. Closing/reopening the SQLite connection is part of the generated sequence. Each architecture runs 30 generated cases.

Failures include a shrunk counterexample and replay seed/path. To replay a reported failure, run `FC_SEED=<seed> FC_PATH=<path> npm test`. The [HTTP integration suite](../tests/http-integration.test.mjs) separately exercises actual loopback requests, malformed input, byte limits, SQL rollback, projection recovery, and process contention.

## Owner exercises

These are open exercises, not completed results. Record the change, a failing example, test output, and what became easier or harder.

1. **Trace one retry.** Explain why attempts stay at 1 after retry and become 2 only after start. Point to the responsible code in each study.
2. **Limit attempts.** Write a shared failing contract case, implement the same rule three times, and compare the changed files.
3. **Replace the hexagonal storage adapter.** Keep the transaction port and domain imports unchanged. Compare the existing SQLite implementation with another persistence adapter, including a failed save and restart.
4. **Change the read model.** Add a failed-job count per tenant. Verify catch-up, redelivery, and rebuild against the same count.
5. **Strengthen submission identity.** Include a caller-supplied content hash. Decide whether a reused key with changed content conflicts even when the name is unchanged; update all three implementations and tests.
6. **Evaluate the service boundary.** Trace the separate [client pipeline](../scripts/study_pipeline.py), which calls the Node job API and Python inspection API. Add a test for a worker response that arrives after a timeout, without pretending that two HTTP services share one database transaction. No model evaluation or OCR is performed by the Node job API.
