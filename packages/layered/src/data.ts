import type { JobRow } from './model.js';

// Concrete data layer. Replacing storage means changing this dependency.
export class InMemoryJobData {
  private readonly rows = new Map<string, JobRow>();
  byId(tenant: string, id: string): JobRow | undefined {
    return this.rows.get(JSON.stringify([tenant, id]));
  }
  byKey(tenant: string, key: string): JobRow | undefined {
    return [...this.rows.values()].find(row => row.tenantId === tenant && row.submissionKey === key);
  }
  forTenant(tenant: string): JobRow[] {
    return [...this.rows.values()].filter(row => row.tenantId === tenant);
  }
  insert(row: JobRow): void { this.rows.set(JSON.stringify([row.tenantId, row.id]), row); }
}
