"""Framework-free text inspection and error definitions."""

from dataclasses import dataclass
from hashlib import sha256

MAX_TEXT_BYTES = 65_536
MAX_IDENTIFIER_CHARACTERS = 128


class InvalidInput(ValueError):
    pass


class TextTooLarge(InvalidInput):
    pass


class IdempotencyConflict(Exception):
    pass


class InspectionNotFound(Exception):
    pass


class StorageError(Exception):
    pass


@dataclass(frozen=True)
class TextMetrics:
    sha256: str
    utf8_bytes: int
    code_points: int
    words: int
    lines: int


@dataclass(frozen=True)
class Inspection:
    id: str
    tenant_id: str
    metrics: TextMetrics


def validate_identifier(value: str, label: str) -> None:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > MAX_IDENTIFIER_CHARACTERS
    ):
        raise InvalidInput(
            f"{label} must be a nonblank string of at most 128 characters."
        )


def inspect_text(text: str) -> TextMetrics:
    """Inspect exact text, without Unicode or newline normalization."""
    if not isinstance(text, str):
        raise InvalidInput("text must be a string.")
    try:
        encoded = text.encode("utf-8")
    except UnicodeEncodeError as error:
        raise InvalidInput("text must contain valid Unicode scalar values.") from error
    if len(encoded) > MAX_TEXT_BYTES:
        raise TextTooLarge("text must not exceed 65536 UTF-8 bytes.")
    return TextMetrics(
        sha256=sha256(encoded).hexdigest(),
        utf8_bytes=len(encoded),
        code_points=len(text),
        words=len(text.split()),
        lines=len(text.splitlines()),
    )
