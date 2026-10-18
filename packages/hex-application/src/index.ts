import { DocumentJob } from '@architecture-studies/hex-domain';

// Outbound ports belong to the application. Implementations live outside it.
export interface JobRepository {
  find(tenantId: string, id: string): DocumentJob | undefined;
  findByKey(tenantId: string, key: string): DocumentJob | undefined;
  list(tenantId: string): readonly DocumentJob[];
  save(job: DocumentJob): void;
}
export interface IdGenerator { next(): string; }
export class ApplicationJobMissingError extends Error {}
export class SubmissionConflictError extends Error {}

function required(value: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Expected a nonempty string.');
}

export class JobApplication {
  constructor(private readonly repository: JobRepository, private readonly ids: IdGenerator) {}

  submit(tenantId: string, key: string, name: string): DocumentJob {
    [tenantId, key, name].forEach(required);
    const existing = this.repository.findByKey(tenantId, key);
    if (existing) {
      if (existing.snapshot().documentName !== name) throw new SubmissionConflictError();
      return existing;
    }
    const job = DocumentJob.submit(this.ids.next(), tenantId, key, name);
    this.repository.save(job);
    return job;
  }
  get(tenantId: string, id: string): DocumentJob {
    required(tenantId);
    const job = this.repository.find(tenantId, id);
    if (!job) throw new ApplicationJobMissingError();
    return job;
  }
  list(tenantId: string): readonly DocumentJob[] { required(tenantId); return this.repository.list(tenantId); }
  start(tenant: string, id: string): DocumentJob { return this.change(tenant, id, job => job.start()); }
  complete(tenant: string, id: string, text: string): DocumentJob { return this.change(tenant, id, job => job.complete(text)); }
  fail(tenant: string, id: string, reason: string): DocumentJob { return this.change(tenant, id, job => job.fail(reason)); }
  retry(tenant: string, id: string): DocumentJob { return this.change(tenant, id, job => job.retry()); }

  private change(tenant: string, id: string, action: (job: DocumentJob) => void): DocumentJob {
    const job = this.get(tenant, id);
    action(job);
    this.repository.save(job);
    return job;
  }
}
