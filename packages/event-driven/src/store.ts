import type { JobEvent, StoredEvent } from './events.js';

// One process, one ordered journal. This is not a broker or durable event store.
export class InMemoryEventStore {
  private readonly journal: StoredEvent[] = [];
  private readonly streams = new Map<string, StoredEvent[]>();
  private readonly submissions = new Map<string, string>();

  all(): readonly StoredEvent[] { return [...this.journal]; }
  read(tenantId: string, id: string): readonly StoredEvent[] {
    return [...(this.streams.get(JSON.stringify([tenantId, id])) ?? [])];
  }
  findSubmission(tenantId: string, key: string): string | undefined {
    return this.submissions.get(JSON.stringify([tenantId, key]));
  }
  append(tenantId: string, id: string, expectedVersion: number, payload: JobEvent): void {
    const streamKey = JSON.stringify([tenantId, id]);
    const stream = this.streams.get(streamKey) ?? [];
    if (stream.length !== expectedVersion) throw new Error('The event stream version has changed.');
    const event = Object.freeze({ tenantId, jobId: id, version: expectedVersion + 1, payload: Object.freeze(payload) });
    stream.push(event);
    this.streams.set(streamKey, stream);
    this.journal.push(event);
    if (payload.type === 'submitted') this.submissions.set(JSON.stringify([tenantId, payload.key]), id);
  }
}
