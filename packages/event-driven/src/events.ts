export type JobEvent =
  | { readonly type: 'submitted'; readonly key: string; readonly name: string }
  | { readonly type: 'started' }
  | { readonly type: 'completed'; readonly text: string }
  | { readonly type: 'failed'; readonly reason: string }
  | { readonly type: 'retried' };

export interface StoredEvent {
  readonly tenantId: string;
  readonly jobId: string;
  readonly version: number;
  readonly payload: JobEvent;
}
