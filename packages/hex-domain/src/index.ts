// No Node APIs, persistence, contract DTOs, framework, or adapter imports.
export type ProcessingState = 'queued' | 'processing' | 'completed' | 'failed';
export interface DomainJobSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly submissionKey: string;
  readonly documentName: string;
  readonly state: ProcessingState;
  readonly attemptCount: number;
  readonly text: string | null;
  readonly failure: string | null;
  readonly version: number;
}

export class DomainTransitionError extends Error {}
function required(value: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Expected a nonempty string.');
}

export class DocumentJob {
  private constructor(private data: DomainJobSnapshot) {}

  static submit(id: string, tenantId: string, submissionKey: string, documentName: string): DocumentJob {
    [id, tenantId, submissionKey, documentName].forEach(required);
    return new DocumentJob({ id, tenantId, submissionKey, documentName, state: 'queued',
      attemptCount: 0, text: null, failure: null, version: 1 });
  }

  // A storage adapter can restore a snapshot without exposing mutable state.
  static restore(snapshot: DomainJobSnapshot): DocumentJob { return new DocumentJob({ ...snapshot }); }
  snapshot(): DomainJobSnapshot { return Object.freeze({ ...this.data }); }

  start(): void {
    this.transition('queued', { state: 'processing', attemptCount: this.data.attemptCount + 1 });
  }
  complete(text: string): void {
    if (typeof text !== 'string') throw new TypeError('Text must be a string.');
    this.transition('processing', { state: 'completed', text });
  }
  fail(reason: string): void { required(reason); this.transition('processing', { state: 'failed', failure: reason }); }
  retry(): void { this.transition('failed', { state: 'queued', failure: null }); }

  private transition(expected: ProcessingState, changes: Partial<DomainJobSnapshot>): void {
    if (this.data.state !== expected)
      throw new DomainTransitionError(`Expected ${expected}, found ${this.data.state}.`);
    this.data = { ...this.data, ...changes, version: this.data.version + 1 };
  }
}
