"""Use cases depend on a repository port and the pure inspector."""

from typing import Protocol

from .domain import Inspection, TextMetrics, inspect_text, validate_identifier


class InspectionRepository(Protocol):
    def initialize(self) -> None: ...
    def check_ready(self) -> None: ...
    def create_or_get(
        self, tenant_id: str, key: str, metrics: TextMetrics
    ) -> tuple[Inspection, bool]: ...
    def get(self, tenant_id: str, inspection_id: str) -> Inspection: ...


class InspectionService:
    def __init__(self, repository: InspectionRepository):
        self.repository = repository

    def inspect(self, tenant_id: str, key: str, text: str) -> tuple[Inspection, bool]:
        validate_identifier(tenant_id, "X-Tenant-Id")
        validate_identifier(key, "Idempotency-Key")
        return self.repository.create_or_get(tenant_id, key, inspect_text(text))

    def get(self, tenant_id: str, inspection_id: str) -> Inspection:
        validate_identifier(tenant_id, "X-Tenant-Id")
        return self.repository.get(tenant_id, inspection_id)
