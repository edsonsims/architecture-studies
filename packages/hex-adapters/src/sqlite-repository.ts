import { DatabaseSync } from 'node:sqlite';
import { DocumentJob, type DomainJobSnapshot } from '@architecture-studies/hex-domain';
import type { JobRepository } from '@architecture-studies/hex-application';

export class SqliteJobRepository implements JobRepository {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS hex_jobs (
        tenant_id TEXT NOT NULL, id TEXT NOT NULL, submission_key TEXT NOT NULL,
        version INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,submission_key)
      ) STRICT;`);
  }
  find(tenantId: string, id: string): DocumentJob | undefined {
    return this.decode(this.db.prepare('SELECT payload FROM hex_jobs WHERE tenant_id=? AND id=?').get(tenantId, id));
  }
  findByKey(tenantId: string, key: string): DocumentJob | undefined {
    return this.decode(this.db.prepare('SELECT payload FROM hex_jobs WHERE tenant_id=? AND submission_key=?').get(tenantId, key));
  }
  list(tenantId: string): readonly DocumentJob[] {
    return this.db.prepare('SELECT payload FROM hex_jobs WHERE tenant_id=? ORDER BY rowid').all(tenantId)
      .map(row => this.decode(row)!);
  }
  save(job: DocumentJob): void {
    const row = job.snapshot();
    if (row.version === 1) {
      this.db.prepare('INSERT INTO hex_jobs VALUES (?,?,?,?,?)')
        .run(row.tenantId, row.id, row.submissionKey, row.version, JSON.stringify(row));
    } else {
      const result = this.db.prepare('UPDATE hex_jobs SET version=?,payload=? WHERE tenant_id=? AND id=? AND version=?')
        .run(row.version, JSON.stringify(row), row.tenantId, row.id, row.version - 1);
      if (result.changes !== 1) throw new Error('Stored job version changed.');
    }
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
  private decode(row: Record<string, unknown> | undefined): DocumentJob | undefined {
    return row ? DocumentJob.restore(JSON.parse(String(row.payload)) as DomainJobSnapshot) : undefined;
  }
}
