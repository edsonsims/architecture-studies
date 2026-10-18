# Python text inspection API

A FastAPI/Uvicorn service that actually inspects submitted text and stores its
receipt in SQLite. It calculates a SHA-256 digest and text statistics; it does not
perform OCR, call a language model, or open a caller-supplied file path.

## Install and run

Python **3.11 or later** is required. The following commands run from the repository
root using Python 3.12:

```sh
python3.12 -m venv python/.venv
python/.venv/bin/python -m pip install -r python/requirements-dev.lock
cd python
.venv/bin/python -m pytest
WORKER_DB_PATH=.local/inspections.sqlite WORKER_PORT=8000 \
  .venv/bin/python -m architecture_worker
```

`requirements.lock` pins the runtime and transitive dependencies;
`requirements-dev.lock` includes it plus the exact test dependencies. Runtime
dependencies were resolved from official PyPI: [FastAPI 0.143.3](https://pypi.org/project/fastapi/0.143.3/)
and [Uvicorn 0.54.0](https://pypi.org/project/uvicorn/0.54.0/).

The server binds to `127.0.0.1`. `WORKER_PORT` defaults to `8000` and
`WORKER_DB_PATH` defaults to `.local/inspections.sqlite`, relative to the working
directory. The containing directory and schema are initialized during FastAPI's
lifespan startup. A storage failure prevents successful startup. Stop with Ctrl-C.

## HTTP contract

```sh
curl -i http://127.0.0.1:8000/v1/inspections \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-Id: team-a' \
  -H 'Idempotency-Key: request-1' \
  --data '{"text":"one two\nthree"}'
```

`POST /v1/inspections` accepts **only** an object with a string `text` field.
No type coercion or unknown fields are allowed. Empty text is valid; the limit is
**65,536 UTF-8 bytes** after JSON decoding. Both headers are required, nonblank,
at most 128 characters, and may appear only once.

The first request returns **201** and a receipt:

```json
{
  "id": "a generated UUID",
  "tenantId": "team-a",
  "sha256": "the lowercase SHA-256 digest of the exact UTF-8 text",
  "utf8Bytes": 13,
  "codePoints": 13,
  "words": 3,
  "lines": 2
}
```

The illustrative strings above are placeholders; real responses contain a UUID
and a 64-character hexadecimal digest. Repeating a tenant/key with the same text
returns **200**, preserving the original receipt and ID. Changed text with the
same tenant/key returns **409**. Different tenants can use the same key.

`GET /v1/inspections/{id}` requires `X-Tenant-Id`. It returns **200** with the
stored receipt or **404** for an unknown ID or another tenant's receipt.
`GET /healthz` checks the database table and returns `{"status":"ok"}`.
Generated API documentation is available at `/docs` and `/openapi.json`.

Errors use `{"error":{"code":"...","message":"..."}}`:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Invalid JSON, body shape/type, Unicode, or required header |
| 409 | `idempotency_conflict` | Existing tenant/key identifies different text |
| 413 | `text_too_large` | Text exceeds the UTF-8 byte limit |
| 404 | `not_found` | Receipt is not visible to this tenant or route does not exist |
| 500 | `storage_error` | Database operation failed; SQL details are not returned |
| 500 | `internal_error` | Unexpected failure; implementation details are not returned |

## What the counts mean

- `sha256`: digest of `text.encode("utf-8")` without normalization.
- `utf8Bytes`: length of those bytes.
- `codePoints`: Python `len(text)`, which is not a count of visible graphemes.
- `words`: number of whitespace-separated tokens from `text.split()`, not a
  linguistic tokenizer.
- `lines`: Python `len(text.splitlines())`; empty text has zero lines, CRLF is one
  line break, and a trailing terminator does not add a final empty line.

Canonically equivalent Unicode strings and different newline encodings remain
different inputs. Invalid Unicode scalar sequences are rejected before storage.

## Boundaries and persistence

`domain.py` contains a pure inspector and immutable result types.
`application.py` validates identities and coordinates the repository port.
`repository.py` implements that port with real SQLite connections.
`api.py` translates HTTP requests, strict Pydantic models, responses, and errors.

SQLite has a unique `(tenant_id, idempotency_key)` constraint. `BEGIN IMMEDIATE`
serializes the read/claim/insert transaction across connections and processes.
Write failures roll back; a failed write does not reserve the key. WAL mode and
committed rows preserve receipts across a service restart. The database stores
the text digest and counts, **not raw text**. SHA-256 is the input fingerprint;
this is not a proof of data provenance or authenticity.

Tenant IDs come from the caller. This API provides scoped storage lookups, not
authentication. The service performs synchronous work in-process and has no task
broker or distributed-delivery claim.

## Verification

The integration tests launch real Uvicorn subprocesses, send TCP HTTP requests,
and inspect temporary SQLite databases. They cover Unicode/counts, strict input
validation, byte/header limits, cross-tenant lookups, key conflicts, process
restart, concurrent claims, two worker processes sharing one database, and an
actual SQLite trigger failure followed by a successful retry.

The test launcher uses POSIX inherited sockets to reserve ports without a
selection race. Local verification used **Python 3.12.14, SQLite 3.53.1, macOS
arm64**. Windows and other interpreter versions were not tested in this local run.
Automated testing is separate from an owner walkthrough or production use.
