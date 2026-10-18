export type JobState = 'queued' | 'processing' | 'completed' | 'failed';

export interface JobView {
  readonly id: string;
  readonly tenantId: string;
  readonly documentName: string;
  readonly state: JobState;
  readonly attemptCount: number;
  readonly text: string | null;
  readonly failure: string | null;
  readonly version: number;
}

// Only the observable API is shared. Each study implements its own rules.
export interface JobWorkflow {
  submit(tenantId: string, idempotencyKey: string, documentName: string): JobView;
  start(tenantId: string, id: string): JobView;
  complete(tenantId: string, id: string, suppliedText: string): JobView;
  fail(tenantId: string, id: string, reason: string): JobView;
  retry(tenantId: string, id: string): JobView;
  get(tenantId: string, id: string): JobView;
  list(tenantId: string): readonly JobView[];
}

export class JobNotFoundError extends Error {
  constructor() { super('Job was not found.'); this.name = 'JobNotFoundError'; }
}
export class InvalidTransitionError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidTransitionError'; }
}
export class IdempotencyConflictError extends Error {
  constructor() {
    super("This tenant's submission key already identifies a different document.");
    this.name = 'IdempotencyConflictError';
  }
}
