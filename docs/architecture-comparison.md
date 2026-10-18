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

The path is short and easy to inspect. Replacing storage means changing the service's concrete data dependency. There is no repository port or storage-failure seam here, and live row mutation would need reconsideration when introducing database transactions.

## Ports and adapters: decisions inside, details outside

The dependency direction is enforced by separate workspace packages and TypeScript references:

```text
hex-adapters → hex-application → hex-domain
      ↓
   contracts
```

[JobApplication](../packages/hex-application/src/index.ts) coordinates each use case through `JobRepository` and `IdGenerator` ports. [DocumentJob](../packages/hex-domain/src/index.ts) owns transitions. The domain imports no other package. The application imports only the domain. Neither receives Node's ambient types.

[The storage adapter](../packages/hex-adapters/src/index.ts) stores snapshots and restores a fresh aggregate for each load. If `save()` throws, a modified aggregate does not silently change the stored copy. An adversarial test injects this failure. A durable adapter would still need transactions and tenant/key uniqueness; a port supplies neither by itself.

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

The projector rejects version gaps and ignores applied versions, so redelivery does not repeat an attempt. The event store rejects an incorrect expected version before changing the journal or submission index. These are sequential local checks. There is no broker, durable log, transactional outbox, concurrent-writer test, or cross-process delivery guarantee.

History and rebuild are useful for studying audit trails and query evolution. They cost more code, separate write/read representations, and an explicit answer for stale reads. A process restart loses the journal and projection here.

## Compare a change

| Change | Layered | Ports and adapters | CQRS/event-driven |
| --- | --- | --- | --- |
| Retry limit | Service rule and tests | Aggregate rule and tests | Command decision and replay/projection tests |
| Durable storage | Change concrete dependency | Implement repository port | Design persistent append, ordering and replay |
| Queue dashboard | Query the same rows | Add query/use case or read port | Extend projection and rebuild |
| Crash recovery | Add persistence | Add persistence through adapter | Persist journal and checkpoint |

## Owner exercises

These are open exercises, not completed results. Record the change, a failing example, test output, and what became easier or harder.

1. **Trace one retry.** Explain why attempts stay at 1 after retry and become 2 only after start. Point to the responsible code in each study.
2. **Limit attempts.** Write a shared failing contract case, implement the same rule three times, and compare the changed files.
3. **Persist the hexagonal implementation.** Add a repository adapter with tenant/key uniqueness. Demonstrate a failed save and a restart without changing domain imports.
4. **Change the read model.** Add a failed-job count per tenant. Verify catch-up, redelivery, and rebuild against the same count.
5. **Strengthen submission identity.** Include a caller-supplied content hash. Decide whether a reused key with changed content conflicts even when the name is unchanged; update all three implementations and tests.
6. **Connect an evaluation boundary.** Define an adapter accepting worker text for an evaluation harness such as [enterprise-ai-lab](https://github.com/edsonsims/enterprise-ai-lab). Record its request/result contract and failure behavior. This integration is not implemented here.
