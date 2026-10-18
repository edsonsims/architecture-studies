"""FastAPI adapter; application/domain modules do not depend on the web framework."""

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, Header, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from starlette.exceptions import HTTPException

from .application import InspectionRepository, InspectionService
from .domain import (
    IdempotencyConflict,
    Inspection,
    InspectionNotFound,
    InvalidInput,
    StorageError,
    TextTooLarge,
)
from .repository import SQLiteInspectionRepository


class InspectionInput(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    text: str


class InspectionOutput(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    id: str
    tenantId: str
    sha256: str
    utf8Bytes: int
    codePoints: int
    words: int
    lines: int


def error_response(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status, content={"error": {"code": code, "message": message}}
    )


def receipt(inspection: Inspection) -> dict:
    metrics = inspection.metrics
    return {
        "id": inspection.id,
        "tenantId": inspection.tenant_id,
        "sha256": metrics.sha256,
        "utf8Bytes": metrics.utf8_bytes,
        "codePoints": metrics.code_points,
        "words": metrics.words,
        "lines": metrics.lines,
    }


def create_app(
    db_path: str | Path | None = None, *, repository: InspectionRepository | None = None
) -> FastAPI:
    repository = (
        repository
        if repository is not None
        else SQLiteInspectionRepository(
            db_path
            if db_path is not None
            else os.environ.get("WORKER_DB_PATH", ".local/inspections.sqlite")
        )
    )
    service = InspectionService(repository)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        repository.initialize()
        yield

    app = FastAPI(
        title="Architecture Studies text inspector", version="0.1.0", lifespan=lifespan
    )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError):
        return error_response(
            400,
            "invalid_request",
            "Expected a JSON object containing only a string text field and required headers.",
        )

    @app.exception_handler(InvalidInput)
    async def invalid_input(request: Request, error: InvalidInput):
        if isinstance(error, TextTooLarge):
            return error_response(413, "text_too_large", str(error))
        return error_response(400, "invalid_request", str(error))

    @app.exception_handler(IdempotencyConflict)
    async def conflict(request: Request, error: IdempotencyConflict):
        return error_response(
            409, "idempotency_conflict", "This key already identifies different text."
        )

    @app.exception_handler(InspectionNotFound)
    async def missing(request: Request, error: InspectionNotFound):
        return error_response(404, "not_found", "Inspection was not found.")

    @app.exception_handler(StorageError)
    async def storage_error(request: Request, error: StorageError):
        return error_response(
            500, "storage_error", "Inspection storage is unavailable."
        )

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, error: HTTPException):
        return error_response(
            error.status_code,
            "not_found" if error.status_code == 404 else "http_error",
            (
                "Resource not found."
                if error.status_code == 404
                else "Request could not be handled."
            ),
        )

    @app.exception_handler(Exception)
    async def internal_error(request: Request, error: Exception):
        return error_response(500, "internal_error", "Request could not be completed.")

    def unique_header(request: Request, name: str, value: str) -> str:
        if len(request.headers.getlist(name)) != 1:
            raise InvalidInput(f"Exactly one {name} header is required.")
        return value

    @app.get("/healthz")
    def health():
        repository.check_ready()
        return {"status": "ok"}

    @app.post("/v1/inspections", status_code=201, response_model=InspectionOutput)
    def inspect(
        body: InspectionInput,
        request: Request,
        response: Response,
        tenant: Annotated[str, Header(alias="X-Tenant-Id")],
        key: Annotated[str, Header(alias="Idempotency-Key")],
    ):
        tenant = unique_header(request, "X-Tenant-Id", tenant)
        key = unique_header(request, "Idempotency-Key", key)
        inspection, created = service.inspect(tenant, key, body.text)
        response.status_code = 201 if created else 200
        return receipt(inspection)

    @app.get("/v1/inspections/{inspection_id}", response_model=InspectionOutput)
    def get_inspection(
        inspection_id: str,
        request: Request,
        tenant: Annotated[str, Header(alias="X-Tenant-Id")],
    ):
        tenant = unique_header(request, "X-Tenant-Id", tenant)
        return receipt(service.get(tenant, inspection_id))

    return app
