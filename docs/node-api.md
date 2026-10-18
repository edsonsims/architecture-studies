# Local Node job API

One Fastify HTTP adapter runs any of the three TypeScript workflows with its real SQLite persistence implementation. The existing in-memory demo remains separate.

## Start it

Use Node **24 LTS**; the supported package minimum is **22.16**. From the repository root:

```sh
npm ci
npm run build
ARCHITECTURE=hexagonal DB_PATH=./data/hexagonal.sqlite PORT=3000 npm start
```

`ARCHITECTURE` accepts `layered`, `hexagonal`, or `cqrs` and defaults to `hexagonal`. `DB_PATH` defaults to `data/<architecture>.sqlite`; its parent directory is created if needed. `PORT` defaults to 3000, and 0 asks the operating system to choose a free port. The server binds to `127.0.0.1`.

The built CLI prints one JSON line, for example `{"address":"http://127.0.0.1:3000","architecture":"hexagonal"}`. SIGINT/SIGTERM close the server and database connection. Preserve the database file to retain jobs across restarts. Each architecture has its own table names; changing architecture does not translate another variant's stored data.

## Requests and responses

All business routes require `X-Tenant-Id`. Submission additionally requires `Idempotency-Key`. Both headers must appear once, be nonblank, and contain at most 128 characters. They are trusted local inputs, **not authentication**. The HTTP service does not establish who owns a tenant.

POST requests require `Content-Type: application/json`. Schemas reject unknown body/query fields and type coercion. Nonblank validation checks for non-whitespace content without normalizing the submitted identity or name. Invalid Unicode strings are rejected rather than silently replaced.

| Method and path | JSON body | Success |
| --- | --- | --- |
| `GET /healthz` | None; tenant header not required | 200 `{"status":"ok","architecture":"hexagonal"}` |
| `POST /v1/jobs` | `{"documentName":"note.txt"}` | 201 job snapshot |
| `GET /v1/jobs` | None | 200 `{"jobs":[...]}` for the tenant |
| `GET /v1/jobs/:id` | None | 200 job snapshot |
| `POST /v1/jobs/:id/start` | `{}` | 200 job snapshot |
| `POST /v1/jobs/:id/complete` | `{"text":"supplied text"}` | 200 job snapshot |
| `POST /v1/jobs/:id/fail` | `{"reason":"worker unavailable"}` | 200 job snapshot |
| `POST /v1/jobs/:id/retry` | `{}` | 200 job snapshot |

```sh
curl http://127.0.0.1:3000/v1/jobs \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-Id: study-team' \
  -H 'Idempotency-Key: upload-001' \
  --data '{"documentName":"note.txt"}'
```

The snapshot contains `id`, `tenantId`, `documentName`, `state`, `attemptCount`, `text`, `failure`, and `version`. A new job is queued at version 1 with zero attempts. Start increments attempts; fail records a reason; retry clears that reason without starting an attempt; complete stores caller-supplied text. See the [transition table](architecture-comparison.md#the-behavioral-agreement).

A repeated tenant/key/name submission returns **201 and the same current job**, even after completion. Reusing that tenant/key with another name is a conflict. The identity is based on the name, not file bytes or a content hash. Another tenant's ID is indistinguishable from a missing job.

## Limits and errors

Document names must be nonblank and at most 255 characters. Failure reasons must be nonblank and at most 1024 characters. Text may be empty but must fit **65,536 UTF-8 bytes**. The complete JSON request body is limited to **256 KiB**. An oversized text/body is 413; an invalid field type, shape, or character limit is 400.

Errors have the form `{"error":{"code":"invalid_transition","message":"..."}}`.

| Status | Meaning |
| --- | --- |
| 400 | Malformed JSON, validation failure, duplicate identity headers, or invalid Unicode |
| 404 | Unknown route, missing job, or job belonging to another tenant |
| 409 | Invalid lifecycle transition or conflicting idempotency key |
| 413 | Request body or UTF-8 text byte limit exceeded |
| 415 | Unsupported/missing POST media type |
| 500 | Storage/internal error; database details are not returned |

SQL-trigger tests verify that a failed write leaves prior job state intact and returns a sanitized 500. CQRS has an additional delivery boundary: an error after the journal committed can leave the command persisted while the projection needs recovery. Inspect the job before blindly repeating a state-changing command; see [CQRS recovery](architecture-comparison.md#cqrs-writes-and-reads-can-disagree-temporarily).

## Persistence and tests

Layered mode stores rows in `layered_jobs`. Hexagonal mode implements the repository/transaction port using `hex_jobs`. CQRS stores its authoritative history in `cqrs_events` and tenant/key index in `cqrs_submissions`; projection state is reconstructed at startup and caught up before HTTP reads.

All three use prepared statements, explicit write transactions, WAL mode, and a five-second busy timeout. The [comparison guide](architecture-comparison.md#sqlite-boundaries-and-observed-concurrency) explains where their transaction boundaries differ. SQLite WAL is a local-host design; see [SQLite's WAL documentation](https://www.sqlite.org/wal.html).

`DatabaseSync` blocks the event loop during SQL and lock waiting. The module is experimental in Node 22 and a release candidate in the verified Node 24 version. These are study choices, not throughput claims. See [Node SQLite](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html), [SQLite transactions](https://www.sqlite.org/lang_transaction.html), and [Fastify schema validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/).

```sh
npm test                  # unit, boundary, model, real HTTP, rollback, and process tests
npm run test:integration   # Node HTTP/persistence integration suite only
```

The [integration tests](../tests/http-integration.test.mjs) use temporary files, real loopback servers, and separate Node processes. The [fast-check model](../tests/persistent-model.test.mjs) generates legal/illegal lifecycle and reopen sequences; its failures retain the seed and shrunk replay path. Remote CI, external load, host failure, and production operation are separate forms of evidence.
