import { randomUUID } from 'node:crypto';
import {
  IdempotencyConflictError, InvalidTransitionError, JobNotFoundError, type JobView, type JobWorkflow,
} from '@architecture-studies/contracts';
import { DocumentJob, DomainTransitionError, type DomainJobSnapshot } from '@architecture-studies/hex-domain';
import {
  ApplicationJobMissingError, JobApplication, SubmissionConflictError, type IdGenerator, type JobRepository,
} from '@architecture-studies/hex-application';

// Store snapshots, not live aggregate references: changes take effect at save().
export class InMemoryJobRepository implements JobRepository {
  private readonly snapshots = new Map<string, DomainJobSnapshot>();
  find(tenant: string, id: string): DocumentJob | undefined {
    const snapshot = this.snapshots.get(JSON.stringify([tenant, id]));
    return snapshot ? DocumentJob.restore(snapshot) : undefined;
  }
  findByKey(tenant: string, key: string): DocumentJob | undefined {
    const snapshot = [...this.snapshots.values()].find(job => job.tenantId === tenant && job.submissionKey === key);
    return snapshot ? DocumentJob.restore(snapshot) : undefined;
  }
  list(tenant: string): readonly DocumentJob[] {
    return [...this.snapshots.values()].filter(job => job.tenantId === tenant).map(DocumentJob.restore);
  }
  save(job: DocumentJob): void {
    const snapshot = job.snapshot();
    this.snapshots.set(JSON.stringify([snapshot.tenantId, snapshot.id]), snapshot);
  }
  transaction<T>(operation: () => T): T { return operation(); }
}

export { SqliteJobRepository } from './sqlite-repository.js';

export class HexagonalWorkflow implements JobWorkflow {
  private readonly application: JobApplication;
  constructor(repository: JobRepository = new InMemoryJobRepository(), ids: IdGenerator = { next: randomUUID }) {
    this.application = new JobApplication(repository, ids);
  }
  submit(tenant: string, key: string, name: string): JobView { return this.execute(() => this.application.submit(tenant, key, name)); }
  start(tenant: string, id: string): JobView { return this.execute(() => this.application.start(tenant, id)); }
  complete(tenant: string, id: string, text: string): JobView { return this.execute(() => this.application.complete(tenant, id, text)); }
  fail(tenant: string, id: string, reason: string): JobView { return this.execute(() => this.application.fail(tenant, id, reason)); }
  retry(tenant: string, id: string): JobView { return this.execute(() => this.application.retry(tenant, id)); }
  get(tenant: string, id: string): JobView { return this.execute(() => this.application.get(tenant, id)); }
  list(tenant: string): readonly JobView[] { return this.application.list(tenant).map(view); }

  private execute(useCase: () => DocumentJob): JobView {
    try { return view(useCase()); }
    catch (error) {
      if (error instanceof ApplicationJobMissingError) throw new JobNotFoundError();
      if (error instanceof SubmissionConflictError) throw new IdempotencyConflictError();
      if (error instanceof DomainTransitionError) throw new InvalidTransitionError(error.message);
      throw error;
    }
  }
}

function view(job: DocumentJob): JobView {
  const { submissionKey: _, ...snapshot } = job.snapshot();
  return Object.freeze(snapshot);
}
