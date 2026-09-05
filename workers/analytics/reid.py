"""Vehicle appearance re-identification: the embedding, the similarity, and the gate.

**This is not face recognition.** SAAKSHI processes no biometrics — deliberately, and for legal
reasons (`CLAUDE.md`, claims discipline). What this module describes is the *outside of a vehicle*:
the colour of its panels under a white-balance correction, and the coarse arrangement of its edges.
It cannot identify a person, it never looks at one, and the descriptor it produces is discarded the
moment its sighting's retention clock expires. `docs/reid.md` §2 states the distinction in the terms
a reviewer will ask about.

## What it is for

On this estate most plates are unreadable — 120 hand-labelled vehicle instances in
`fixtures/plate-eval` yielded **3** legible plates. A trace built from plate reads alone therefore
has holes. Re-ID bridges a hole: from one sighting whose plate *was* read (the **anchor**), attach a
nearby sighting whose plate was not, when the two vehicles look the same *and* one could physically
have become the other.

## The order of operations is the safety property

    candidate -> SPATIO-TEMPORAL GATE -> appearance comparison -> link

never the reverse. Appearance alone will link every white hatchback in Gujarat; the gate is what
makes the claim about *this* vehicle rather than *this kind of* vehicle. `packages/api/src/services/
reid.ts` enforces the order structurally — a gated-out candidate's embedding is never even fetched —
and `passes_spatiotemporal_gate` here is the same predicate for the offline evaluation.

The travel-time model is **D3-01's**, not a second one invented here:
`packages/api/src/services/route.ts::timingPlausibility`, re-expressed in Python in
`timing_plausibility` below and asserted equal to it by `test_reid.py`.

## The embedder is pluggable, and the default is honest about what it is

`ColourConstantEmbedder` is a classical descriptor: no weights, no download, no licence question,
deterministic to the bit. It is **not** a vehicle-re-ID-trained network, and it does not pretend to
be one — `docs/reid.md` §4 carries the measured cost of that. `OnnxEmbedder` is the seam for a
permissively-licensed re-ID checkpoint when one is chosen (`SAAKSHI_REID_WEIGHTS`); the licence
decision belongs in `docs/model-licences.md`, not in this file.

## Colour constancy, and why it is the whole problem

The estate spans six distinct resolutions and a measured luma range of 8.40 to 135.19 (D1-05). The
same white car is a different colour on two cameras. Every embedder here therefore runs
shades-of-grey white balance (Finlayson & Trezzi 2004, Minkowski p=6) *before* it looks at colour.
That mitigates the shift; it does not remove it, and `docs/reid.md` §6 reports what is left.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from typing import Protocol

import cv2
import numpy as np

__all__ = [
    "EMBEDDER_ID",
    "EMBEDDING_DIM",
    "GATE_ELAPSED_MIN_S",
    "REID_DEFAULTS",
    "AppearanceEmbedder",
    "ColourConstantEmbedder",
    "OnnxEmbedder",
    "YoloBackboneEmbedder",
    "ReidThresholds",
    "cosine",
    "create_embedder",
    "embedder_name",
    "gate_reason",
    "passes_spatiotemporal_gate",
    "shades_of_grey",
    "timing_plausibility",
]

# ── the descriptor's shape ──────────────────────────────────────────────────────────────────────
#
# Fixed before any measurement was taken and not moved afterwards. Tuning a descriptor against the
# set you then report precision on is how a 0.9 gets manufactured; the ticket says precision is
# prioritised over recall, not that precision is a target to be reached.

#: Re-ID's conventional crop aspect: taller than wide, so a vehicle's roof/body/wheels fall in
#: different stripes regardless of how big the original box was.
CROP_SIZE = (64, 128)  # (width, height)

#: Horizontal stripes. Coarse enough to survive a 40 px crop, fine enough that a white roof over a
#: dark bumper does not average into grey.
STRIPES = 4

HUE_BINS = 16
SAT_BINS = 8
VAL_BINS = 8

#: Shape cells: 4 rows x 2 columns of orientation histograms.
SHAPE_ROWS = 4
SHAPE_COLS = 2
SHAPE_BINS = 9

#: Shape carries half the weight of colour. Colour is the more camera-stable signal once white
#: balance is corrected; edge orientation moves with viewing angle, which changes between cameras by
#: construction. A design decision, stated before measurement.
SHAPE_WEIGHT = 0.5

#: Minkowski norm order for shades-of-grey. p=6 is Finlayson & Trezzi's reported optimum; p=1 is
#: grey-world and p=inf is white-patch, both of which are worse on scenes with a large sky region.
SOG_ORDER = 6.0

EMBEDDING_DIM = STRIPES * (HUE_BINS + SAT_BINS + VAL_BINS) + SHAPE_ROWS * SHAPE_COLS * SHAPE_BINS

#: Written alongside every stored embedding. Two vectors may only be compared when their embedder
#: ids match — a descriptor change is a new id, never a silent reinterpretation of old rows.
EMBEDDER_ID = "sog-hsv-shape-v1"


@dataclass(frozen=True)
class ReidThresholds:
    """Every re-ID threshold with the reason it has that value.

    `similarity_min` is deliberately **not** a default anybody should trust blind: it is set by
    `python -m workers.analytics.eval_reid` on the labelled set and recorded in `docs/reid.md`
    together with the precision it bought. The value here is that calibration's output.
    """

    #: Cosine similarity floor for a link, fitted on the whole labelled set by `eval_reid`.
    #: **It bought a held-out precision of 0.761, not 0.9** — which is why `REID_ENABLED` defaults to
    #: false. The value is the calibration's output and was not nudged upward afterwards to make the
    #: number look better; moving it would trade the measured recall away for a precision this set
    #: cannot demonstrate. `docs/reid.md` §5.
    similarity_min: float = 0.933

    #: `timing_plausibility` floor. 0.25 admits roughly 0.6x to 5.5x of OSRM free-flow time — a
    #: vehicle that hit every light, and a vehicle that stopped for tea. Below it the elapsed time
    #: is not evidence of anything.
    gate_timing_min: float = 0.25

    #: A camera cannot be routed to itself, so same-camera bridging is governed by a dwell window
    #: instead. 300 s is stated as a dwell rule, NOT as a travel time — the two are different
    #: claims and `docs/reid.md` §3 keeps them apart.
    same_camera_max_gap_s: float = 300.0

    #: Hard ceiling on the elapsed time between an anchor and a candidate, whatever the route says.
    #: Beyond an hour the appearance evidence is doing all the work and the gate none of it.
    max_elapsed_s: float = 3600.0

    #: Minimum best-shot score a candidate crop must carry to be embedded at all. D2-08 found the
    #: shipped "plate" crops include Gujarati shop signage; a low-scoring crop is a crop of
    #: something, and matching two of them to each other is exactly the failure to avoid.
    min_best_shot_score: float = 0.25


REID_DEFAULTS = ReidThresholds()

#: Two sightings closer together than this are the same instant for gating purposes; dividing by an
#: elapsed time of zero is not a plausibility, it is a domain error.
GATE_ELAPSED_MIN_S = 0.5

# Mirrors `packages/api/src/services/route.ts`. Asymmetric on purpose: arriving faster than
# free-flow is near-impossible and punished hard; arriving slower is traffic and is not.
SIGMA_FAST = 0.35
SIGMA_SLOW = 1.1


# ── colour constancy ────────────────────────────────────────────────────────────────────────────


def shades_of_grey(bgr: np.ndarray, order: float = SOG_ORDER) -> np.ndarray:
    """Shades-of-grey white balance. The same white car, made the same white on two cameras.

    Estimates the illuminant as the Minkowski `order`-norm of each channel, normalises it to unit
    geometric mean so overall brightness is preserved, and divides it out. `order=1` is grey-world,
    `order=inf` is white-patch; 6 is the reported optimum and what this estate is measured with.
    """
    if bgr.size == 0:
        raise ValueError("shades_of_grey: empty image")
    channels = bgr.astype(np.float64) + 1.0
    illuminant = np.power(np.mean(np.power(channels, order), axis=(0, 1)), 1.0 / order)
    scale = float(np.prod(illuminant)) ** (1.0 / 3.0)
    if scale <= 0.0:
        return bgr.copy()
    corrected = channels / (illuminant / scale)
    return np.clip(corrected, 0.0, 255.0).astype(np.uint8)


def _hellinger(histogram: np.ndarray) -> np.ndarray:
    """L1-normalise then square-root. Turns the L2 dot product below into a Hellinger kernel, which
    is what stops one saturated bin from dominating a comparison."""
    total = float(histogram.sum())
    if total <= 0.0:
        return np.zeros_like(histogram, dtype=np.float32)
    return np.sqrt(histogram / total).astype(np.float32)


# ── embedders ───────────────────────────────────────────────────────────────────────────────────


class AppearanceEmbedder(Protocol):
    """A vehicle crop in, an L2-normalised float32 vector out. Never a person, never a face."""

    @property
    def embedder_id(self) -> str: ...

    @property
    def dim(self) -> int: ...

    def embed(self, crop: np.ndarray) -> np.ndarray: ...


class ColourConstantEmbedder:
    """The measured default: white-balanced striped colour histograms plus a coarse shape signature.

    Deterministic, weightless, and about 0.4 ms per crop, which is why it can run inside the
    analytics worker's best-shot path without a second model load. What it is not is a network
    trained to tell two same-coloured cars apart — `docs/reid.md` §4 gives the measured cost of that
    honestly rather than describing this as re-ID and leaving the reader to assume.
    """

    embedder_id = EMBEDDER_ID
    dim = EMBEDDING_DIM

    def embed(self, crop: np.ndarray) -> np.ndarray:
        if crop is None or crop.size == 0:
            raise ValueError("embed: empty crop")
        if crop.ndim != 3 or crop.shape[2] != 3:
            raise ValueError(f"embed: expected an HxWx3 BGR crop, got shape {crop.shape!r}")

        resized = cv2.resize(crop, CROP_SIZE, interpolation=cv2.INTER_AREA)
        balanced = shades_of_grey(resized)
        hsv = cv2.cvtColor(balanced, cv2.COLOR_BGR2HSV)
        height, width = hsv.shape[:2]

        parts: list[np.ndarray] = []
        for row in range(STRIPES):
            band = hsv[row * height // STRIPES : (row + 1) * height // STRIPES]
            for channel, bins, ceiling in (
                (0, HUE_BINS, 180),
                (1, SAT_BINS, 256),
                (2, VAL_BINS, 256),
            ):
                histogram = cv2.calcHist([band], [channel], None, [bins], [0, ceiling]).ravel()
                parts.append(_hellinger(histogram))

        grey = cv2.cvtColor(balanced, cv2.COLOR_BGR2GRAY)
        gx = cv2.Sobel(grey, cv2.CV_32F, 1, 0)
        gy = cv2.Sobel(grey, cv2.CV_32F, 0, 1)
        magnitude = np.sqrt(gx * gx + gy * gy)
        # Unsigned orientation would fold a bonnet edge onto a bumper edge; signed keeps them apart.
        orientation = (np.arctan2(gy, gx) + math.pi) * (SHAPE_BINS / (2.0 * math.pi))
        binned = np.clip(orientation.astype(np.int32), 0, SHAPE_BINS - 1)
        for row in range(SHAPE_ROWS):
            for col in range(SHAPE_COLS):
                cell = (
                    slice(row * height // SHAPE_ROWS, (row + 1) * height // SHAPE_ROWS),
                    slice(col * width // SHAPE_COLS, (col + 1) * width // SHAPE_COLS),
                )
                histogram = np.bincount(
                    binned[cell].ravel(),
                    weights=magnitude[cell].ravel(),
                    minlength=SHAPE_BINS,
                )
                parts.append(_hellinger(histogram) * SHAPE_WEIGHT)

        vector = np.concatenate(parts).astype(np.float32)
        norm = float(np.linalg.norm(vector))
        if norm <= 0.0:
            # A uniformly black crop. Returning zeros would make it cosine-similar to nothing, which
            # is the correct answer: it is not evidence of an identity.
            return vector
        return (vector / norm).astype(np.float32)


class OnnxEmbedder:
    """The seam for a real vehicle-re-ID checkpoint. Not exercised by the shipped measurement.

    Point `SAAKSHI_REID_WEIGHTS` at an ONNX model whose single input is NCHW float and whose single
    output is a feature vector. Before doing that in anything but a local experiment, add the model
    to `docs/model-licences.md` with its licence read from upstream — today the only copyleft stage
    in the pipeline is YOLO11, and a second one is a procurement decision, not a code change.
    """

    def __init__(self, weights: str, size: tuple[int, int] = CROP_SIZE) -> None:
        self.weights = weights
        self.size = size
        self._session: object | None = None
        self._dim: int | None = None

    @property
    def embedder_id(self) -> str:
        return f"onnx:{os.path.basename(self.weights)}"

    @property
    def dim(self) -> int:
        if self._dim is None:
            raise RuntimeError("OnnxEmbedder.dim is known only after the first embed()")
        return self._dim

    def _load(self) -> object:
        if self._session is None:
            import onnxruntime  # noqa: PLC0415 — heavy; a test that never embeds must not pay for it

            # CPUExecutionProvider is pinned for the same reason `anpr/plates.py` pins it: on Apple
            # Silicon the CoreML provider fails on inputs it does not like, silently and per-frame.
            self._session = onnxruntime.InferenceSession(
                self.weights, providers=["CPUExecutionProvider"]
            )
        return self._session

    def embed(self, crop: np.ndarray) -> np.ndarray:
        session = self._load()
        resized = cv2.resize(crop, self.size, interpolation=cv2.INTER_AREA)
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        batch = np.transpose(rgb, (2, 0, 1))[None, ...]
        inputs = session.get_inputs()  # type: ignore[attr-defined]
        outputs = session.run(None, {inputs[0].name: batch})  # type: ignore[attr-defined]
        vector = np.asarray(outputs[0], dtype=np.float32).ravel()
        self._dim = int(vector.size)
        norm = float(np.linalg.norm(vector))
        return vector if norm <= 0.0 else (vector / norm).astype(np.float32)


class YoloBackboneEmbedder:
    """The already-present pretrained network, used as an appearance embedder. Measured, and worse.

    D3-03's scope says "pretrained vehicle re-ID model; no training". No vehicle-re-ID checkpoint is
    available to this project under a licence it can accept, so the nearest honest thing that needs
    no new download and no new licence is the YOLO11n backbone the pipeline already runs — its
    penultimate features, 256-d.

    It is **not** a re-ID model, and the measurement says so: a detection backbone is trained to make
    all cars look alike so that it can call them cars, which is the exact opposite of the invariance
    re-ID needs. `docs/reid.md` §4 carries both arms' numbers, because "we tried the pretrained
    network and it was worse" is a finding and dropping it would be a claim by omission.
    """

    embedder_id = "yolo11n-backbone-v1"
    dim = 256

    def __init__(self, weights: str | None = None) -> None:
        self.weights = weights or os.environ.get("SAAKSHI_YOLO_WEIGHTS", "models/yolo11n.pt")
        self._model: object | None = None

    def _load(self) -> object:
        if self._model is None:
            from ultralytics import YOLO  # noqa: PLC0415 — pulls torch; deferred like device.py

            self._model = YOLO(self.weights)
        return self._model

    def embed(self, crop: np.ndarray) -> np.ndarray:
        model = self._load()
        features = model.embed(crop, verbose=False)[0]  # type: ignore[attr-defined]
        vector = np.asarray(features.cpu().numpy(), dtype=np.float32).ravel()
        norm = float(np.linalg.norm(vector))
        return vector if norm <= 0.0 else (vector / norm).astype(np.float32)


def embedder_name(override: str | None = None) -> str:
    """`--embedder` beats `SAAKSHI_REID_EMBEDDER` beats the measured default."""
    if override:
        return override
    return os.environ.get("SAAKSHI_REID_EMBEDDER", "colour-constant")


def create_embedder(name: str | None = None) -> AppearanceEmbedder:
    resolved = embedder_name(name)
    if resolved in ("colour-constant", EMBEDDER_ID):
        return ColourConstantEmbedder()
    if resolved == "yolo":
        return YoloBackboneEmbedder()
    if resolved == "onnx":
        weights = os.environ.get("SAAKSHI_REID_WEIGHTS")
        if not weights:
            raise ValueError("embedder 'onnx' needs SAAKSHI_REID_WEIGHTS pointing at a model")
        return OnnxEmbedder(weights)
    raise ValueError(f"unknown re-ID embedder {resolved!r}; known: colour-constant, yolo, onnx")


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity. Both vectors are L2-normalised on the way out of `embed`, so this is a dot
    product — but it renormalises anyway, because a vector that came back from Postgres as `real[]`
    has been through a float32 round trip."""
    if a.shape != b.shape:
        raise ValueError(f"cosine: dimension mismatch {a.shape} vs {b.shape}")
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


# ── the spatio-temporal gate ────────────────────────────────────────────────────────────────────


def timing_plausibility(elapsed_s: float, expected_s: float | None) -> float | None:
    """D3-01's travel-time model, in Python. Kept identical to
    `packages/api/src/services/route.ts::timingPlausibility` and asserted so by `test_reid.py`.

    Returns `None` when there is nothing to compare against — an unroutable pair is *unmeasured*,
    not *implausible*, and the two must not collapse into the same number.
    """
    if expected_s is None or expected_s <= 0.0 or elapsed_s < 0.0:
        return None
    if elapsed_s == 0.0:
        return 0.0
    log_ratio = math.log(elapsed_s / expected_s)
    sigma = SIGMA_FAST if log_ratio < 0 else SIGMA_SLOW
    return round(math.exp(-0.5 * (log_ratio / sigma) ** 2), 4)


def gate_reason(
    *,
    same_camera: bool,
    elapsed_s: float,
    expected_travel_time_s: float | None,
    thresholds: ReidThresholds = REID_DEFAULTS,
) -> str | None:
    """Why this candidate is not reachable from this anchor, or `None` when it is.

    A string rather than a bool because the reason is the evidence: "unroutable" and "too fast" are
    different failures and an officer reviewing a bridge that did *not* happen deserves to know
    which. `passes_spatiotemporal_gate` is the boolean built on top.

    **This runs before any appearance comparison.** Not as an optimisation — as the safety property.
    """
    if elapsed_s < 0.0:
        return "candidate precedes the anchor"
    if elapsed_s > thresholds.max_elapsed_s:
        return f"elapsed {elapsed_s:.0f}s exceeds the {thresholds.max_elapsed_s:.0f}s ceiling"
    if same_camera:
        if elapsed_s > thresholds.same_camera_max_gap_s:
            return (
                f"same camera, {elapsed_s:.0f}s apart, beyond the "
                f"{thresholds.same_camera_max_gap_s:.0f}s dwell window"
            )
        return None
    if expected_travel_time_s is None:
        # No route means no travel-time evidence. D3-01 calls this `inferred_unroutable` and refuses
        # to score it; a bridge on appearance alone across an unroutable gap is precisely the wrong
        # link this ticket exists to avoid.
        return "no route between the cameras — travel time unmeasured"
    if elapsed_s < GATE_ELAPSED_MIN_S:
        return "two cameras, no elapsed time — one vehicle cannot be in two places at once"
    plausibility = timing_plausibility(elapsed_s, expected_travel_time_s)
    if plausibility is None or plausibility < thresholds.gate_timing_min:
        shown = 0.0 if plausibility is None else plausibility
        return (
            f"travel-time plausibility {shown:.3f} below {thresholds.gate_timing_min:.2f} "
            f"(elapsed {elapsed_s:.0f}s vs {expected_travel_time_s:.0f}s free-flow)"
        )
    return None


def passes_spatiotemporal_gate(
    *,
    same_camera: bool,
    elapsed_s: float,
    expected_travel_time_s: float | None,
    thresholds: ReidThresholds = REID_DEFAULTS,
) -> bool:
    return (
        gate_reason(
            same_camera=same_camera,
            elapsed_s=elapsed_s,
            expected_travel_time_s=expected_travel_time_s,
            thresholds=thresholds,
        )
        is None
    )


# ── gallery matching ────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class GalleryEntry:
    """One plate-anchored observation of an identity. The gallery is only ever seeded from sightings
    whose plate was actually read — an identity bootstrapped from appearance would compound."""

    sighting_id: str
    camera_id: str
    ts_epoch_s: float
    embedding: np.ndarray


@dataclass(frozen=True)
class Match:
    sighting_id: str
    similarity: float


def best_match(
    query: np.ndarray,
    gallery: list[GalleryEntry],
    thresholds: ReidThresholds = REID_DEFAULTS,
) -> Match | None:
    """The strongest gallery entry above the calibrated floor, or `None`.

    Max, not mean: a vehicle looks like itself from one angle and unlike itself from another, and
    averaging a good view with a bad one throws away the good view. The cost is that the floor has
    to be strict, which is what the calibration sets it to be.
    """
    best: Match | None = None
    for entry in gallery:
        similarity = cosine(query, entry.embedding)
        if similarity < thresholds.similarity_min:
            continue
        if best is None or similarity > best.similarity:
            best = Match(sighting_id=entry.sighting_id, similarity=similarity)
    return best


def link_confidence(similarity: float, thresholds: ReidThresholds = REID_DEFAULTS) -> float:
    """Map a cosine similarity onto the `[0,1]` `identity_sightings.link_confidence` column.

    Deliberately **not** the raw cosine. Cosines between two normalised histogram descriptors live
    in a narrow high band (0.97 is a link, 0.93 is not), and writing 0.97 into a column an officer
    reads as "97% sure" would be a lie told by a number. This rescales the band above the calibrated
    floor onto `[0, 1]` and then caps it at 0.6, because a re-ID bridge is the weakest link method
    in the system and must never out-rank a fuzzy plate match in a sorted list.
    """
    floor = thresholds.similarity_min
    if similarity < floor:
        return 0.0
    span = max(1e-6, 1.0 - floor)
    return round(min(0.6, 0.6 * (similarity - floor) / span), 3)
