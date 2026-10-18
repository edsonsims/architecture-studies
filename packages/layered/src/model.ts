import type { JobState, JobView } from '@architecture-studies/contracts';

// An anemic data model: transition decisions live in the application service.
export interface JobRow {
  id: string;
  tenantId: string;
  submissionKey: string;
  documentName: string;
  state: JobState;
  attemptCount: number;
  text: string | null;
  failure: string | null;
  version: number;
}

export function view(row: JobRow): JobView {
  const { submissionKey: _, ...snapshot } = row;
  return Object.freeze(snapshot);
}
