"""Builds `fixtures/reid-eval` — the labelled pair set the re-ID numbers are measured on.

    python -m workers.analytics.reid_dataset build          # writes fixtures/reid-eval/pairs.json
    python -m workers.analytics.reid_dataset sheet          # contact sheets, for eye verification
    python -m workers.analytics.reid_dataset status

## Where the labels come from, and why they are trustworthy

A pair set proposed by the embedding being measured can only produce a tautology. So no pair here is
proposed by an embedder. Every label is a **physical fact about the source footage**, taken from
`fixtures/plate-eval/labels.json`, which D2-01 built from a plate-blind YOLO11 detector and a human
labelled by eye:

| stratum | label | what makes the label true |
|---|---|---|
| `same_camera_pass` | **same** | two crops of one tracker pass — ByteTrack held the same vehicle across consecutive frames, and the human who labelled that instance saw the whole pass on a contact sheet |
| `same_camera_simultaneous` | **different** | two instances whose passes **overlap in frame index on one camera** — both were on screen at the same instant, and one vehicle cannot be two boxes at once |
| `cross_camera_diagnostic` | **different** | two instances on different cameras, sampled seeded. Weaker: a vehicle *could* traverse the estate. Reported separately, never in the headline, for exactly that reason |

## What this set cannot do, stated here rather than in a footnote

There are **no cross-camera positive pairs**, because on this estate none can be labelled. Of 120
hand-labelled instances, 3 carry a legible plate — there is no plate anchor tying one vehicle to two
cameras, and no two sandbox cameras share a view. So:

- **precision is measurable** — a negative pair the matcher links is a false link, and the
  `same_camera_simultaneous` stratum is the hard case (same camera, same illumination, same second);
- **cross-camera recall is NOT measurable** and is reported as unmeasured, never as a number.

That asymmetry is the honest shape of this estate, and `docs/reid.md` §7 says so in those words.

## Crops are referenced, not copied

`pairs.json` points into `fixtures/plate-eval/crops/`. Those files are already committed evidence;
duplicating 3 MB of them to make this directory look self-contained would make the two sets driftable
against each other, which is worse than a path dependency stated out loud.
"""

from __future__ import annotations

import argparse
import collections
import itertools
import json
import logging
import pathlib
import random
import re
import sys
from dataclasses import dataclass

import cv2
import numpy as np

log = logging.getLogger("saakshi.analytics.reid")

SOURCE = pathlib.Path("fixtures/plate-eval")
FIXTURES = pathlib.Path("fixtures/reid-eval")

#: Same seed as the plate-eval representative sample, so the two sets are drawn from one stream and
#: a reviewer can re-derive both.
SEED = 20260905

#: How many cross-camera diagnostic negatives to sample. Enough to characterise the distribution,
#: small enough that it cannot swamp the 42 hard negatives if anybody ever pools them by mistake.
CROSS_CAMERA_SAMPLE = 300

CROP_ID = re.compile(r"_(cam\d+)_(\d+)_(\d+)_vehicle\.jpg$")

#: **The eye-verification pass, and the most important thing in this file.**
#:
#: A tracker pass is a *hypothesis* that one vehicle was held across consecutive frames, not a fact.
#: Every candidate positive was opened on a contact sheet at 232 px nearest-neighbour and looked at.
#: **16 of 75 passes did not hold one vehicle** — 9 outright ByteTrack identity switches and 7 pairs
#: no human can adjudicate. Left in, the switches would have been counted as correct links whenever
#: the matcher joined them, which is precision manufactured out of a labelling bug.
#:
#: `different` = a human is certain these are two vehicles; the pair is promoted into the negative
#: set, because an eye-verified distinct pair on one camera is exactly the hard negative this
#: measurement wants. `unusable` = a human is *not* certain either way, and plate-eval's labelling
#: rule 2 applies verbatim — if uncertain, it is not ground truth, and it is excluded from both sets.
EYE_VERDICTS: dict[str, tuple[str, str]] = {
    "pos_day_cam30_043_09": ("different", "an auto-rickshaw and a dark hatchback"),
    "pos_day_cam21_043_01": ("different", "a white hatchback and an orange goods truck"),
    "pos_day_cam07_050_09": ("different", "two auto-rickshaws: green livery, then an ATUL-badged one"),
    "pos_day_cam21_057_00": ("different", "a Qaswa goods-carriage rear and a white pickup front"),
    "pos_day_cam04_122_02": ("different", "a green auto-rickshaw and a scooter carrying a rider"),
    "pos_day_cam10_007_01": ("different", "a green auto-rickshaw and a white Tata hatchback"),
    "pos_day_cam04_039_02": ("different", "a white scooter and a motorcycle carrying two riders"),
    "pos_night_cam04_120_02": ("different", "a blue city bus and a white hatchback"),
    "pos_night_cam07_023_02": ("different", "a headlit white van and a dark auto-rickshaw"),
    "pos_day_cam10_066_15": ("unusable", "two views of a white van; a human cannot be certain"),
    "pos_day_cam30_109_14": ("unusable", "two night crops too degraded to adjudicate"),
    "pos_day_cam07_059_05": (
        "unusable",
        "neither crop is a vehicle — both are roadside lettering, the same high-contrast-text "
        "failure D2-08 found in the shipped plate crops",
    ),
    "pos_night_cam04_114_02": ("unusable", "the second crop is shop signage; the vehicle left the box"),
    "pos_night_cam04_047_02": ("unusable", "a dark crane truck and a loaded yellow pickup; probably, not certainly, different"),
    "pos_night_cam04_115_00": ("unusable", "one white car in heavy motion blur, or two; not adjudicable"),
    "pos_night_cam10_006_07": ("unusable", "a dark auto-rickshaw at two exposures; not adjudicable"),
}

SHEET_COLUMNS = 6
SHEET_TILE = 128


@dataclass(frozen=True)
class Side:
    """One half of a pair. `crop` is repo-root-relative so nothing has to guess a base directory."""

    instance_id: str
    crop: str
    camera: str
    condition: str
    frame: int
    vehicle_class: str


def _frame_of(crop: str) -> int:
    match = CROP_ID.search(crop)
    if match is None:
        raise ValueError(f"crop path does not carry a frame index: {crop!r}")
    return int(match.group(2))


def _side(instance: dict, crop: str) -> Side:
    return Side(
        instance_id=str(instance["id"]),
        crop=f"{SOURCE.as_posix()}/{crop}",
        camera=str(instance["camera"]),
        condition=str(instance["condition"]),
        frame=_frame_of(crop),
        vehicle_class=str(instance["vehicle_class"]),
    )


def load_instances(source: pathlib.Path = SOURCE) -> list[dict]:
    manifest = source / "labels.json"
    if not manifest.exists():
        raise SystemExit(f"{manifest} not found — build fixtures/plate-eval first (D2-01)")
    return list(json.loads(manifest.read_text(encoding="utf-8"))["instances"])


def positive_pairs(instances: list[dict]) -> list[dict]:
    """One pair per instance: the two crops of its pass that are furthest apart in frame index.

    One per instance, not all C(n,2) of them — a seven-crop pass would otherwise contribute 21 pairs
    and a two-crop pass one, and the measurement would quietly become a measurement of long passes.
    Furthest apart, because the widest gap is the hardest pair the pass can offer: most viewing-angle
    and scale change, least chance that the two crops are near-duplicate frames.
    """
    pairs: list[dict] = []
    for instance in instances:
        crops = list(instance.get("pass_crops") or [])
        if len(crops) < 2:
            continue
        ordered = sorted(crops, key=_frame_of)
        a, b = _side(instance, ordered[0]), _side(instance, ordered[-1])
        pair_id = f"pos_{instance['id']}"
        verdict, note = EYE_VERDICTS.get(pair_id, ("same", ""))
        pairs.append(
            {
                "pair_id": pair_id,
                "label": verdict,
                "stratum": "tracker_id_switch" if verdict != "same" else "same_camera_pass",
                "condition": a.condition,
                "camera": a.camera,
                "a": vars(a),
                "b": vars(b),
                "frame_gap": b.frame - a.frame,
                "eye_verified": True,
                "basis": (
                    note
                    if note
                    else (
                        "two crops of one ByteTrack pass, both opened and confirmed by eye to be "
                        "the same vehicle at 232 px nearest-neighbour"
                    )
                ),
            }
        )
    return pairs


def simultaneous_negative_pairs(instances: list[dict]) -> list[dict]:
    """Instances whose passes overlap in frame index on one camera: on screen together, so distinct.

    This is the hard negative stratum and the one that matters. Same camera means same white
    balance, same lens, same weather, same second — every nuisance variable that could otherwise
    separate two crops for free is held constant, and all that is left is whether the descriptor can
    tell two vehicles apart.
    """
    spans: dict[str, tuple[str, str, int, int, str, dict]] = {}
    for instance in instances:
        crops = list(instance.get("pass_crops") or []) or [str(instance["vehicle_crop"])]
        frames = [_frame_of(c) for c in crops]
        spans[str(instance["id"])] = (
            str(instance["condition"]),
            str(instance["camera"]),
            min(frames),
            max(frames),
            str(instance["vehicle_class"]),
            instance,
        )

    pairs: list[dict] = []
    for left, right in itertools.combinations(sorted(spans), 2):
        a, b = spans[left], spans[right]
        if a[0] != b[0] or a[1] != b[1]:
            continue
        if a[2] > b[3] or b[2] > a[3]:
            continue
        side_a = _side(a[5], str(a[5]["vehicle_crop"]))
        side_b = _side(b[5], str(b[5]["vehicle_crop"]))
        pairs.append(
            {
                "pair_id": f"neg_{left}__{right}",
                "label": "different",
                "stratum": "same_camera_simultaneous",
                "condition": a[0],
                "camera": a[1],
                "a": vars(side_a),
                "b": vars(side_b),
                "frame_gap": abs(side_b.frame - side_a.frame),
                "basis": (
                    f"passes overlap on {a[1]} (frames {a[2]}-{a[3]} and {b[2]}-{b[3]}): both "
                    "vehicles were on screen at the same instant, so they are not the same vehicle"
                ),
            }
        )
    return pairs


def cross_camera_negative_pairs(instances: list[dict], limit: int = CROSS_CAMERA_SAMPLE) -> list[dict]:
    """Different cameras, same vehicle class. The diagnostic stratum, never the headline.

    Same class on purpose: a bus against a motorcycle is a negative any descriptor gets right, and a
    negative set full of them measures nothing. Kept out of the headline because the label is an
    inference (a vehicle *could* cross the estate), not a physical fact like the other two strata.
    """
    rng = random.Random(SEED)
    candidates: list[dict] = []
    by_id = {str(i["id"]): i for i in instances}
    for left, right in itertools.combinations(sorted(by_id), 2):
        a, b = by_id[left], by_id[right]
        if a["camera"] == b["camera"] or a["vehicle_class"] != b["vehicle_class"]:
            continue
        candidates.append(
            {
                "pair_id": f"xcam_{left}__{right}",
                "label": "different",
                "stratum": "cross_camera_diagnostic",
                "condition": f"{a['condition']}/{b['condition']}",
                "camera": f"{a['camera']}/{b['camera']}",
                "a": vars(_side(a, str(a["vehicle_crop"]))),
                "b": vars(_side(b, str(b["vehicle_crop"]))),
                "frame_gap": None,
                "basis": (
                    "two instances on different cameras of the same vehicle class; inferred "
                    "distinct rather than observed distinct, which is why this stratum is "
                    "diagnostic and never pooled with the headline negatives"
                ),
            }
        )
    rng.shuffle(candidates)
    return candidates[:limit]


def build(source: pathlib.Path, out: pathlib.Path) -> dict:
    instances = load_instances(source)
    pairs = (
        positive_pairs(instances)
        + simultaneous_negative_pairs(instances)
        + cross_camera_negative_pairs(instances)
    )
    manifest = {
        "generated_by": "python -m workers.analytics.reid_dataset build",
        "source_fixture": source.as_posix(),
        "seed": SEED,
        "strata": {
            "same_camera_pass": "label same · one ByteTrack pass, confirmed by eye",
            "same_camera_simultaneous": "label different · both on screen at the same instant",
            "tracker_id_switch": (
                "label different or unusable · a pass the tracker held as one id that a human "
                "found to contain two vehicles, or to be unadjudicable"
            ),
            "cross_camera_diagnostic": "label different · inferred, reported separately",
        },
        "eye_verification": (
            "Every candidate positive was opened at 232 px nearest-neighbour and looked at. 16 of "
            "75 tracker passes did not hold one vehicle: 9 outright ByteTrack identity switches "
            "(promoted to negatives) and 7 pairs no human can adjudicate (excluded from both "
            "sets). That 21% is a measured property of this estate, not a labelling accident."
        ),
        "no_cross_camera_positives": (
            "3 of 120 plate-eval instances carry a legible plate and no two sandbox cameras share a "
            "view, so no cross-camera positive pair can be labelled on this estate. Cross-camera "
            "recall is therefore unmeasured, and is reported as unmeasured rather than as a number."
        ),
        "pairs": pairs,
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "pairs.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=False) + "\n", encoding="utf-8"
    )
    return manifest


def load_pairs(fixtures: pathlib.Path = FIXTURES) -> dict:
    path = fixtures / "pairs.json"
    if not path.exists():
        raise SystemExit(f"{path} not found — run `python -m workers.analytics.reid_dataset build`")
    return json.loads(path.read_text(encoding="utf-8"))


def _tile(path: pathlib.Path) -> np.ndarray:
    image = cv2.imread(str(path))
    if image is None:
        return np.zeros((SHEET_TILE, SHEET_TILE, 3), dtype=np.uint8)
    # Nearest-neighbour, for the same reason plate-eval upscales that way: cubic interpolation
    # invents edges, and a label read off an invention is not ground truth.
    return cv2.resize(image, (SHEET_TILE, SHEET_TILE), interpolation=cv2.INTER_NEAREST)


def sheet(fixtures: pathlib.Path, stratum: str, out: pathlib.Path, limit: int = 60) -> pathlib.Path:
    """A contact sheet of one stratum's pairs, side by side, for verification by eye."""
    manifest = load_pairs(fixtures)
    pairs = [p for p in manifest["pairs"] if p["stratum"] == stratum][:limit]
    if not pairs:
        raise SystemExit(f"no pairs in stratum {stratum!r}")
    columns = max(1, SHEET_COLUMNS // 2)
    rows = (len(pairs) + columns - 1) // columns
    canvas = np.full(
        (rows * (SHEET_TILE + 18), columns * (SHEET_TILE * 2 + 8), 3), 32, dtype=np.uint8
    )
    for index, pair in enumerate(pairs):
        row, col = divmod(index, columns)
        y = row * (SHEET_TILE + 18) + 18
        x = col * (SHEET_TILE * 2 + 8)
        canvas[y : y + SHEET_TILE, x : x + SHEET_TILE] = _tile(pathlib.Path(pair["a"]["crop"]))
        canvas[y : y + SHEET_TILE, x + SHEET_TILE : x + SHEET_TILE * 2] = _tile(
            pathlib.Path(pair["b"]["crop"])
        )
        cv2.putText(
            canvas,
            f"{index:02d} {pair['label']}",
            (x + 2, y - 5),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.42,
            (240, 240, 240),
            1,
            cv2.LINE_AA,
        )
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), canvas)
    return out


def status(fixtures: pathlib.Path) -> str:
    manifest = load_pairs(fixtures)
    counts = collections.Counter(p["stratum"] for p in manifest["pairs"])
    labels = collections.Counter((p["stratum"], p["label"]) for p in manifest["pairs"])
    lines = [f"{len(manifest['pairs'])} pairs in {fixtures}"]
    for stratum, count in sorted(counts.items()):
        same = labels[(stratum, "same")]
        different = labels[(stratum, "different")]
        lines.append(f"  {stratum:<28}{count:>5}  same {same:>4} · different {different:>4}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m workers.analytics.reid_dataset")
    parser.add_argument("command", choices=("build", "sheet", "status"))
    parser.add_argument("--source", default=str(SOURCE))
    parser.add_argument("--fixtures", default=str(FIXTURES))
    parser.add_argument("--stratum", default="same_camera_simultaneous")
    parser.add_argument("--out", default=None)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")
    fixtures = pathlib.Path(args.fixtures)

    if args.command == "build":
        manifest = build(pathlib.Path(args.source), fixtures)
        print(f"wrote {fixtures / 'pairs.json'} — {len(manifest['pairs'])} pairs")
        print(status(fixtures))
        return 0
    if args.command == "sheet":
        out = pathlib.Path(args.out or fixtures / "sheets" / f"{args.stratum}.png")
        print(f"wrote {sheet(fixtures, args.stratum, out)}")
        return 0
    print(status(fixtures))
    return 0


if __name__ == "__main__":
    sys.exit(main())
