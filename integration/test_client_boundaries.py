"""Client boundaries: real local HTTP and a CLI run against both study services."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('boundary_pipeline', ROOT / 'scripts/study_pipeline.py')
pipeline = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(pipeline)


@contextmanager
def local_http(handler):
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}'
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class ClientBoundaries(unittest.TestCase):
    def test_redirect_is_not_followed_and_does_not_forward_identity_headers(self):
        target_requests = []

        class Target(BaseHTTPRequestHandler):
            def do_GET(self):
                target_requests.append(dict(self.headers))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"unexpected":"redirect followed"}')

            def log_message(self, *args):
                pass

        with local_http(Target) as target_url:
            class Redirect(BaseHTTPRequestHandler):
                def do_GET(self):
                    self.send_response(302)
                    self.send_header('Location', target_url + '/destination')
                    self.end_headers()

                def log_message(self, *args):
                    pass

            with local_http(Redirect) as source_url:
                with self.assertRaises(pipeline.ApiError) as caught:
                    pipeline.Api(source_url, 'private-fixture-tenant').request(
                        'GET', '/redirect', key='private-fixture-key')
                self.assertEqual(caught.exception.status, 302)
                self.assertEqual(target_requests, [], 'No request or identity headers may reach the redirect target.')

    def test_proxy_environment_cannot_hijack_a_loopback_request(self):
        proxy_requests = []

        class Origin(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"source":"origin"}')

            def log_message(self, *args):
                pass

        class Proxy(BaseHTTPRequestHandler):
            def do_GET(self):
                proxy_requests.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"source":"proxy"}')

            def log_message(self, *args):
                pass

        with local_http(Origin) as origin_url, local_http(Proxy) as proxy_url:
            with patch.dict(os.environ, {'HTTP_PROXY': proxy_url, 'http_proxy': proxy_url,
                                         'NO_PROXY': '', 'no_proxy': ''}):
                result = pipeline.Api(origin_url, 'fixture-tenant').request('GET', '/origin')
            self.assertEqual(result, {'source': 'origin'})
            self.assertEqual(proxy_requests, [])

    def test_cli_preserves_crlf_before_the_real_worker_hashes_text(self):
        node = os.environ.get('ARCHITECTURE_NODE') or shutil.which('node')
        if node is None:
            self.fail('Node.js is required for the CLI and service integration check.')
        raw = 'Olá, Montréal!\r\nSecond line.\r\n'.encode('utf-8')
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            source = folder / 'crlf-note.txt'
            source.write_bytes(raw)
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                worker_port = reservation.getsockname()[1]
            worker_url = f'http://127.0.0.1:{worker_port}'
            node_log = (folder / 'node.log').open('w+')
            worker_log = (folder / 'worker.log').open('w+')
            processes = []
            try:
                processes.append(subprocess.Popen(
                    [node, 'packages/http-api/dist/cli.js'], cwd=ROOT,
                    env={**os.environ, 'ARCHITECTURE': 'hexagonal',
                         'DB_PATH': str(folder / 'jobs.sqlite'), 'PORT': '0'},
                    stdout=node_log, stderr=subprocess.STDOUT, text=True))
                processes.append(subprocess.Popen(
                    [sys.executable, '-m', 'architecture_worker'], cwd=ROOT / 'python',
                    env={**os.environ, 'WORKER_DB_PATH': str(folder / 'inspections.sqlite'),
                         'WORKER_PORT': str(worker_port)},
                    stdout=worker_log, stderr=subprocess.STDOUT, text=True))
                jobs_url = self.wait_for_service(processes[0], folder / 'node.log')
                self.wait_for_service(processes[1], folder / 'worker.log', worker_url)
                completed = subprocess.run(
                    [sys.executable, str(ROOT / 'scripts/study_pipeline.py'),
                     '--jobs-url', jobs_url, '--worker-url', worker_url,
                     '--tenant', 'crlf-fixture', '--key', 'crlf-note', '--file', str(source)],
                    cwd=ROOT, capture_output=True, text=True, timeout=15, check=False)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                result = json.loads(completed.stdout)
                receipt = result['inspection']
                self.assertEqual(receipt['sha256'], hashlib.sha256(raw).hexdigest())
                self.assertEqual(receipt['utf8Bytes'], len(raw))
                self.assertEqual(receipt['codePoints'], len(raw.decode('utf-8')))
                self.assertEqual(receipt['lines'], 2)
                self.assertEqual(result['job']['state'], 'completed')
                self.assertEqual(json.loads(result['job']['text']), receipt)
                self.assertEqual(source.read_bytes(), raw)
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
                node_log.close()
                worker_log.close()

    def wait_for_service(self, process, log_path, address=None):
        opener = build_opener(ProxyHandler({}))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if process.poll() is not None:
                self.fail('Service exited during startup:\n' + log_path.read_text())
            if address is None:
                for line in log_path.read_text().splitlines():
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(entry, dict) and 'address' in entry:
                        address = entry['address']
            if address:
                try:
                    with opener.open(address + '/healthz', timeout=0.5) as response:
                        if response.status == 200:
                            return address
                except (URLError, OSError):
                    pass
            time.sleep(0.04)
        self.fail('Service startup timed out:\n' + log_path.read_text())


if __name__ == '__main__':
    unittest.main(verbosity=2)
