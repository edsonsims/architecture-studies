import { DatabaseSync } from 'node:sqlite';
import type { JobEvent, StoredEvent } from './events.js';

// The journal is authoritative. Projections can be recovered from committed events.
export class SqliteEventStore {
  private readonly db: DatabaseSync;
  private inTransaction = false;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS cqrs_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL, job_id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL,
        UNIQUE (tenant_id,job_id,version)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS cqrs_submissions (
        tenant_id TEXT NOT NULL, submission_key TEXT NOT NULL, job_id TEXT NOT NULL,
        PRIMARY KEY (tenant_id,submission_key)
      ) STRICT;`);
  }
  all(): readonly StoredEvent[] {
    return this.db.prepare('SELECT * FROM cqrs_events ORDER BY sequence').all().map(row => this.decode(row));
  }
  read(tenant: string, id: string): readonly StoredEvent[] {
    return this.db.prepare('SELECT * FROM cqrs_events WHERE tenant_id=? AND job_id=? ORDER BY version')
      .all(tenant, id).map(row => this.decode(row));
  }
  findSubmission(tenant: string, key: string): string | undefined {
    const row = this.db.prepare('SELECT job_id FROM cqrs_submissions WHERE tenant_id=? AND submission_key=?').get(tenant, key);
    return row ? String(row.job_id) : undefined;
  }
  append(tenant: string, id: string, expectedVersion: number, payload: JobEvent): void {
    this.transaction(() => {
      const current = this.db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM cqrs_events WHERE tenant_id=? AND job_id=?')
        .get(tenant, id);
      if (Number(current?.version) !== expectedVersion) throw new Error('The event stream version has changed.');
      this.db.prepare('INSERT INTO cqrs_events(tenant_id,job_id,version,payload) VALUES(?,?,?,?)')
        .run(tenant, id, expectedVersion + 1, JSON.stringify(payload));
      if (payload.type === 'submitted') {
        this.db.prepare('INSERT INTO cqrs_submissions VALUES(?,?,?)').run(tenant, payload.key, id);
      }
    });
  }
  transaction<T>(operation: () => T): T {
    if (this.inTransaction) return operation();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* A trigger may already have rolled back. */ }
      throw error;
    }
    finally { this.inTransaction = false; }
  }
  close(): void { this.db.close(); }
  private decode(row: Record<string, unknown>): StoredEvent {
    return Object.freeze({ tenantId: String(row.tenant_id), jobId: String(row.job_id), version: Number(row.version),
      payload: Object.freeze(JSON.parse(String(row.payload)) as JobEvent) });
  }
}
