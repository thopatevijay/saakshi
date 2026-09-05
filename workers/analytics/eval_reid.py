"""`python -m workers.analytics.eval_reid --fixtures fixtures/reid-eval`

Measures vehicle appearance re-identification against the hand-verified pair set, and calibrates the
similarity threshold the bridge ships with.

    python -m workers.analytics.eval_reid --fixtures fixtures/reid-eval
    python -m workers.analytics.eval_reid --embedder onnx        # a future re-ID checkpoint
    python -m workers.analytics.eval_reid --json /tmp/reid.json

## The number that decides whether this feature ships enabled

D3-03's AC 3: *threshold calibrated on >= 30 positive and >= 30 negative pairs, measured precision
>= 0.9, or the feature ships disabled by default*. The precision printed here is the one that
decides, and it is a **held-out** number:

> The threshold is chosen **leave-one-camera-out**. For each camera in turn the threshold is fitted
> on the other five and then applied to that camera's pairs; the pooled result over the six folds is
> what gets reported. A threshold fitted and reported on the same pairs is not a measurement of
> anything, and on a set this size it would reach 0.9 by construction.

The shipped threshold is separately fitted on the whole set — you calibrate on everything you have
and you report what generalises. Both numbers are printed, and `docs/reid.md` §5 carries both.

**No threshold is moved after seeing its precision.** The fitting rule is fixed: the *lowest*
threshold whose precision on the fitting fold is at or above the target, which maximises recall
subject to the precision floor. If no threshold reaches the target, the rule takes the
highest-precision threshold available and the number comes out below 0.9 — which is a result, not a
failure of the harness.

## What a false positive costs, and why precision is the gate

A wrong link attaches another vehicle's movements to this vehicle's evidentiary route. That is worse
than a missing link, which merely leaves the route as sparse as ANPR alone would have left it. Hence
the asymmetry: recall is reported, precision decides.

## The three strata are never averaged

| stratum | what it measures |
|---|---|
| `same_camera_pass` (positives) | can the descriptor recognise one vehicle across a pass? |
| `same_camera_simultaneous` + `tracker_id_switch` (negatives) | can it tell two vehicles apart with camera, lens, illumination and second all held constant? |
| `cross_camera_diagnostic` | what does it do across cameras — where colour constancy actually bites |

The cross-camera stratum is reported apart from the headline and never pooled into it: its labels are
inferred rather than observed, and — the finding that matters — its similarities are *low*, which is
evidence the descriptor is separating **cameras** rather than **vehicles**. `docs/reid.md` §6.
"""

from __future__ import annotations

import argparse
import collections
import json
import logging
import pathlib
import sys
import time
from dataclasses import dataclass, field

import cv2
import numpy as np

from .reid import REID_DEFAULTS, cosine, create_embedder, embedder_name
from .reid_dataset import FIXTURES, load_pairs

log = logging.getLogger("saakshi.analytics.reid")

#: The ticket's gate. Compared against, never assumed.
PRECISION_TARGET = 0.90

#: Thresholds swept. Cosines between two L2-normalised histogram descriptors live in a narrow high
#: band, so the grid is fine where the decision actually is.
GRID = np.round(np.arange(0.80, 1.0005, 0.0005), 4)

HEADLINE_NEGATIVE_STRATA = ("same_camera_simultaneous", "tracker_id_switch")


@dataclass
class Pair:
    pair_id: str
    label: str
    stratum: str
    camera: str
    condition: str
    similarity: float = 0.0


@dataclass
class Counts:
    """One confusion matrix. `None` rather than 0.0 wherever a metric is not measurable — an
    undefined precision and a precision of zero are different statements."""

    tp: int = 0
    fp: int = 0
    fn: int = 0
    tn: int = 0

    @property
    def precision(self) -> float | None:
        linked = self.tp + self.fp
        return None if linked == 0 else self.tp / linked

    @property
    def recall(self) -> float | None:
        positives = self.tp + self.fn
        return None if positives == 0 else self.tp / positives

    @property
    def f1(self) -> float | None:
        p, r = self.precision, self.recall
        if p is None or r is None or p + r == 0:
            return None
        return 2 * p * r / (p + r)

    def as_dict(self) -> dict:
        return {
            "tp": self.tp,
            "fp": self.fp,
            "fn": self.fn,
            "tn": self.tn,
            "precision": _round(self.precision),
            "recall": _round(self.recall),
            "f1": _round(self.f1),
        }


@dataclass
class Sweep:
    threshold: float
    counts: Counts = field(default_factory=Counts)


def _round(value: float | None) -> float | None:
    return None if value is None else round(value, 4)


def _pct(value: float | None) -> str:
    return "   n/a" if value is None else f"{value * 100:5.1f}%"


def score(pairs: list[Pair], threshold: float) -> Counts:
    counts = Counts()
    for pair in pairs:
        linked = pair.similarity >= threshold
        if pair.label == "same":
            if linked:
                counts.tp += 1
            else:
                counts.fn += 1
        elif pair.label == "different":
            if linked:
                counts.fp += 1
            else:
                counts.tn += 1
    return counts


def fit_threshold(pairs: list[Pair], target: float = PRECISION_TARGET) -> tuple[float, Counts]:
    """The fitting rule, fixed in advance: the LOWEST threshold whose precision reaches the target.

    Lowest, because among thresholds that clear the precision floor the lowest keeps the most recall.
    If none clears it, fall back to the threshold with the highest precision — and, tied on
    precision, the one with the most recall. The fallback exists so that a set the descriptor cannot
    separate produces an honest sub-target number instead of a crash or a silently widened target.
    """
    best_clearing: tuple[float, Counts] | None = None
    best_effort: tuple[float, Counts] | None = None
    for threshold in GRID:
        counts = score(pairs, float(threshold))
        if counts.tp + counts.fp == 0:
            continue
        precision = counts.precision or 0.0
        if precision >= target and best_clearing is None:
            best_clearing = (float(threshold), counts)
        if best_effort is None:
            best_effort = (float(threshold), counts)
        else:
            bp = best_effort[1].precision or 0.0
            br = best_effort[1].recall or 0.0
            if precision > bp or (precision == bp and (counts.recall or 0.0) > br):
                best_effort = (float(threshold), counts)
    if best_clearing is not None:
        return best_clearing
    if best_effort is not None:
        return best_effort
    return (float(GRID[-1]), Counts())


def embed_pairs(fixtures: pathlib.Path, manifest: dict, embedder_id: str | None) -> list[Pair]:
    embedder = create_embedder(embedder_id)
    cache: dict[str, np.ndarray] = {}
    unreadable: list[str] = []

    def vector(crop: str) -> np.ndarray | None:
        if crop not in cache:
            image = cv2.imread(crop)
            if image is None:
                unreadable.append(crop)
                return None
            cache[crop] = embedder.embed(image)
        return cache[crop]

    pairs: list[Pair] = []
    for raw in manifest["pairs"]:
        if raw["label"] == "unusable":
            continue
        a = vector(raw["a"]["crop"])
        b = vector(raw["b"]["crop"])
        if a is None or b is None:
            continue
        pairs.append(
            Pair(
                pair_id=raw["pair_id"],
                label=raw["label"],
                stratum=raw["stratum"],
                camera=raw["camera"],
                condition=raw["condition"],
                similarity=round(cosine(a, b), 6),
            )
        )
    if unreadable:
        log.warning("%d crop(s) could not be read; first: %s", len(unreadable), unreadable[0])
    return pairs


def headline(pairs: list[Pair]) -> list[Pair]:
    return [
        p
        for p in pairs
        if p.stratum == "same_camera_pass" or p.stratum in HEADLINE_NEGATIVE_STRATA
    ]


def leave_one_camera_out(pairs: list[Pair]) -> tuple[Counts, list[dict]]:
    """Fit on five cameras, test on the sixth, six times, and pool the held-out results.

    Grouped by camera rather than at random because a random split would put two crops of the same
    camera's illumination on both sides of the split, and the threshold would be fitted on the very
    nuisance variable it is supposed to generalise across.
    """
    cameras = sorted({p.camera for p in pairs})
    pooled = Counts()
    folds: list[dict] = []
    for camera in cameras:
        test = [p for p in pairs if p.camera == camera]
        fit = [p for p in pairs if p.camera != camera]
        if not test or not fit:
            continue
        if not any(p.label == "same" for p in fit) or not any(p.label == "different" for p in fit):
            continue
        threshold, fitted = fit_threshold(fit)
        counts = score(test, threshold)
        pooled.tp += counts.tp
        pooled.fp += counts.fp
        pooled.fn += counts.fn
        pooled.tn += counts.tn
        folds.append(
            {
                "held_out_camera": camera,
                "threshold": threshold,
                "fit_precision": _round(fitted.precision),
                "pairs": len(test),
                **counts.as_dict(),
            }
        )
    return pooled, folds


def evaluate(fixtures: pathlib.Path, *, embedder_id: str | None = None) -> dict:
    started = time.perf_counter()
    manifest = load_pairs(fixtures)
    pairs = embed_pairs(fixtures, manifest, embedder_id)
    head = headline(pairs)

    shipped_threshold, shipped_counts = fit_threshold(head)
    pooled, folds = leave_one_camera_out(head)

    by_slice: dict[str, Counts] = {}
    for pair in head:
        for key in ("combined", f"stratum:{pair.stratum}", f"condition:{pair.condition}", f"camera:{pair.camera}"):
            by_slice.setdefault(key, Counts())
    for key, counts in by_slice.items():
        subset = head
        if key.startswith("stratum:"):
            subset = [p for p in head if p.stratum == key.split(":", 1)[1]]
        elif key.startswith("condition:"):
            subset = [p for p in head if p.condition == key.split(":", 1)[1]]
        elif key.startswith("camera:"):
            subset = [p for p in head if p.camera == key.split(":", 1)[1]]
        by_slice[key] = score(subset, shipped_threshold)

    diagnostic = [p for p in pairs if p.stratum == "cross_camera_diagnostic"]
    diagnostic_similarities = np.array([p.similarity for p in diagnostic], dtype=np.float64)
    positives = np.array([p.similarity for p in head if p.label == "same"], dtype=np.float64)
    negatives = np.array([p.similarity for p in head if p.label == "different"], dtype=np.float64)

    return {
        "fixtures": fixtures.as_posix(),
        "embedder": embedder_name(embedder_id),
        "pairs": {
            "positive": int((np.array([p.label for p in head]) == "same").sum()),
            "negative": int((np.array([p.label for p in head]) == "different").sum()),
            "excluded_unusable": sum(1 for p in manifest["pairs"] if p["label"] == "unusable"),
            "cross_camera_diagnostic": len(diagnostic),
        },
        "shipped": {
            "threshold": shipped_threshold,
            "fitted_on": "the whole labelled set",
            **shipped_counts.as_dict(),
        },
        "held_out": {
            "method": "leave-one-camera-out, pooled",
            **pooled.as_dict(),
            "folds": folds,
        },
        "slices": {key: counts.as_dict() for key, counts in sorted(by_slice.items())},
        "similarity": {
            "positive_mean": _round(float(positives.mean())) if positives.size else None,
            "positive_min": _round(float(positives.min())) if positives.size else None,
            "negative_mean": _round(float(negatives.mean())) if negatives.size else None,
            "negative_max": _round(float(negatives.max())) if negatives.size else None,
            "cross_camera_mean": (
                _round(float(diagnostic_similarities.mean())) if diagnostic_similarities.size else None
            ),
            "cross_camera_max": (
                _round(float(diagnostic_similarities.max())) if diagnostic_similarities.size else None
            ),
        },
        "cross_camera_false_links": int((diagnostic_similarities >= shipped_threshold).sum()),
        "target": PRECISION_TARGET,
        "meets_target": bool((pooled.precision or 0.0) >= PRECISION_TARGET),
        "default_threshold_in_code": REID_DEFAULTS.similarity_min,
        "took_ms": round((time.perf_counter() - started) * 1000.0, 1),
        "outcomes": [vars(p) for p in pairs],
    }


def render(result: dict) -> str:
    lines: list[str] = []
    lines.append("")
    lines.append(f"  vehicle re-ID · {result['embedder']} · {result['fixtures']}")
    counts = result["pairs"]
    lines.append(
        f"  {counts['positive']} positive · {counts['negative']} negative "
        f"({counts['excluded_unusable']} unusable pairs excluded) · "
        f"{counts['cross_camera_diagnostic']} cross-camera diagnostic"
    )
    lines.append("")
    lines.append(f"  {'slice':<34}{'pairs':>7}{'TP':>6}{'FP':>6}{'FN':>6}{'prec':>9}{'recall':>9}{'F1':>9}")
    lines.append("  " + "-" * 86)
    for key, row in result["slices"].items():
        total = row["tp"] + row["fp"] + row["fn"] + row["tn"]
        lines.append(
            f"  {key:<34}{total:>7}{row['tp']:>6}{row['fp']:>6}{row['fn']:>6}"
            f"{_pct(row['precision']):>9}{_pct(row['recall']):>9}{_pct(row['f1']):>9}"
        )
    lines.append("")
    shipped = result["shipped"]
    lines.append(f"  shipped threshold {shipped['threshold']:.4f}  (fitted on the whole set)")
    lines.append(
        f"    fitted precision {_pct(shipped['precision'])}  recall {_pct(shipped['recall'])} "
        "— NOT the number that decides; it is fitted and reported on the same pairs"
    )
    lines.append("")
    held = result["held_out"]
    lines.append("  held-out, leave-one-camera-out (THIS is the measurement)")
    lines.append(f"    {'held-out camera':<20}{'threshold':>11}{'TP':>5}{'FP':>5}{'FN':>5}{'prec':>9}{'recall':>9}")
    lines.append("    " + "-" * 64)
    for fold in held["folds"]:
        lines.append(
            f"    {fold['held_out_camera']:<20}{fold['threshold']:>11.4f}"
            f"{fold['tp']:>5}{fold['fp']:>5}{fold['fn']:>5}"
            f"{_pct(fold['precision']):>9}{_pct(fold['recall']):>9}"
        )
    lines.append("    " + "-" * 64)
    lines.append(
        f"    {'POOLED':<20}{'':>11}{held['tp']:>5}{held['fp']:>5}{held['fn']:>5}"
        f"{_pct(held['precision']):>9}{_pct(held['recall']):>9}"
    )
    lines.append("")
    similarity = result["similarity"]
    lines.append("  similarity distribution")
    lines.append(
        f"    same-vehicle      mean {similarity['positive_mean']}  min {similarity['positive_min']}"
    )
    lines.append(
        f"    different vehicle mean {similarity['negative_mean']}  max {similarity['negative_max']}"
    )
    lines.append(
        f"    cross-camera      mean {similarity['cross_camera_mean']}  max {similarity['cross_camera_max']}"
        f"   -> {result['cross_camera_false_links']} of {counts['cross_camera_diagnostic']} above the threshold"
    )
    lines.append(
        "    A cross-camera mean far below the same-camera negatives is NOT good news: it means the"
    )
    lines.append(
        "    descriptor is separating cameras, not vehicles, so cross-camera recall would be near"
    )
    lines.append("    zero. See docs/reid.md §6.")
    lines.append("")
    precision = held["precision"]
    verdict = "MEETS" if result["meets_target"] else "MISSES"
    lines.append(
        f"  held-out precision {_pct(precision)} {verdict} the >= {result['target']:.0%} target"
    )
    if not result["meets_target"]:
        lines.append(
            "  -> D3-03 AC 3/AC 7: the feature ships DISABLED by default (REID_ENABLED=false) with"
        )
        lines.append("     this number stated in docs/reid.md, docs/limitations.md and the deck.")
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m workers.analytics.eval_reid")
    parser.add_argument("--fixtures", default=str(FIXTURES))
    parser.add_argument("--embedder", default=None, help="colour-constant (default) or onnx")
    parser.add_argument("--json", default=None, help="write the full result to this path")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.WARNING, format="%(levelname)-7s %(message)s")
    result = evaluate(pathlib.Path(args.fixtures), embedder_id=args.embedder)
    print(render(result))
    if args.json:
        pathlib.Path(args.json).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(f"  wrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
