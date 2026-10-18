"""SQLite adapter: one transaction claims each tenant's idempotency key."""

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from .domain import (
    IdempotencyConflict,
    Inspection,
    InspectionNotFound,
    StorageError,
    TextMetrics,
)


class SQLiteInspectionRepository:
    def __init__(self, path: str | Path):
        self.path = Path(path)

    @contextmanager
    def _connection(self):
        connection = None
        try:
            connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
            connection.row_factory = sqlite3.Row
            yield connection
        except sqlite3.Error as error:
            raise StorageError("Inspection storage is unavailable.") from error
        finally:
            if connection is not None:
                connection.close()

    def initialize(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise StorageError("Inspection storage is unavailable.") from error
        with self._connection() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise StorageError("Unsupported inspection storage version.")
            connection.execute("""
                CREATE TABLE IF NOT EXISTS inspections (
                    id TEXT PRIMARY KEY,
                    tenant_id TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL,
                    sha256 TEXT NOT NULL,
                    utf8_bytes INTEGER NOT NULL CHECK (utf8_bytes >= 0),
                    code_points INTEGER NOT NULL CHECK (code_points >= 0),
                    words INTEGER NOT NULL CHECK (words >= 0),
                    lines INTEGER NOT NULL CHECK (lines >= 0),
                    UNIQUE (tenant_id, idempotency_key)
                )
            """)
            connection.execute("PRAGMA user_version=1")

    def check_ready(self) -> None:
        with self._connection() as connection:
            connection.execute("SELECT id FROM inspections LIMIT 1").fetchall()

    def create_or_get(
        self, tenant_id: str, key: str, metrics: TextMetrics
    ) -> tuple[Inspection, bool]:
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                existing = connection.execute(
                    "SELECT * FROM inspections WHERE tenant_id=? AND idempotency_key=?",
                    (tenant_id, key),
                ).fetchone()
                if existing is not None:
                    if existing["sha256"] != metrics.sha256:
                        raise IdempotencyConflict(
                            "This key already identifies different text."
                        )
                    inspection = self._inspection(existing)
                    connection.commit()
                    return inspection, False
                inspection = Inspection(str(uuid4()), tenant_id, metrics)
                connection.execute(
                    "INSERT INTO inspections VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        inspection.id,
                        tenant_id,
                        key,
                        metrics.sha256,
                        metrics.utf8_bytes,
                        metrics.code_points,
                        metrics.words,
                        metrics.lines,
                    ),
                )
                connection.commit()
                return inspection, True
            except BaseException:
                connection.rollback()
                raise

    def get(self, tenant_id: str, inspection_id: str) -> Inspection:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM inspections WHERE tenant_id=? AND id=?",
                (tenant_id, inspection_id),
            ).fetchone()
        if row is None:
            raise InspectionNotFound("Inspection was not found.")
        return self._inspection(row)

    @staticmethod
    def _inspection(row: sqlite3.Row) -> Inspection:
        return Inspection(
            row["id"],
            row["tenant_id"],
            TextMetrics(
                row["sha256"],
                row["utf8_bytes"],
                row["code_points"],
                row["words"],
                row["lines"],
            ),
        )
