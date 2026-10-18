"""Run the local document-inspection workflow over two real HTTP APIs."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


class ApiError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class Api:
    def __init__(self, base_url: str, tenant: str, timeout: float = 5):
        parsed = urlsplit(base_url)
        if (parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in {'', '/'}):
            raise ValueError('Use a loopback HTTP base URL without credentials or a path.')
        self.base_url = base_url.rstrip('/')
        self.tenant = tenant
        self.timeout = timeout

    def request(self, method: str, path: str, body: dict | None = None,
                key: str | None = None) -> dict:
        headers = {'X-Tenant-Id': self.tenant, 'Accept': 'application/json'}
        data = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body, ensure_ascii=True).encode('utf-8')
        if key is not None:
            headers['Idempotency-Key'] = key
        request = Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with build_opener(ProxyHandler({}), NoRedirects).open(request, timeout=self.timeout) as response:
                raw = response.read(262145)
                if len(raw) > 262144:
                    raise ApiError('The service returned an oversized response.')
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise ApiError('The service returned an invalid response.')
                return result
        except HTTPError as error:
            status = error.code
            error.close()
            raise ApiError(f'{method} {path} failed (HTTP {status}).', status) from error
        except (URLError, TimeoutError, OSError) as error:
            raise ApiError(f'{method} {path}: service unavailable.') from error
        except (ValueError, UnicodeError) as error:
            raise ApiError('The service returned invalid JSON.') from error


def run_pipeline(jobs_url: str, worker_url: str, tenant: str, key: str,
                 document_name: str, text: str) -> dict:
    """A resumable client, not a background queue or distributed transaction.

    Each service owns a different SQLite database. The inspection key makes
    resending a successful inspection safe after the client loses its response.
    The job's existing text result stores a JSON inspection receipt.
    """
    if len(text.encode('utf-8')) > 65536:
        raise ValueError('Text must fit within 65536 UTF-8 bytes.')
    jobs, worker = Api(jobs_url, tenant), Api(worker_url, tenant)
    job = jobs.request('POST', '/v1/jobs', {'documentName': document_name}, key)
    path = '/v1/jobs/' + quote(job['id'], safe='')
    already_completed = job['state'] == 'completed'
    if job['state'] == 'failed':
        job = jobs.request('POST', path + '/retry', {})
    if job['state'] == 'queued':
        job = jobs.request('POST', path + '/start', {})

    try:
        receipt = worker.request('POST', '/v1/inspections', {'text': text}, key)
        counts = ('utf8Bytes', 'codePoints', 'words', 'lines')
        if (receipt.get('tenantId') != tenant or not isinstance(receipt.get('id'), str)
                or receipt.get('sha256') != hashlib.sha256(text.encode('utf-8')).hexdigest()
                or any(type(receipt.get(name)) is not int or receipt[name] < 0 for name in counts)):
            raise ApiError('The inspection service returned an invalid receipt.')
    except ApiError as error:
        if not already_completed:
            # Never expose a remote response body, database path or document text
            # in the job failure. If this call is uncertain, a rerun can resume.
            reason = ('Inspection service unavailable.' if error.status is None
                      else f'Inspection failed (HTTP {error.status}).')
            try:
                jobs.request('POST', path + '/fail', {'reason': reason})
            except ApiError:
                pass
        raise

    result_text = json.dumps(receipt, sort_keys=True, separators=(',', ':'))
    if already_completed:
        try:
            same_result = json.loads(job['text']) == receipt
        except (ValueError, TypeError):
            same_result = False
        if not same_result:
            raise ApiError('The completed job contains a different result.', 409)
    else:
        try:
            job = jobs.request('POST', path + '/complete', {'text': result_text})
        except ApiError:
            # A lost response can follow a committed completion. Read before
            # declaring a failure or trying to overwrite the result.
            current = jobs.request('GET', path)
            if current['state'] != 'completed' or current['text'] != result_text:
                raise
            job = current
    return {'job': job, 'inspection': receipt, 'reused': already_completed}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jobs-url', default='http://127.0.0.1:3000')
    parser.add_argument('--worker-url', default='http://127.0.0.1:8000')
    parser.add_argument('--tenant', default='demo-team')
    parser.add_argument('--key', default='sample-note-v1')
    parser.add_argument('--file', type=Path, default=Path('examples/sample-note.txt'))
    args = parser.parse_args()
    try:
        text = args.file.read_bytes().decode('utf-8')
        result = run_pipeline(args.jobs_url, args.worker_url, args.tenant, args.key,
                              args.file.name, text)
    except (ApiError, ValueError, OSError) as error:
        parser.exit(1, f'{error}\n')
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
