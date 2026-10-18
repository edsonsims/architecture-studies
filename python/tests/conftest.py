"""Real HTTP server processes, with inherited sockets to avoid port-selection races."""

import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import pytest


class RunningWorker:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.process = None
        self.log = None

    def __enter__(self):
        listener = socket.socket()
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        self.url = f"http://127.0.0.1:{listener.getsockname()[1]}"
        self.log = tempfile.TemporaryFile(mode="w+t")
        environment = {**os.environ, "WORKER_DB_PATH": str(self.db_path)}
        try:
            self.process = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "architecture_worker.api:create_app",
                    "--factory",
                    "--fd",
                    str(listener.fileno()),
                    "--log-level",
                    "warning",
                    "--no-access-log",
                ],
                cwd=Path(__file__).resolve().parents[1],
                env=environment,
                pass_fds=(listener.fileno(),),
                stdout=self.log,
                stderr=self.log,
            )
        finally:
            listener.close()
        deadline = time.monotonic() + 10
        try:
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    break
                try:
                    if (
                        httpx.get(
                            f"{self.url}/healthz", timeout=0.2, trust_env=False
                        ).status_code
                        == 200
                    ):
                        return self
                except httpx.HTTPError:
                    pass
                time.sleep(0.02)
            self.log.seek(0)
            raise AssertionError(f"Worker did not become ready: {self.log.read()}")
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *args):
        if self.process is not None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if self.log is not None:
            self.log.close()


@pytest.fixture
def worker(tmp_path):
    with RunningWorker(tmp_path / "inspections.sqlite") as server:
        yield server


@pytest.fixture
def client(worker):
    with httpx.Client(base_url=worker.url, timeout=15, trust_env=False) as connection:
        yield connection


@pytest.fixture
def headers():
    return {"X-Tenant-Id": "tenant-a", "Idempotency-Key": "request-1"}
