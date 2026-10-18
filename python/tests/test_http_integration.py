"""These tests use Uvicorn subprocesses, TCP HTTP, and real temporary SQLite files."""

import hashlib
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from conftest import RunningWorker


@pytest.mark.parametrize(
    "text,expected",
    [
        ("", (0, 0, 0, 0)),
        ("one\t two\nthree\n", (15, 15, 3, 2)),
        ("café\r\n第二行\n", (17, 10, 2, 2)),
        ("\r\n", (2, 2, 0, 1)),
        ("a\u2028b", (5, 3, 2, 2)),
        ("👩‍💻", (11, 3, 1, 1)),
    ],
)
def test_actual_text_metrics_and_tenant_scoped_retrieval(
    client, headers, text, expected
):
    response = client.post("/v1/inspections", headers=headers, json={"text": text})
    assert response.status_code == 201
    result = response.json()
    assert set(result) == {
        "id",
        "tenantId",
        "sha256",
        "utf8Bytes",
        "codePoints",
        "words",
        "lines",
    }
    assert result["tenantId"] == "tenant-a"
    assert result["sha256"] == hashlib.sha256(text.encode("utf-8")).hexdigest()
    assert (
        tuple(result[key] for key in ("utf8Bytes", "codePoints", "words", "lines"))
        == expected
    )
    assert (
        client.get(
            f"/v1/inspections/{result['id']}", headers={"X-Tenant-Id": "tenant-a"}
        ).json()
        == result
    )
    denied = client.get(
        f"/v1/inspections/{result['id']}", headers={"X-Tenant-Id": "tenant-b"}
    )
    missing = client.get(
        "/v1/inspections/nonexistent", headers={"X-Tenant-Id": "tenant-b"}
    )
    assert denied.status_code == missing.status_code == 404
    assert denied.json() == missing.json()


def test_idempotency_preserves_exact_unicode_and_newline_input(client, headers):
    first = client.post("/v1/inspections", headers=headers, json={"text": "é\r\n"})
    replay = client.post("/v1/inspections", headers=headers, json={"text": "é\r\n"})
    assert first.status_code == 201 and replay.status_code == 200
    assert replay.json() == first.json()
    for changed in ("e\u0301\r\n", "é\n", "é\r\n "):
        conflict = client.post(
            "/v1/inspections", headers=headers, json={"text": changed}
        )
        assert conflict.status_code == 409
        assert conflict.json()["error"]["code"] == "idempotency_conflict"
    separate = client.post(
        "/v1/inspections",
        headers={**headers, "X-Tenant-Id": "other"},
        json={"text": "different"},
    )
    assert separate.status_code == 201
    assert separate.json()["id"] != first.json()["id"]


def test_tenant_and_key_delimiters_cannot_collide(client):
    first = client.post(
        "/v1/inspections",
        headers={"X-Tenant-Id": "a:b", "Idempotency-Key": "c"},
        json={"text": "one"},
    )
    second = client.post(
        "/v1/inspections",
        headers={"X-Tenant-Id": "a", "Idempotency-Key": "b:c"},
        json={"text": "two"},
    )
    assert first.status_code == second.status_code == 201
    assert first.json()["id"] != second.json()["id"]


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {},
        {"text": None},
        {"text": 1},
        {"text": True},
        {"text": []},
        {"text": "ok", "unexpected": 1},
    ],
)
def test_unknown_fields_and_coercion_are_rejected(client, headers, payload):
    response = client.post("/v1/inspections", headers=headers, json=payload)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


@pytest.mark.parametrize(
    "body",
    [
        b"{",
        b'"not an object"',
        b'{"text":"\xff"}',
        b'{"text":"\\ud800"}',
        b'{"text":NaN}',
    ],
)
def test_bad_json_or_unicode_is_a_sanitized_client_error(client, headers, body):
    response = client.post(
        "/v1/inspections",
        headers={**headers, "Content-Type": "application/json"},
        content=body,
    )
    assert response.status_code == 400
    assert set(response.json()) == {"error"}


@pytest.mark.parametrize(
    "changed_headers",
    [
        {},
        {"X-Tenant-Id": "a"},
        {"Idempotency-Key": "one"},
        {"X-Tenant-Id": "", "Idempotency-Key": "one"},
        {"X-Tenant-Id": "a", "Idempotency-Key": ""},
        {"X-Tenant-Id": "a" * 129, "Idempotency-Key": "one"},
        {"X-Tenant-Id": "a", "Idempotency-Key": "k" * 129},
    ],
)
def test_required_header_validation(client, changed_headers):
    response = client.post(
        "/v1/inspections", headers=changed_headers, json={"text": "ok"}
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


def test_duplicate_headers_are_rejected(client):
    response = client.post(
        "/v1/inspections",
        headers=[
            ("X-Tenant-Id", "a"),
            ("X-Tenant-Id", "b"),
            ("Idempotency-Key", "one"),
        ],
        json={"text": "ok"},
    )
    assert response.status_code == 400


def test_exact_byte_and_header_limits(client):
    headers = {"X-Tenant-Id": "a" * 128, "Idempotency-Key": "k" * 128}
    accepted = client.post(
        "/v1/inspections", headers=headers, json={"text": "é" * 32768}
    )
    assert accepted.status_code == 201
    assert accepted.json()["utf8Bytes"] == 65536
    response = client.post(
        "/v1/inspections",
        headers={**headers, "Idempotency-Key": "larger"},
        json={"text": "é" * 32769},
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "text_too_large"


def test_restart_preserves_receipts_and_idempotency_without_storing_raw_text(tmp_path):
    database = tmp_path / "durable.sqlite"
    headers = {"X-Tenant-Id": "tenant", "Idempotency-Key": "one"}
    text = "unique raw contents must not be persisted"
    with RunningWorker(database) as server:
        created = httpx.post(
            f"{server.url}/v1/inspections",
            headers=headers,
            json={"text": text},
            trust_env=False,
        )
        assert created.status_code == 201
        receipt = created.json()
    with sqlite3.connect(database) as connection:
        columns = {
            row[1] for row in connection.execute("PRAGMA table_info(inspections)")
        }
        assert "text" not in columns and "input_text" not in columns
        assert connection.execute("SELECT COUNT(*) FROM inspections").fetchone()[0] == 1
    with RunningWorker(database) as restarted:
        fetched = httpx.get(
            f"{restarted.url}/v1/inspections/{receipt['id']}",
            headers=headers,
            trust_env=False,
        )
        assert fetched.status_code == 200 and fetched.json() == receipt
        replay = httpx.post(
            f"{restarted.url}/v1/inspections",
            headers=headers,
            json={"text": text},
            trust_env=False,
        )
        assert replay.status_code == 200 and replay.json() == receipt


def test_concurrent_identical_claims_store_one_receipt(client, worker, headers):
    with ThreadPoolExecutor(max_workers=12) as pool:
        responses = list(
            pool.map(
                lambda _: client.post(
                    "/v1/inspections", headers=headers, json={"text": "shared"}
                ),
                range(24),
            )
        )
    assert [row.status_code for row in responses].count(201) == 1
    assert [row.status_code for row in responses].count(200) == 23
    assert len({row.json()["id"] for row in responses}) == 1
    with sqlite3.connect(worker.db_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM inspections").fetchone()[0] == 1


def test_two_processes_resolve_conflicting_claims_without_duplicate_rows(tmp_path):
    database = tmp_path / "shared.sqlite"
    headers = {"X-Tenant-Id": "tenant", "Idempotency-Key": "same-key"}
    with (
        RunningWorker(database) as first,
        RunningWorker(database) as second,
        httpx.Client(timeout=15, trust_env=False) as client,
    ):
        inputs = [
            (first.url if index % 2 else second.url, "one" if index % 3 else "two")
            for index in range(24)
        ]
        with ThreadPoolExecutor(max_workers=12) as pool:
            responses = list(
                pool.map(
                    lambda item: client.post(
                        f"{item[0]}/v1/inspections",
                        headers=headers,
                        json={"text": item[1]},
                    ),
                    inputs,
                )
            )
        assert [row.status_code for row in responses].count(201) == 1
        winner = next(row.json() for row in responses if row.status_code == 201)
        for (_, text), response in zip(inputs, responses):
            if hashlib.sha256(text.encode()).hexdigest() == winner["sha256"]:
                assert response.status_code in (200, 201)
                assert response.json() == winner
            else:
                assert response.status_code == 409
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM inspections").fetchone()[0] == 1


def test_failed_write_is_sanitized_rolls_back_and_does_not_reserve_the_key(
    client, worker, headers
):
    with sqlite3.connect(worker.db_path) as connection:
        connection.execute(
            "CREATE TRIGGER fail_insert BEFORE INSERT ON inspections BEGIN SELECT RAISE(ABORT, 'private database detail'); END"
        )
    response = client.post(
        "/v1/inspections", headers=headers, json={"text": "retry later"}
    )
    assert response.status_code == 500
    assert response.json() == {
        "error": {
            "code": "storage_error",
            "message": "Inspection storage is unavailable.",
        }
    }
    assert "private database detail" not in response.text
    with sqlite3.connect(worker.db_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM inspections").fetchone()[0] == 0
        connection.execute("DROP TRIGGER fail_insert")
    assert (
        client.post(
            "/v1/inspections", headers=headers, json={"text": "retry later"}
        ).status_code
        == 201
    )
