"""Every ANPR threshold, with the reason it has the value it has.

Two rules inherited from the rest of the repo apply here too:

- a constant that was **measured** says what measured it, and a constant that was **inherited** says
  it is provisional rather than pretending to be calibrated (`workers/analytics/thresholds.py`);
- nothing here re-declares a timing constant. ANPR runs inside D1-09's PTS-driven loop and takes its
  timing from there.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

__all__ = [
    "AnprThresholds",
    "ANPR_DEFAULTS",
    "PLATE_CONF_MIN",
    "PLATE_MIN_WIDTH_PX",
    "PLATE_ASPECT_SINGLE_ROW",
    "VEHICLE_MIN_BOX_PX",
    "BEST_SHOT_TOP_N",
    "MAX_EXAMINE_PER_TRACK",
    "RECTIFY_WIDTH",
    "RECTIFY_HEIGHT",
    "QUAD_MIN_AREA_RATIO",
    "OCR_CONF_MIN",
    "VEHICLE_CLASSES",
    "CROP_PAD_RATIO",
]

# ── Plate detection ─────────────────────────────────────────────────────────────────────────────

#: Minimum YOLO-v9 confidence for a plate box to become a best-shot candidate.
#:
#: INHERITED, not calibrated — it is `open-image-models`' own `default_conf_thresh` for the
#: license-plate models. Measured on the 120 D0-01 recon frames, the two boxes a human could
#: actually read scored **0.84** each while every box under 0.45 was a wheel arch or a bumper
#: reflection; the floor is nevertheless left at the model default so that recall is measured rather
#: than assumed, and the eval report carries the confidence distribution.
PLATE_CONF_MIN = 0.25

#: Plate boxes narrower than this are never sent to OCR.
#:
#: Measured: on this estate a plate becomes legible **to a human** at about 36 px of width
#: (`cam06`, `GJ11CH2…`, 36x15) and comfortably legible at 48 px (`cam21`, `RJ39CA5180`, 48x16).
#: Below ~20 px there is less than one pixel per character stroke and any string an OCR returns is
#: an invention. 20 is deliberately *below* the legibility threshold, not at it: the eval measures
#: what the pipeline does in the marginal band instead of hiding it behind a floor.
PLATE_MIN_WIDTH_PX = 20

#: Expected width:height of an Indian single-row plate.
#:
#: The Indian standard (CMVR Rule 50) single-row plate for cars is 500x120 mm — **4.17**. The
#: two-row plate used on motorcycles and many auto-rickshaws is 285x200 mm — **1.43** — which is why
#: frontality scoring is a *distance from* the expected ratio and not a hard filter: a two-wheeler
#: plate is not an oblique car plate, and rejecting it would silently delete the class the report is
#: obliged to be honest about.
PLATE_ASPECT_SINGLE_ROW = 4.17

# ── Which vehicles are examined at all ──────────────────────────────────────────────────────────

#: Detector classes that can carry a plate. `person` and `bicycle` are in `vehicle_class` (D1-09
#: keeps them: a pedestrian near a vehicle of interest is evidence) but neither has a plate.
VEHICLE_CLASSES = frozenset({"car", "motorcycle", "bus", "truck", "auto_rickshaw"})

#: Vehicle boxes with a long edge below this are not searched for a plate.
#:
#: A plate is roughly a tenth of a vehicle's width head-on and far less obliquely, so a 48-px
#: vehicle cannot contain a plate above `PLATE_MIN_WIDTH_PX`. Skipping it saves the plate-detector
#: call, which is the dominant added cost of this stage.
VEHICLE_MIN_BOX_PX = 48

#: Fraction of the vehicle box added as padding before plate search.
#:
#: The tracker's box is tight, and a plate sitting on the bumper's lower edge is routinely clipped by
#: a few pixels — which costs the leading character. Cheap insurance.
CROP_PAD_RATIO = 0.08

# ── Best-shot selection ─────────────────────────────────────────────────────────────────────────

#: How many frames per track are kept and OCR'd.
#:
#: The budget is set by the gateway, not by the model: D1-09 measured **min 1.92 / median 4.00
#: effective fps per camera** against a nominal 25, so a vehicle crossing a junction in ~4 s yields
#: roughly 8-16 inferred frames, and a top-3 keeps the good tail of that without depending on a rate
#: the gateway does not deliver. 3 is also the smallest N at which a per-character vote can break a
#: tie, which is the entire point of voting.
BEST_SHOT_TOP_N = 3

#: Frames per track examined for a plate before the vote is forced.
#:
#: Bounded so that a vehicle parked in view forever does not run the plate detector forever. Sized
#: at 4x `BEST_SHOT_TOP_N` so a track normally fills its buffer from good frames rather than from
#: whichever frames happened to arrive first.
MAX_EXAMINE_PER_TRACK = 12

# ── Rectification ───────────────────────────────────────────────────────────────────────────────

#: Canonical plate size after perspective correction, in pixels.
#:
#: 192x48 is 4.0:1, close to the 4.17 standard, and both OCR backends resize to their own input
#: anyway; what matters is that every crop reaches them in the *same* geometry, so the OCR is never
#: also being asked to undo a projection.
RECTIFY_WIDTH = 192
RECTIFY_HEIGHT = 48

#: A detected quadrilateral must cover at least this fraction of the padded crop to be used.
#:
#: Without it the contour finder happily returns a four-sided highlight on the bumper, and warping to
#: *that* is worse than not warping at all. Below the ratio the code falls back to a min-area
#: rectangle deskew, and below that to a plain resize — three named methods, all recorded per read,
#: so the eval can report which one produced which number.
#:
#: **Measured, after an earlier value of 0.25 rejected the exact case rectification exists for.** A
#: plate seen at a grazing angle covers *less* of its crop, not more: on the oblique fixture the
#: quad's coverage falls 0.29 -> 0.24 -> 0.20 as the projection steepens, so a 0.25 floor switched
#: the perspective path off at precisely the extremes and fell back to a plain resize. A bumper
#: highlight in the same test measures **0.018** — an order of magnitude below the steepest real
#: plate — so 0.10 separates the two with room on both sides.
QUAD_MIN_AREA_RATIO = 0.10

# ── OCR and voting ──────────────────────────────────────────────────────────────────────────────

#: Reads below this aggregate confidence are discarded rather than written.
#:
#: PROVISIONAL and deliberately low. A plate read is never a bare string in this system — every row
#: carries its confidence — so the useful floor is the one that keeps a weak read *visible and
#: labelled* rather than the one that makes the average look good. The eval reports precision at
#: several floors so this can be set from data by D2-04 rather than from taste.
OCR_CONF_MIN = 0.30


@dataclass(frozen=True)
class AnprThresholds:
    """Overridable per run, so a test can be strict or loose without patching globals."""

    plate_conf_min: float = PLATE_CONF_MIN
    plate_min_width_px: int = PLATE_MIN_WIDTH_PX
    plate_aspect_single_row: float = PLATE_ASPECT_SINGLE_ROW
    vehicle_min_box_px: int = VEHICLE_MIN_BOX_PX
    crop_pad_ratio: float = CROP_PAD_RATIO
    best_shot_top_n: int = BEST_SHOT_TOP_N
    max_examine_per_track: int = MAX_EXAMINE_PER_TRACK
    rectify_width: int = RECTIFY_WIDTH
    rectify_height: int = RECTIFY_HEIGHT
    quad_min_area_ratio: float = QUAD_MIN_AREA_RATIO
    ocr_conf_min: float = OCR_CONF_MIN


ANPR_DEFAULTS = AnprThresholds()


def thresholds_from_env() -> AnprThresholds:
    """Environment overrides, for a tuning run that must not require an edit.

    Only the two floors that an operator plausibly wants to move per estate are exposed. Everything
    else is a design constant with a written reason, and an environment variable that quietly
    changes one of those is how a documented rationale stops describing the running system.
    """

    def _float(name: str, fallback: float) -> float:
        raw = os.environ.get(name)
        return fallback if raw is None or raw == "" else float(raw)

    def _int(name: str, fallback: int) -> int:
        raw = os.environ.get(name)
        return fallback if raw is None or raw == "" else int(raw)

    return AnprThresholds(
        plate_conf_min=_float("SAAKSHI_PLATE_CONF_MIN", PLATE_CONF_MIN),
        plate_min_width_px=_int("SAAKSHI_PLATE_MIN_WIDTH_PX", PLATE_MIN_WIDTH_PX),
        ocr_conf_min=_float("SAAKSHI_OCR_CONF_MIN", OCR_CONF_MIN),
    )
