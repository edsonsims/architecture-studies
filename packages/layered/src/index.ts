import { randomUUID } from 'node:crypto';
import {
  IdempotencyConflictError, InvalidTransitionError, JobNotFoundError,
  type JobState, type JobView, type JobWorkflow,
} from '@architecture-studies/contracts';
import { InMemoryJobData } from './data.js';
import { view, type JobRow } from './model.js';
import { SqliteJobData } from './sqlite-data.js';

function required(value: string, name: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a nonempty string.`);
}

export class LayeredWorkflow implements JobWorkflow {
  private readonly data: InMemoryJobData | SqliteJobData;
  constructor(options: { databasePath?: string } = {}) {
    this.data = options.databasePath ? new SqliteJobData(options.databasePath) : new InMemoryJobData();
  }
  close(): void { this.data.close(); }

  submit(tenantId: string, idempotencyKey: string, documentName: string): JobView {
    required(tenantId, 'tenantId'); required(idempotencyKey, 'idempotencyKey'); required(documentName, 'documentName');
    return this.data.transaction(() => {
      const existing = this.data.byKey(tenantId, idempotencyKey);
      if (existing) {
        if (existing.documentName !== documentName) throw new IdempotencyConflictError();
        return view(existing);
      }
      const row: JobRow = {
        id: randomUUID(), tenantId, submissionKey: idempotencyKey, documentName,
        state: 'queued', attemptCount: 0, text: null, failure: null, version: 1,
      };
      this.data.insert(row);
      return view(row);
    });
  }

  start(tenantId: string, id: string): JobView {
    return this.change(tenantId, id, 'queued', row => {
      row.state = 'processing'; row.attemptCount++;
    });
  }

  complete(tenantId: string, id: string, suppliedText: string): JobView {
    if (typeof suppliedText !== 'string') throw new TypeError('suppliedText must be a string.');
    return this.change(tenantId, id, 'processing', row => { row.state = 'completed'; row.text = suppliedText; });
  }

  fail(tenantId: string, id: string, reason: string): JobView {
    required(reason, 'reason');
    return this.change(tenantId, id, 'processing', row => { row.state = 'failed'; row.failure = reason; });
  }

  retry(tenantId: string, id: string): JobView {
    return this.change(tenantId, id, 'failed', row => { row.state = 'queued'; row.failure = null; });
  }

  get(tenantId: string, id: string): JobView { return view(this.find(tenantId, id)); }
  list(tenantId: string): readonly JobView[] {
    required(tenantId, 'tenantId');
    return this.data.forTenant(tenantId).map(view);
  }

  private find(tenantId: string, id: string): JobRow {
    required(tenantId, 'tenantId');
    const row = this.data.byId(tenantId, id);
    if (!row) throw new JobNotFoundError();
    return row;
  }
  private expect(tenant: string, id: string, state: JobState): JobRow {
    const row = this.find(tenant, id);
    if (row.state !== state) throw new InvalidTransitionError(`Expected ${state}, found ${row.state}.`);
    return row;
  }
  private change(tenant: string, id: string, expected: JobState, action: (row: JobRow) => void): JobView {
    return this.data.transaction(() => {
      const row = this.expect(tenant, id, expected);
      action(row); row.version++;
      this.data.update(row);
      return view(row);
    });
  }
}
