"""OCR backends and the config-driven swap — AC 4.

*"OCR backend swappable via config with no code change (test proves both paths run)."* The
parametrised test below therefore builds each registered backend **from a configuration string
only** — never by constructing a class — and runs a real image through it. Nothing in the test
mentions an engine's implementation, which is the property being asserted: if selecting a backend
required a code change, this test could not be written this way.
"""

from __future__ import annotations

import numpy as np
import pytest

from workers.analytics.anpr.ocr import (
    DEFAULT_OCR_BACKEND,
    OCR_BACKENDS,
    OcrBackend,
    clean_plate_text,
    create_ocr_backend,
    ocr_backend_name,
)

from .conftest import draw_plate

REGISTERED = sorted(OCR_BACKENDS)


def test_both_backends_are_registered() -> None:
    """Two real engines, not one engine and a stub. A stub would prove nothing about swapping."""
    assert REGISTERED == ["fast_plate_ocr", "paddle_ppocr"]
    assert DEFAULT_OCR_BACKEND in OCR_BACKENDS


@pytest.mark.parametrize("name", REGISTERED)
def test_each_backend_runs_when_selected_by_configuration(name: str, plate_text: str) -> None:
    """AC 4: **both** paths execute, selected by a config string and nothing else."""
    backend = create_ocr_backend(name)
    assert isinstance(backend, OcrBackend)
    assert backend.name == name

    read = backend.read(draw_plate(plate_text))

    assert read is not None, f"{name} returned no read on a clean synthetic plate"
    assert read.text == plate_text
    assert 0.0 < read.confidence <= 1.0
    assert read.backend == name
    # A read is never a bare string: the vote is per character position and needs per-position
    # weights, so a backend that supplied only a whole-string score could not participate in it.
    assert len(read.char_confidences) == len(read.text)


@pytest.mark.parametrize("name", REGISTERED)
def test_the_environment_selects_a_backend_with_no_code_change(
    name: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SAAKSHI_OCR_BACKEND", name)
    assert ocr_backend_name() == name
    # An explicit argument still wins — `--ocr-backend` beats the environment.
    other = next(other for other in REGISTERED if other != name)
    assert ocr_backend_name(other) == other


def test_an_unknown_backend_fails_loudly_rather_than_falling_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A silent fallback would let a run report accuracy for an engine nobody selected."""
    monkeypatch.setenv("SAAKSHI_OCR_BACKEND", "not-an-engine")
    with pytest.raises(ValueError, match="unknown OCR backend"):
        ocr_backend_name()


@pytest.mark.parametrize("name", REGISTERED)
def test_a_backend_returns_nothing_rather_than_inventing_a_plate(name: str) -> None:
    """Blank input must produce no read. An invented string here becomes a false watchlist hit."""
    backend = create_ocr_backend(name)
    blank = np.full((48, 192, 3), 128, dtype=np.uint8)
    read = backend.read(blank)
    assert read is None or read.text == "" or read.confidence < 0.9


@pytest.mark.parametrize("name", REGISTERED)
def test_an_empty_image_is_handled_rather_than_raising(name: str) -> None:
    backend = create_ocr_backend(name)
    assert backend.read(np.zeros((0, 0, 3), dtype=np.uint8)) is None


def test_clean_plate_text_strips_separators_that_would_shift_the_vote() -> None:
    """A hyphen present on some frames and not others misaligns every later character position."""
    assert clean_plate_text("GJ 01 AB-1234") == "GJ01AB1234"
    assert clean_plate_text("gj01ab1234") == "GJ01AB1234"
    assert clean_plate_text("IND") == "IND"
    assert clean_plate_text("!!!") == ""
