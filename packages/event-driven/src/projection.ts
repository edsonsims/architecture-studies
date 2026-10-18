import { JobNotFoundError, type JobView } from '@architecture-studies/contracts';
import type { StoredEvent } from './events.js';

// Queries read this separate model, never the event stream or write aggregate.
export class JobProjection {
  private readonly rows = new Map<string, JobView>();
  clear(): void { this.rows.clear(); }

  apply(event: StoredEvent): void {
    const key = JSON.stringify([event.tenantId, event.jobId]);
    const old = this.rows.get(key);
    if (old && event.version <= old.version) return; // Safe redelivery to this projector.
    if (event.version !== (old?.version ?? 0) + 1) throw new Error('Projection events must arrive in stream order.');
    const payload = event.payload;
    let row: JobView;
    if (payload.type === 'submitted') {
      row = { id: event.jobId, tenantId: event.tenantId, documentName: payload.name,
        state: 'queued', attemptCount: 0, text: null, failure: null, version: event.version };
    } else {
      if (!old) throw new Error('Projection needs a submission before later events.');
      switch (payload.type) {
        case 'started': row = { ...old, state: 'processing', attemptCount: old.attemptCount + 1 }; break;
        case 'completed': row = { ...old, state: 'completed', text: payload.text }; break;
        case 'failed': row = { ...old, state: 'failed', failure: payload.reason }; break;
        case 'retried': row = { ...old, state: 'queued', failure: null }; break;
      }
      row = { ...row, version: event.version };
    }
    this.rows.set(key, Object.freeze(row));
  }

  get(tenantId: string, id: string): JobView {
    const row = this.rows.get(JSON.stringify([tenantId, id]));
    if (!row) throw new JobNotFoundError();
    return row;
  }
  list(tenantId: string): readonly JobView[] { return [...this.rows.values()].filter(row => row.tenantId === tenantId); }
}
