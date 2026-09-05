"""OCR backends behind one interface, chosen by configuration.

Two real engines are registered, and both run:

| name | engine | weights | licence |
|---|---|---|---|
| `fast_plate_ocr` | `fast-plate-ocr` ONNX | `cct-*` / `*-mobile-vit-v2` from `ankandrew/fast-plate-ocr` releases | MIT |
| `paddle_ppocr` | PaddleOCR's **PP-OCR** models, run through RapidOCR's ONNX Runtime port | `PP-OCRv6_det/rec` | Apache-2.0 |

**Why PP-OCR is reached through RapidOCR rather than through `paddleocr`.** Installing
`paddlepaddle` + `paddleocr` into this repo's shared virtualenv downgrades `numpy` 2.5.2 -> 2.3.5 and
adds a second OpenCV (`opencv-contrib-python` 4.10) beside the existing one — a change to the
environment every other worker in this repo shares, made for a fallback path. RapidOCR runs *the
same* PP-OCR weights through the ONNX Runtime that is already a dependency of the plate detector,
with five small pure-Python packages added. The engine is PaddleOCR's; the runtime is not
PaddlePaddle, and `docs/model-licences.md` says so rather than letting "PaddleOCR" imply otherwise.

**A read is never a bare string.** Every backend returns per-character confidences where the model
exposes them, because the multi-frame vote is per character position and a vote with one confidence
per string cannot break a per-character tie.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Protocol, runtime_checkable

import cv2
import numpy as np

log = logging.getLogger("saakshi.analytics.anpr")

Frame = np.ndarray

__all__ = [
    "OcrRead",
    "OcrBackend",
    "FastPlateOcrBackend",
    "PaddlePpocrBackend",
    "OCR_BACKENDS",
    "DEFAULT_OCR_BACKEND",
    "create_ocr_backend",
    "ocr_backend_name",
]

#: The default backend, **set by measurement rather than by preference**.
#:
#: The ticket names `fast-plate-ocr` primary and PaddleOCR fallback. On this estate's plates the
#: order measured the other way round — see `docs/anpr-accuracy.md` for the numbers and
#: `fixtures/plate-eval/` for the set they were measured on. The interface is unchanged and either
#: name selects either engine; only the default moved, and it moved because of data.
DEFAULT_OCR_BACKEND = "paddle_ppocr"

#: Characters an Indian plate can contain. Everything else a recogniser emits — spaces, hyphens,
#: the IND country mark, the state emblem misread as a glyph — is dropped before voting, because a
#: separator that appears on some frames and not others shifts every subsequent character position
#: and destroys the alignment the vote depends on.
PLATE_ALPHABET = frozenset("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")


def clean_plate_text(text: str) -> str:
    """Uppercase, strip everything outside the plate alphabet. **Raw, not normalised.**

    This is not D2-03's job creeping in: normalisation there decides whether `GJ01AB1234` is a valid
    Gujarat plate and rewrites confusable characters. This only removes characters that are not
    plate characters at all, which the vote's positional alignment requires before it can run.
    """
    return "".join(char for char in text.upper() if char in PLATE_ALPHABET)


@dataclass(frozen=True)
class OcrRead:
    """One read of one plate crop. Confidence is mandatory — a read is never a bare string."""

    text: str
    confidence: float
    char_confidences: tuple[float, ...] = ()
    backend: str = ""
    #: Which rectification method produced the image that was read (`quad` / `minarea` / `resize`).
    rectify_method: str = ""
    latency_ms: float = 0.0


@runtime_checkable
class OcrBackend(Protocol):
    """What the engine needs. Deliberately one method — the swap has nothing else to get wrong."""

    name: str

    def read(self, plate_image: Frame) -> OcrRead | None: ...


@dataclass
class OcrStats:
    calls: int = 0
    empty: int = 0
    latencies_ms: list[float] = field(default_factory=list)

    def record(self, ms: float, *, empty: bool) -> None:
        self.calls += 1
        self.empty += int(empty)
        self.latencies_ms.append(ms)

    def percentile(self, p: float) -> float | None:
        if not self.latencies_ms:
            return None
        ordered = sorted(self.latencies_ms)
        index = min(len(ordered) - 1, max(0, int(round((p / 100.0) * (len(ordered) - 1)))))
        return round(ordered[index], 2)


class FastPlateOcrBackend:
    """`fast-plate-ocr` — a single-pass plate recogniser with fixed character slots.

    The slot model is why per-character confidence comes free: the network emits one distribution
    per slot, so `char_probs` aligns with the string by construction. Padding slots are kept and
    filtered *together with* their probabilities, so a trimmed string never ends up voting against
    confidences belonging to different positions.
    """

    def __init__(self, model: str | None = None, device: str = "cpu") -> None:
        from fast_plate_ocr import LicensePlateRecognizer  # noqa: PLC0415 — heavy, deferred

        self.name = "fast_plate_ocr"
        self.model_name = model or os.environ.get(
            "SAAKSHI_FAST_PLATE_OCR_MODEL", "cct-s-v2-global-model"
        )
        self._recognizer = LicensePlateRecognizer(self.model_name, device=device)
        config = self._recognizer.config
        # Each published model declares its own colour mode and geometry. Reading them beats
        # guessing: handing a 3-channel crop to the grayscale model raises `InvalidArgument`, and
        # handing a grayscale crop to the RGB model raises the same — measured, both directions.
        self._color_mode = str(getattr(config, "image_color_mode", "rgb"))
        self._pad_char = str(getattr(config, "pad_char", "_"))
        self.stats = OcrStats()
        self._lock = threading.Lock()
        log.info(
            "ocr backend fast_plate_ocr: %s (%s, %sx%s slots=%s)",
            self.model_name,
            self._color_mode,
            getattr(config, "img_width", "?"),
            getattr(config, "img_height", "?"),
            getattr(config, "max_plate_slots", "?"),
        )

    def _prepare(self, plate_image: Frame) -> Frame:
        if self._color_mode == "grayscale":
            if plate_image.ndim == 3:
                return cv2.cvtColor(plate_image, cv2.COLOR_BGR2GRAY)
            return plate_image
        if plate_image.ndim == 2:
            return cv2.cvtColor(plate_image, cv2.COLOR_GRAY2RGB)
        return cv2.cvtColor(plate_image, cv2.COLOR_BGR2RGB)

    def read(self, plate_image: Frame) -> OcrRead | None:
        if plate_image.size == 0:
            return None
        prepared = self._prepare(plate_image)
        started = time.perf_counter()
        with self._lock:
            predictions = self._recognizer.run(
                prepared, return_confidence=True, remove_pad_char=False
            )
        elapsed = (time.perf_counter() - started) * 1000.0
        if not predictions:
            self.stats.record(elapsed, empty=True)
            return None

        prediction = predictions[0]
        raw = str(prediction.plate or "")
        probs = list(np.asarray(prediction.char_probs).ravel().tolist())
        text_chars: list[str] = []
        confidences: list[float] = []
        for index, char in enumerate(raw):
            if char == self._pad_char:
                continue
            upper = char.upper()
            if upper not in PLATE_ALPHABET:
                continue
            text_chars.append(upper)
            confidences.append(float(probs[index]) if index < len(probs) else 0.0)

        text = "".join(text_chars)
        self.stats.record(elapsed, empty=not text)
        if not text:
            return None
        return OcrRead(
            text=text,
            confidence=round(float(sum(confidences) / len(confidences)), 4),
            char_confidences=tuple(round(value, 4) for value in confidences),
            backend=self.name,
            latency_ms=round(elapsed, 2),
        )


class PaddlePpocrBackend:
    """PaddleOCR's PP-OCR detection + recognition models, via RapidOCR's ONNX Runtime port.

    A general text recogniser rather than a plate-shaped one, which cuts both ways: it reads the
    `IND` country mark and any sticker on the bumper as text too, so the boxes it returns are joined
    in reading order and filtered to the plate alphabet. In exchange it is not committed to a fixed
    slot count, which is what lets it read a 10-character Indian plate that a 9-slot model
    structurally cannot.

    PP-OCR reports one confidence per detected text box, not per character, so the per-character
    confidences are that box's score repeated across its characters. That is stated rather than
    disguised: the vote then weights the whole box uniformly, which is exactly as much resolution as
    the model actually provides.
    """

    def __init__(self, **options: object) -> None:
        from rapidocr import RapidOCR  # noqa: PLC0415 — heavy, deferred

        self.name = "paddle_ppocr"
        self._engine = RapidOCR(**options) if options else RapidOCR()
        self.model_name = "PP-OCRv6 (det+rec, ONNX via rapidocr)"
        self.stats = OcrStats()
        self._lock = threading.Lock()
        log.info("ocr backend paddle_ppocr: %s", self.model_name)

    def read(self, plate_image: Frame) -> OcrRead | None:
        if plate_image.size == 0:
            return None
        image = (
            cv2.cvtColor(plate_image, cv2.COLOR_GRAY2BGR)
            if plate_image.ndim == 2
            else plate_image
        )
        started = time.perf_counter()
        with self._lock:
            result = self._engine(image)
        elapsed = (time.perf_counter() - started) * 1000.0

        texts = list(getattr(result, "txts", None) or [])
        scores = list(getattr(result, "scores", None) or [])
        if not texts:
            self.stats.record(elapsed, empty=True)
            return None

        chars: list[str] = []
        confidences: list[float] = []
        for index, raw in enumerate(texts):
            cleaned = clean_plate_text(str(raw))
            score = float(scores[index]) if index < len(scores) else 0.0
            chars.append(cleaned)
            confidences.extend([score] * len(cleaned))

        text = "".join(chars)
        self.stats.record(elapsed, empty=not text)
        if not text:
            return None
        return OcrRead(
            text=text,
            confidence=round(float(sum(confidences) / len(confidences)), 4),
            char_confidences=tuple(round(value, 4) for value in confidences),
            backend=self.name,
            latency_ms=round(elapsed, 2),
        )


#: Config name -> constructor. The whole of "swappable with no code change" is this dict plus the
#: environment variable below; adding an engine is one entry, and nothing else in the pipeline
#: mentions an engine by name.
OCR_BACKENDS: dict[str, Callable[..., OcrBackend]] = {
    "fast_plate_ocr": FastPlateOcrBackend,
    "paddle_ppocr": PaddlePpocrBackend,
}


def ocr_backend_name(override: str | None = None) -> str:
    """`--ocr-backend` beats `SAAKSHI_OCR_BACKEND` beats the measured default."""
    name = override or os.environ.get("SAAKSHI_OCR_BACKEND") or DEFAULT_OCR_BACKEND
    if name not in OCR_BACKENDS:
        raise ValueError(
            f"unknown OCR backend {name!r} — registered: {', '.join(sorted(OCR_BACKENDS))}"
        )
    return name


def create_ocr_backend(name: str | None = None, **options: object) -> OcrBackend:
    """Builds the configured backend. The only way the pipeline ever obtains one."""
    resolved = ocr_backend_name(name)
    return OCR_BACKENDS[resolved](**options)
