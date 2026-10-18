import { InvalidTransitionError, JobNotFoundError, type JobState, type JobView } from '@architecture-studies/contracts';
import type { JobEvent, StoredEvent } from './events.js';

// The write side reconstructs state before deciding whether a command is legal.
export class JobAggregate {
  private constructor(private state: JobView) {}

  static load(events: readonly StoredEvent[]): JobAggregate {
    const first = events[0];
    if (!first || first.payload.type !== 'submitted') throw new JobNotFoundError();
    const job = new JobAggregate({
      id: first.jobId, tenantId: first.tenantId, documentName: first.payload.name,
      state: 'queued', attemptCount: 0, text: null, failure: null, version: first.version,
    });
    for (const event of events.slice(1)) job.apply(event);
    return job;
  }

  view(): JobView { return Object.freeze({ ...this.state }); }

  decide(event: Exclude<JobEvent, { type: 'submitted' }>): JobEvent {
    const expected: JobState = event.type === 'started' ? 'queued' : event.type === 'retried' ? 'failed' : 'processing';
    if (this.state.state !== expected)
      throw new InvalidTransitionError(`Expected ${expected}, found ${this.state.state}.`);
    return event;
  }

  private apply(event: StoredEvent): void {
    const data = event.payload;
    switch (data.type) {
      case 'started': this.state = { ...this.state, state: 'processing', attemptCount: this.state.attemptCount + 1 }; break;
      case 'completed': this.state = { ...this.state, state: 'completed', text: data.text }; break;
      case 'failed': this.state = { ...this.state, state: 'failed', failure: data.reason }; break;
      case 'retried': this.state = { ...this.state, state: 'queued', failure: null }; break;
      case 'submitted': throw new Error('A job cannot be submitted twice.');
    }
    this.state = { ...this.state, version: event.version };
  }
}
