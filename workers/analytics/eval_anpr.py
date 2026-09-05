"""`python -m workers.analytics.eval_anpr --fixtures fixtures/plate-eval`

Measures the ANPR pipeline against a **hand-labelled** set of vehicle instances from the sandbox
feeds, and prints precision and recall by condition — day, night and combined.

    python -m workers.analytics.eval_anpr --fixtures fixtures/plate-eval
    python -m workers.analytics.eval_anpr --fixtures fixtures/plate-eval --backend fast_plate_ocr
    python -m workers.analytics.eval_anpr --fixtures fixtures/plate-eval --compare

## What the numbers mean, precisely

Every instance in the set is a **vehicle box from D1-09's YOLO11 detector** — which knows nothing
about plates — that a human then examined and annotated with `plate_visible` and, where a human
could read it, the `label`. Ground truth therefore does not come from the thing being measured,
which is what makes recall a real number rather than 1.0 by construction.

| term | definition here |
|---|---|
| **legible** | a human read the plate off the crop. This is the denominator for recall. |
| **detection recall** | plate-detector boxes above the width floor, over legible instances |
| **read recall** | pipeline reads that exactly equal the human label, over legible instances |
| **precision** | reads that exactly equal the human label, over **all** reads emitted — including reads emitted on instances a human could not read, which are false positives whatever they say |
| **character accuracy** | 1 - (edit distance / label length), averaged over legible instances that produced a read. Reported because a one-character miss and a total miss are not the same failure, and D2-04's fuzzy matching survives the first. |

**The two strata are never averaged.** `representative` is a uniform random sample of vehicle
instances above the pipeline's own size floor, and answers *what does this estate yield?*
`enriched` is the largest plate-bearing instances available, and answers *when a readable plate is
presented, is it read?* A single blended figure would describe neither, and on an estate of
wide-area PTZ cameras it would be dominated by vehicles whose plates are ten pixels wide.

## The >90% target

`PROJECT.md §Success criteria` records the challenge's stated *"detection / processing accuracy
> 90%"*. The eval prints the comparison for day, night and combined, and says plainly when the
figure is below it. An honest miss with a number beats a vague claim — CLAUDE.md's claims
discipline, and the ticket's own instruction.
"""

from __future__ import annotations

import argparse
import json
import logging
import pathlib
import sys
import time
from dataclasses import dataclass, field

import cv2

from .anpr.dataset import Instance, load_manifest
from .anpr.ocr import OcrBackend, create_ocr_backend, ocr_backend_name
from .anpr.plates import DEFAULT_PLATE_MODEL, PlateDetector
from .anpr.rectify import rectify
from .anpr.thresholds import ANPR_DEFAULTS, AnprThresholds
from .anpr.vote import vote_reads

log = logging.getLogger("saakshi.analytics.anpr")

#: The challenge's stated target, recorded in `PROJECT.md`. Compared against, never assumed.
ACCURACY_TARGET = 0.90


def edit_distance(a: str, b: str) -> int:
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i]
        for j, cb in enumerate(b, start=1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


@dataclass
class Outcome:
    """One instance's result. Every field is what happened, not what was hoped."""

    instance_id: str
    camera: str
    condition: str
    stratum: str
    vehicle_class: str
    plate_width_px: float | None
    legible: bool
    label: str | None
    read: str | None
    confidence: float | None
    vote_count: int
    rectify_method: str
    ocr_calls: int
    correct: bool
    char_accuracy: float | None


@dataclass
class Bucket:
    """Counts for one slice of the set."""

    instances: int = 0
    legible: int = 0
    illegible: int = 0
    plate_detected_on_legible: int = 0
    reads_emitted: int = 0
    reads_on_illegible: int = 0
    correct: int = 0
    char_accuracies: list[float] = field(default_factory=list)
    ocr_calls: int = 0

    def add(self, outcome: Outcome) -> None:
        self.instances += 1
        self.ocr_calls += outcome.ocr_calls
        if outcome.legible:
            self.legible += 1
            if outcome.plate_width_px is not None:
                self.plate_detected_on_legible += 1
        else:
            self.illegible += 1
        if outcome.read is not None:
            self.reads_emitted += 1
            if not outcome.legible:
                self.reads_on_illegible += 1
        if outcome.correct:
            self.correct += 1
        if outcome.char_accuracy is not None:
            self.char_accuracies.append(outcome.char_accuracy)

    @property
    def detection_recall(self) -> float | None:
        return None if self.legible == 0 else self.plate_detected_on_legible / self.legible

    @property
    def read_recall(self) -> float | None:
        return None if self.legible == 0 else self.correct / self.legible

    @property
    def precision(self) -> float | None:
        return None if self.reads_emitted == 0 else self.correct / self.reads_emitted

    @property
    def f1(self) -> float | None:
        p, r = self.precision, self.read_recall
        if p is None or r is None or p + r == 0:
            return None
        return 2 * p * r / (p + r)

    @property
    def character_accuracy(self) -> float | None:
        if not self.char_accuracies:
            return None
        return sum(self.char_accuracies) / len(self.char_accuracies)

    def as_dict(self) -> dict:
        return {
            "instances": self.instances,
            "legible": self.legible,
            "illegible": self.illegible,
            "plate_detected_on_legible": self.plate_detected_on_legible,
            "reads_emitted": self.reads_emitted,
            "reads_on_illegible": self.reads_on_illegible,
            "correct": self.correct,
            "ocr_calls": self.ocr_calls,
            "detection_recall": _round(self.detection_recall),
            "read_recall": _round(self.read_recall),
            "precision": _round(self.precision),
            "f1": _round(self.f1),
            "character_accuracy": _round(self.character_accuracy),
        }


def _round(value: float | None) -> float | None:
    return None if value is None else round(value, 4)


def _pct(value: float | None) -> str:
    return "  n/a " if value is None else f"{value * 100:5.1f}%"


class InstanceRunner:
    """Runs the ANPR stage over one labelled instance, in one of two strategies.

    Deliberately **not** `AnprEngine`: an instance is a single frame, not a track, so there is no
    multi-frame buffer to fill. What is measured here is detect -> rectify -> OCR -> vote on the
    evidence the estate actually provides for that vehicle, which is exactly what the engine would
    do for a track that produced one candidate. `--compare` then varies the *number* of reads the
    vote gets, which is the axis AC 1 is about.
    """

    def __init__(
        self,
        fixtures: pathlib.Path,
        plates: PlateDetector,
        ocr: OcrBackend,
        thresholds: AnprThresholds = ANPR_DEFAULTS,
    ) -> None:
        self.fixtures = fixtures
        self.plates = plates
        self.ocr = ocr
        self.thresholds = thresholds

    def run(self, instance: Instance, *, every_frame: bool) -> Outcome:
        legible = bool(instance.label)
        crop_path = self.fixtures / instance.vehicle_crop
        image = cv2.imread(str(crop_path))
        reads = []
        rectify_method = "none"
        ocr_calls = 0

        # The stored vehicle crop is upscaled for human inspection; the pipeline sees the real
        # pixels, so the plate box is re-detected here at the crop's own scale.
        if image is not None and image.size:
            boxes = [
                box
                for box in self.plates.detect(image)
                if box.w >= self.thresholds.plate_min_width_px
            ]
            boxes.sort(key=lambda box: -box.w)
            # One read in the best-shot strategy, every candidate box in the control arm — the
            # single-frame analogue of "OCR the best shots" versus "OCR everything".
            candidates = boxes if every_frame else boxes[:1]
            for box in candidates:
                pad_x = int(box.w * self.thresholds.crop_pad_ratio * 2)
                pad_y = int(box.h * self.thresholds.crop_pad_ratio * 2)
                x0 = max(0, int(box.x) - pad_x)
                y0 = max(0, int(box.y) - pad_y)
                x1 = min(image.shape[1], int(box.x + box.w) + pad_x)
                y1 = min(image.shape[0], int(box.y + box.h) + pad_y)
                crop = image[y0:y1, x0:x1]
                if crop.size == 0:
                    continue
                rectified = rectify(crop, self.thresholds)
                rectify_method = rectified.method
                read = self.ocr.read(rectified.image)
                ocr_calls += 1
                if read is not None:
                    reads.append(read)

        voted = vote_reads(reads)
        if voted is not None and voted.confidence < self.thresholds.ocr_conf_min:
            voted = None

        text = voted.text if voted else None
        correct = bool(legible and text is not None and text == instance.label)
        char_accuracy: float | None = None
        if legible and text is not None and instance.label:
            distance = edit_distance(text, instance.label)
            char_accuracy = max(0.0, 1.0 - distance / len(instance.label))

        return Outcome(
            instance_id=instance.id,
            camera=instance.camera,
            condition=instance.condition,
            stratum=instance.stratum,
            vehicle_class=instance.vehicle_class,
            plate_width_px=instance.plate_width_px,
            legible=legible,
            label=instance.label,
            read=text,
            confidence=voted.confidence if voted else None,
            vote_count=voted.vote_count if voted else 0,
            rectify_method=rectify_method,
            ocr_calls=ocr_calls,
            correct=correct,
            char_accuracy=char_accuracy,
        )


def evaluate(
    fixtures: pathlib.Path,
    *,
    backend_name: str,
    plate_model: str,
    every_frame: bool = False,
    thresholds: AnprThresholds = ANPR_DEFAULTS,
) -> dict:
    manifest = load_manifest(fixtures / "labels.json")
    labelled = [i for i in manifest.instances if i.plate_visible is not None]
    if not labelled:
        raise SystemExit(
            f"{fixtures / 'labels.json'} carries no human labels — run "
            f"`python -m workers.analytics.anpr.dataset status` and label the set first"
        )

    runner = InstanceRunner(fixtures, PlateDetector(plate_model, thresholds), create_ocr_backend(backend_name), thresholds)

    started = time.perf_counter()
    outcomes = [runner.run(instance, every_frame=every_frame) for instance in labelled]
    elapsed = time.perf_counter() - started

    buckets: dict[str, Bucket] = {}

    def bucket(name: str) -> Bucket:
        return buckets.setdefault(name, Bucket())

    for outcome in outcomes:
        bucket("combined").add(outcome)
        bucket(f"condition:{outcome.condition}").add(outcome)
        bucket(f"stratum:{outcome.stratum}").add(outcome)
        bucket(f"stratum:{outcome.stratum}|{outcome.condition}").add(outcome)
        bucket(f"camera:{outcome.camera}").add(outcome)
        bucket(f"class:{outcome.vehicle_class}").add(outcome)

    return {
        "fixtures": str(fixtures),
        "ocr_backend": backend_name,
        "plate_model": plate_model,
        "strategy": "every-frame" if every_frame else "best-shot",
        "instances_labelled": len(labelled),
        "wall_s": round(elapsed, 1),
        "buckets": {name: b.as_dict() for name, b in sorted(buckets.items())},
        "outcomes": [vars(o) for o in outcomes],
    }


# ── rendering ───────────────────────────────────────────────────────────────────────────────────


def render(result: dict) -> str:
    buckets = result["buckets"]
    lines = [
        "",
        f"  fixtures      {result['fixtures']}  ({result['instances_labelled']} hand-labelled instances)",
        f"  plate model   {result['plate_model']}",
        f"  ocr backend   {result['ocr_backend']}   strategy {result['strategy']}",
        "",
        f"  {'slice':<28}{'inst':>6}{'legible':>9}{'det rec':>9}{'read rec':>10}"
        f"{'prec':>8}{'F1':>8}{'char acc':>10}{'OCR':>6}",
        "  " + "-" * 92,
    ]

    order = [
        "combined",
        "condition:day",
        "condition:night",
        "stratum:enriched",
        "stratum:enriched|day",
        "stratum:enriched|night",
        "stratum:representative",
        "stratum:representative|day",
        "stratum:representative|night",
    ]
    for name in order:
        row = buckets.get(name)
        if row is None:
            continue
        lines.append(
            f"  {name:<28}{row['instances']:>6}{row['legible']:>9}"
            f"{_pct(row['detection_recall']):>9}{_pct(row['read_recall']):>10}"
            f"{_pct(row['precision']):>8}{_pct(row['f1']):>8}"
            f"{_pct(row['character_accuracy']):>10}{row['ocr_calls']:>6}"
        )

    lines.append("")
    lines.append("  per camera")
    for name, row in sorted(buckets.items()):
        if not name.startswith("camera:"):
            continue
        lines.append(
            f"  {name:<28}{row['instances']:>6}{row['legible']:>9}"
            f"{_pct(row['detection_recall']):>9}{_pct(row['read_recall']):>10}"
            f"{_pct(row['precision']):>8}{_pct(row['f1']):>8}"
            f"{_pct(row['character_accuracy']):>10}{row['ocr_calls']:>6}"
        )

    lines.append("")
    lines.append(f"  against the challenge's stated >{ACCURACY_TARGET:.0%} accuracy target")
    for name in ("condition:day", "condition:night", "combined"):
        row = buckets.get(name)
        if row is None:
            continue
        for metric in ("read_recall", "precision"):
            value = row[metric]
            if value is None:
                lines.append(f"    {name:<18} {metric:<14} not measurable on this slice")
                continue
            verdict = "MEETS" if value >= ACCURACY_TARGET else "MISSES"
            lines.append(
                f"    {name:<18} {metric:<14} {value * 100:5.1f}%   {verdict} the >90% target"
            )
    lines.append("")
    return "\n".join(lines)


def render_comparison(best_shot: dict, every_frame: dict) -> str:
    """AC 1: equal-or-better accuracy at materially lower inference count, with both numbers."""
    a = best_shot["buckets"]["combined"]
    b = every_frame["buckets"]["combined"]
    lines = [
        "",
        "  best-shot vs every-frame OCR — the same labelled set, the same models",
        "",
        f"  {'strategy':<14}{'OCR calls':>11}{'correct':>9}{'read rec':>10}{'prec':>8}"
        f"{'char acc':>10}{'wall s':>9}",
        "  " + "-" * 71,
    ]
    for name, row, whole in (
        ("best-shot", a, best_shot),
        ("every-frame", b, every_frame),
    ):
        lines.append(
            f"  {name:<14}{row['ocr_calls']:>11}{row['correct']:>9}"
            f"{_pct(row['read_recall']):>10}{_pct(row['precision']):>8}"
            f"{_pct(row['character_accuracy']):>10}{whole['wall_s']:>9}"
        )
    saved = b["ocr_calls"] - a["ocr_calls"]
    share = saved / b["ocr_calls"] if b["ocr_calls"] else 0.0
    lines.append("")
    lines.append(
        f"  best-shot ran {saved} fewer OCR inferences ({share:.1%} of the every-frame count) "
        f"for {a['correct']} correct reads against {b['correct']}."
    )
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m workers.analytics.eval_anpr")
    parser.add_argument("--fixtures", default="fixtures/plate-eval")
    parser.add_argument("--backend", default=None, help="OCR backend; default is the measured one")
    parser.add_argument("--plate-model", default=DEFAULT_PLATE_MODEL)
    parser.add_argument(
        "--compare", action="store_true",
        help="also run the every-frame control arm and print the AC 1 comparison",
    )
    parser.add_argument("--json", default=None, help="write the full result to this path")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.WARNING, format="%(levelname)-7s %(message)s")
    fixtures = pathlib.Path(args.fixtures)
    backend = ocr_backend_name(args.backend)

    result = evaluate(fixtures, backend_name=backend, plate_model=args.plate_model)
    print(render(result))

    if args.compare:
        control = evaluate(
            fixtures, backend_name=backend, plate_model=args.plate_model, every_frame=True
        )
        print(render_comparison(result, control))
        result = {"best_shot": result, "every_frame": control}

    if args.json:
        pathlib.Path(args.json).write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(f"  written to {args.json}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
