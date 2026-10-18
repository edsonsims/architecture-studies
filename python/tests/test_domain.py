import pytest

from architecture_worker.domain import InvalidInput, TextTooLarge, inspect_text


def test_inspection_is_pure_and_does_not_normalize_unicode():
    before = "café\r\n"
    assert inspect_text(before) == inspect_text(before)
    assert before == "café\r\n"
    assert inspect_text(before).sha256 != inspect_text("cafe\u0301\r\n").sha256
    assert inspect_text(before).sha256 != inspect_text("café\n").sha256


def test_invalid_text_and_utf8_limit_are_domain_rules():
    for value in (None, 1, b"bytes", "\ud800"):
        with pytest.raises(InvalidInput):
            inspect_text(value)
    assert inspect_text("a" * 65536).utf8_bytes == 65536
    with pytest.raises(TextTooLarge):
        inspect_text("a" * 65537)
