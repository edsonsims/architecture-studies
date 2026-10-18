import { DatabaseSync } from 'node:sqlite';
import type { JobRow } from './model.js';

// This concrete database remains an explicit dependency of the layered service.
export class SqliteJobData {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS layered_jobs (
        tenant_id TEXT NOT NULL, id TEXT NOT NULL, submission_key TEXT NOT NULL,
        version INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,submission_key)
      ) STRICT;`);
  }
  byId(tenant: string, id: string): JobRow | undefined {
    return this.decode(this.db.prepare('SELECT payload FROM layered_jobs WHERE tenant_id=? AND id=?').get(tenant, id));
  }
  byKey(tenant: string, key: string): JobRow | undefined {
    return this.decode(this.db.prepare('SELECT payload FROM layered_jobs WHERE tenant_id=? AND submission_key=?').get(tenant, key));
  }
  forTenant(tenant: string): JobRow[] {
    return this.db.prepare('SELECT payload FROM layered_jobs WHERE tenant_id=? ORDER BY rowid').all(tenant)
      .map(row => this.decode(row)!);
  }
  insert(row: JobRow): void {
    this.db.prepare('INSERT INTO layered_jobs VALUES (?,?,?,?,?)')
      .run(row.tenantId, row.id, row.submissionKey, row.version, JSON.stringify(row));
  }
  update(row: JobRow): void {
    const result = this.db.prepare('UPDATE layered_jobs SET version=?,payload=? WHERE tenant_id=? AND id=? AND version=?')
      .run(row.version, JSON.stringify(row), row.tenantId, row.id, row.version - 1);
    if (result.changes !== 1) throw new Error('Stored job version changed.');
  }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* A trigger may already have rolled back. */ }
      throw error;
    }
  }
  close(): void { this.db.close(); }
  private decode(row: Record<string, unknown> | undefined): JobRow | undefined {
    return row ? JSON.parse(String(row.payload)) as JobRow : undefined;
  }
}
