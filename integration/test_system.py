"""Black-box tests: two OS processes, TCP HTTP, separate SQLite files."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from contextlib import ExitStack
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('study_pipeline', ROOT / 'scripts/study_pipeline.py')
pipeline = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(pipeline)


class Process:
    def __init__(self, args: list[str], cwd: Path, env: dict, log: Path):
        self.log_path = log
        self.log = log.open('w+')
        self.process = subprocess.Popen(args, cwd=cwd, env=env, stdout=self.log,
                                        stderr=subprocess.STDOUT, text=True)

    def wait_for(self, address: str | None = None) -> str:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError('Service exited during startup:\n' + self.log_path.read_text())
            if address is None:
                for line in self.log_path.read_text().splitlines():
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(entry, dict) and 'address' in entry:
                        address = entry['address']
            if address:
                try:
                    with urlopen(address + '/healthz', timeout=0.5) as response:
                        if response.status == 200:
                            return address
                except (URLError, OSError):
                    pass
            time.sleep(0.04)
        raise RuntimeError('Service startup timed out:\n' + self.log_path.read_text())

    def close(self, abrupt: bool = False) -> None:
        if self.process.poll() is None:
            self.process.kill() if abrupt else self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.log.close()


class SystemIntegration(unittest.TestCase):
    def start_node(self, mode: str, folder: Path) -> tuple[Process, str]:
        node = os.environ.get('ARCHITECTURE_NODE') or shutil.which('node')
        if not node:
            self.fail('Node.js is required for the cross-service suite.')
        env = {**os.environ, 'ARCHITECTURE': mode, 'DB_PATH': str(folder / 'jobs.sqlite'), 'PORT': '0'}
        process = Process([node, 'packages/http-api/dist/cli.js'], ROOT, env,
                          folder / f'node-{time.monotonic_ns()}.log')
        self.resources.callback(process.close)
        return process, process.wait_for()

    def start_worker(self, folder: Path) -> tuple[Process, str]:
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        address = f'http://127.0.0.1:{port}'
        env = {**os.environ, 'WORKER_DB_PATH': str(folder / 'inspections.sqlite'),
               'WORKER_PORT': str(port)}
        process = Process([sys.executable, '-m', 'architecture_worker'], ROOT / 'python', env,
                          folder / f'worker-{time.monotonic_ns()}.log')
        self.resources.callback(process.close)
        return process, process.wait_for(address)

    def test_pipeline_and_abrupt_restart_for_every_architecture(self):
        text = 'Olá, Montréal!\nTwo services, one document.\n'
        for mode in ('layered', 'hexagonal', 'cqrs'):
            with self.subTest(architecture=mode), tempfile.TemporaryDirectory() as temporary, ExitStack() as resources:
                self.resources = resources
                folder = Path(temporary)
                node, jobs_url = self.start_node(mode, folder)
                worker, worker_url = self.start_worker(folder)
                result = pipeline.run_pipeline(jobs_url, worker_url, 'team-a', 'doc-1', 'note.txt', text)
                self.assertEqual(result['job']['state'], 'completed')
                self.assertEqual(result['job']['attemptCount'], 1)
                self.assertEqual(result['inspection']['sha256'], hashlib.sha256(text.encode()).hexdigest())
                self.assertEqual(result['inspection']['utf8Bytes'], len(text.encode()))
                self.assertEqual(result['inspection']['codePoints'], len(text))
                self.assertEqual(json.loads(result['job']['text']), result['inspection'])
                self.assertFalse(result['reused'])

                # Kill only after committed responses. This proves persistence
                # across abrupt process loss, not power-loss durability.
                node.close(abrupt=True)
                worker.close(abrupt=True)
                _, jobs_url = self.start_node(mode, folder)
                _, worker_url = self.start_worker(folder)
                replay = pipeline.run_pipeline(jobs_url, worker_url, 'team-a', 'doc-1', 'note.txt', text)
                self.assertTrue(replay['reused'])
                self.assertEqual(replay['job'], result['job'])
                self.assertEqual(replay['inspection'], result['inspection'])

                outsider = pipeline.Api(jobs_url, 'team-b')
                self.assertEqual(outsider.request('GET', '/v1/jobs'), {'jobs': []})
                with self.assertRaises(pipeline.ApiError) as hidden:
                    outsider.request('GET', '/v1/jobs/' + result['job']['id'])
                self.assertEqual(hidden.exception.status, 404)
                with self.assertRaises(pipeline.ApiError) as changed:
                    pipeline.run_pipeline(jobs_url, worker_url, 'team-a', 'doc-1', 'note.txt', text + 'changed')
                self.assertEqual(changed.exception.status, 409)
                self.assertEqual(pipeline.Api(jobs_url, 'team-a').request(
                    'GET', '/v1/jobs/' + result['job']['id']), result['job'])

    def test_worker_failure_is_recorded_and_explicit_rerun_recovers(self):
        for mode in ('layered', 'hexagonal', 'cqrs'):
            with self.subTest(architecture=mode), tempfile.TemporaryDirectory() as temporary, ExitStack() as resources:
                self.resources = resources
                folder = Path(temporary)
                _, jobs_url = self.start_node(mode, folder)
                worker, worker_url = self.start_worker(folder)
                worker.close()
                with self.assertRaises(pipeline.ApiError):
                    pipeline.run_pipeline(jobs_url, worker_url, 'team-a', 'retry-1', 'note.txt', 'retry me')
                jobs = pipeline.Api(jobs_url, 'team-a').request('GET', '/v1/jobs')['jobs']
                self.assertEqual(len(jobs), 1)
                self.assertEqual(jobs[0]['state'], 'failed')
                self.assertEqual(jobs[0]['attemptCount'], 1)
                self.assertEqual(jobs[0]['failure'], 'Inspection service unavailable.')
                _, worker_url = self.start_worker(folder)
                recovered = pipeline.run_pipeline(jobs_url, worker_url, 'team-a', 'retry-1', 'note.txt', 'retry me')
                self.assertEqual(recovered['job']['id'], jobs[0]['id'])
                self.assertEqual(recovered['job']['state'], 'completed')
                self.assertEqual(recovered['job']['attemptCount'], 2)
                self.assertEqual(recovered['job']['version'], 6)

    def test_client_rejects_oversized_input_before_submitting_work(self):
        with self.assertRaises(ValueError):
            pipeline.run_pipeline('http://127.0.0.1:1', 'http://127.0.0.1:2',
                                  'team', 'key', 'note.txt', 'é' * 32769)


if __name__ == '__main__':
    unittest.main(verbosity=2)
