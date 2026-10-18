import { randomUUID } from 'node:crypto';
import { IdempotencyConflictError, type JobView, type JobWorkflow } from '@architecture-studies/contracts';
import { JobAggregate } from './aggregate.js';
import type { JobEvent } from './events.js';
import { JobProjection } from './projection.js';
import { InMemoryEventStore } from './store.js';
import { SqliteEventStore } from './sqlite-store.js';

function required(value: string, name: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a nonempty string.`);
}

export class EventDrivenWorkflow implements JobWorkflow {
  private readonly store: InMemoryEventStore | SqliteEventStore;
  private readonly projection = new JobProjection();
  private readonly autoProject: boolean;
  private projectionOffset = 0;

  constructor(options: { autoProject?: boolean; databasePath?: string } = {}) {
    this.autoProject = options.autoProject ?? true;
    this.store = options.databasePath ? new SqliteEventStore(options.databasePath) : new InMemoryEventStore();
    if (this.autoProject) this.projectPending();
  }
  close(): void { this.store.close(); }
  get pendingEventCount(): number { return this.store.all().length - this.projectionOffset; }

  submit(tenantId: string, key: string, documentName: string): JobView {
    required(tenantId, 'tenantId'); required(key, 'idempotencyKey'); required(documentName, 'documentName');
    const result = this.store.transaction(() => {
      const existingId = this.store.findSubmission(tenantId, key);
      if (existingId) {
        const existing = JobAggregate.load(this.store.read(tenantId, existingId)).view();
        if (existing.documentName !== documentName) throw new IdempotencyConflictError();
        return existing;
      }
      const id = randomUUID();
      this.store.append(tenantId, id, 0, { type: 'submitted', key, name: documentName });
      return JobAggregate.load(this.store.read(tenantId, id)).view();
    });
    return this.finish(result);
  }

  start(tenant: string, id: string): JobView { return this.change(tenant, id, { type: 'started' }); }
  complete(tenant: string, id: string, text: string): JobView {
    if (typeof text !== 'string') throw new TypeError('suppliedText must be a string.');
    return this.change(tenant, id, { type: 'completed', text });
  }
  fail(tenant: string, id: string, reason: string): JobView {
    required(reason, 'reason'); return this.change(tenant, id, { type: 'failed', reason });
  }
  retry(tenant: string, id: string): JobView { return this.change(tenant, id, { type: 'retried' }); }
  get(tenant: string, id: string): JobView {
    required(tenant, 'tenantId'); if (this.autoProject) this.projectPending();
    return this.projection.get(tenant, id);
  }
  list(tenant: string): readonly JobView[] {
    required(tenant, 'tenantId'); if (this.autoProject) this.projectPending();
    return this.projection.list(tenant);
  }

  // An explicit in-process event delivery boundary lets tests demonstrate lag.
  projectPending(): void {
    const events = this.store.all();
    while (this.projectionOffset < events.length) {
      const event = events[this.projectionOffset];
      if (!event) throw new Error('Missing journal event.');
      this.projection.apply(event);
      this.projectionOffset++;
    }
  }
  rebuildProjection(): void {
    this.projection.clear(); this.projectionOffset = 0; this.projectPending();
  }

  private change(tenant: string, id: string, event: Exclude<JobEvent, { type: 'submitted' }>): JobView {
    required(tenant, 'tenantId');
    const result = this.store.transaction(() => {
      const job = JobAggregate.load(this.store.read(tenant, id));
      const decided = job.decide(event);
      this.store.append(tenant, id, job.view().version, decided);
      return JobAggregate.load(this.store.read(tenant, id)).view();
    });
    return this.finish(result);
  }
  private finish(result: JobView): JobView {
    // Delivery happens after commit. If projection fails, replay recovers the
    // committed command; a failed append can never leak into the read model.
    if (this.autoProject) this.projectPending();
    return result;
  }
}
