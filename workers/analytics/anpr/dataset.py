"""Building `fixtures/plate-eval/` — the hand-labelled evaluation set, reproducibly.

    python -m workers.analytics.anpr.dataset capture --cameras cam06 cam21 --offset 39600 \
        --condition day --seconds 90 --fps 2
    python -m workers.analytics.anpr.dataset mine --condition day --limit 400
    python -m workers.analytics.anpr.dataset sheet --condition day
    python -m workers.analytics.anpr.dataset status

**Why the sampling unit is a vehicle instance, not a plate.** Ground truth has to come from
somewhere other than the thing being measured. A set built from *plate-detector proposals* can only
ever measure precision — every plate the detector missed is missing from the ground truth too, so
recall would be 1.0 by construction. So the unit is a **vehicle** box from D1-09's YOLO11 detector,
which knows nothing about plates, and a human then records for each one whether a plate is visible
and what it says. The plate detector's hit rate on that set is a real recall.

**Why two strata, reported separately and never averaged.**

- `representative` — a uniform random sample of vehicle instances above the pipeline's own size
  floor. This answers "what does this estate actually yield?" and, on wide-area PTZ cameras, the
  answer is mostly *nothing*, which is the finding.
- `enriched` — the largest plate-bearing instances available. This answers "when this estate does
  present a readable plate, does the pipeline read it?" — the question the OCR stage is actually
  responsible for.

Averaging the two would produce a number that describes neither. The eval prints both.

Seeking is what makes day *and* night reachable in one session: the recording runs 21:00 -> 09:00, so
daylight sits at offsets ~32400-43200 s (D0-01). `-ss` goes **before** `-i` — input seek jumps to
the segment containing the offset instead of decoding twelve hours to reach it (D1-03).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import pathlib
import random
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass, field

import cv2
import numpy as np

from .plates import DEFAULT_PLATE_MODEL, PlateDetector
from .thresholds import ANPR_DEFAULTS, VEHICLE_CLASSES

log = logging.getLogger("saakshi.analytics.anpr")

#: Cloudflare fronts the sandbox and 403s ffmpeg's own `Lavf/` User-Agent. Established during recon;
#: identical to `packages/api/src/adapters/ffmpeg.ts::BROWSER_UA` on purpose — two spellings of the
#: same requirement is how one of them quietly stops working.
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)

FIXTURES = pathlib.Path("fixtures/plate-eval")
#: JPEG, quality 95, for the committed crops.
#:
#: Lossless PNG would be the instinct, and it costs **21 MB** for this set against 3 MB. The
#: source frames are already JPEG (ffmpeg `-q:v 2`), so a q95 re-encode of an already-lossy crop
#: adds a second generation of a compression the pixels have been through once; the alternative
#: is a repository nobody wants to clone for an evaluation set of 120 images. Every number in
#: `docs/anpr-accuracy.md` is measured on **these files**, not on a lossless intermediate, so the
#: committed set and the measurement are the same thing.
CROP_ENCODE = [int(cv2.IMWRITE_JPEG_QUALITY), 95]
#: Daylight sits here; the recording starts at 21:00 (D0-01, `.github/plan/D0-01-recon-camera-grid.md`).
DAY_OFFSET_S = 39600
NIGHT_OFFSET_S = 7200


@dataclass
class Instance:
    """One vehicle instance awaiting, or carrying, a human label."""

    id: str
    camera: str
    condition: str
    frame: str
    resolution: str
    vehicle_class: str
    vehicle_box: list[float]
    vehicle_crop: str
    #: Plate-detector output on this instance. `None` when it found nothing above the width floor.
    plate_box: list[float] | None = None
    plate_conf: float | None = None
    plate_width_px: float | None = None
    plate_crop: str | None = None
    stratum: str = "representative"
    #: Every native vehicle crop belonging to this **vehicle pass**, best first — the frames
    #: `deduplicate` folded into this instance plus this one. This is what makes AC 1's
    #: best-shot-versus-every-frame comparison measurable on real footage: the two strategies differ
    #: only in how many of these the OCR is asked to read.
    pass_crops: list[str] = field(default_factory=list)

    # ── the human's part ────────────────────────────────────────────────────────────────────────
    #: `true` when a human can see a plate region at all (readable or not).
    plate_visible: bool | None = None
    #: The string a human reads, or `null` when no human can read it. **Never filled by a model.**
    label: str | None = None
    #: Free text: why it is unreadable, or what makes it hard. Feeds the "where it fails" section.
    note: str = ""


@dataclass
class Manifest:
    instances: list[Instance] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps(
            {"instances": [asdict(i) for i in self.instances]}, indent=2, sort_keys=False
        )


# ── capture ─────────────────────────────────────────────────────────────────────────────────────


def stream_url(camera: str) -> str:
    """Registry endpoint pattern, from configuration — never a constant compiled into the worker.

    `GET /api/ingest` is the contract; the URL pattern is not (CLAUDE.md). `SENTINEL_STREAM_TEMPLATE`
    overrides entirely, as it does in `workers.prober.run.stream_url`.
    """
    template = os.environ.get("SENTINEL_STREAM_TEMPLATE")
    if template:
        return template.format(external_id=camera)
    host = os.environ.get("SENTINEL_HOST")
    if not host:
        raise SystemExit("neither SENTINEL_STREAM_TEMPLATE nor SENTINEL_HOST is configured")
    return f"https://{host}/{camera}/index.m3u8"


def capture(
    cameras: list[str], *, offset_s: int, condition: str, seconds: int, fps: float, out: pathlib.Path
) -> int:
    """Pulls `seconds` of video from each camera at `offset_s` and writes frames at `fps`."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise SystemExit("ffmpeg not on PATH")
    cookie = os.environ.get("SENTINEL_PORTAL_COOKIE", "")
    out.mkdir(parents=True, exist_ok=True)

    written = 0
    for camera in cameras:
        url = stream_url(camera)
        args = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
        # Input seek, before -i. Output seek would decode and discard eleven hours of video.
        args += ["-ss", str(offset_s), "-user_agent", BROWSER_UA]
        if cookie:
            # The trailing CRLF is required: ffmpeg passes the string through verbatim.
            args += ["-headers", f"Cookie: {cookie}\r\n"]
        args += ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]
        args += ["-i", url, "-t", str(seconds), "-vf", f"fps={fps}", "-q:v", "2"]
        args += [str(out / f"{condition}_{camera}_%03d.jpg")]
        log.info("capture %s @ %ds (%s) — %ds at %s fps", camera, offset_s, condition, seconds, fps)
        result = subprocess.run(args, capture_output=True, text=True, check=False)
        produced = len(list(out.glob(f"{condition}_{camera}_*.jpg")))
        written += produced
        if result.returncode != 0:
            # A slow gateway is not a broken camera (D1-03/D1-05). Recorded, never fatal.
            log.warning(
                "%s: ffmpeg exit %d after producing %d frames — %s",
                camera, result.returncode, produced, result.stderr.strip()[:200],
            )
    return written


# ── mine ────────────────────────────────────────────────────────────────────────────────────────


def _vehicle_detector(weights: str) -> object:
    from ..detect import Detector  # noqa: PLC0415 — heavy (torch), deferred
    from ..device import select_device  # noqa: PLC0415

    return Detector(select_device(None), weights)


def mine(
    frames_dir: pathlib.Path,
    out_dir: pathlib.Path,
    *,
    condition: str,
    representative: int,
    enriched: int,
    weights: str,
    plate_model: str,
    seed: int = 20260905,
) -> Manifest:
    """Turns captured frames into vehicle instances, in two stated strata."""
    from ..capabilities import CameraCapabilities  # noqa: PLC0415

    detector = _vehicle_detector(weights)
    plates = PlateDetector(plate_model)
    from .engine import crop_with_padding  # noqa: PLC0415 — avoids a cycle at import time

    frames = sorted(frames_dir.glob(f"{condition}_*.jpg"))
    if not frames:
        raise SystemExit(f"no {condition} frames in {frames_dir}")

    crops_dir = out_dir / "crops"
    crops_dir.mkdir(parents=True, exist_ok=True)

    pool: list[Instance] = []
    for frame_path in frames:
        image = cv2.imread(str(frame_path))
        if image is None:
            continue
        camera = frame_path.stem.split("_")[1]
        height, width = image.shape[:2]
        capabilities = CameraCapabilities(width=width, height=height, codec="h264")
        detections = detector.infer(image, capabilities)  # type: ignore[attr-defined]
        for index, detection in enumerate(detections):
            if detection.vehicle_class not in VEHICLE_CLASSES:
                continue
            if max(detection.w, detection.h) < ANPR_DEFAULTS.vehicle_min_box_px:
                continue
            vehicle_crop, _vx, _vy = crop_with_padding(
                image, detection.x, detection.y, detection.w, detection.h,
                ANPR_DEFAULTS.crop_pad_ratio,
            )
            if vehicle_crop.size == 0:
                continue
            boxes = plates.detect(vehicle_crop)
            usable = [b for b in boxes if b.w >= ANPR_DEFAULTS.plate_min_width_px]
            best = max(usable, key=lambda b: b.w) if usable else None

            instance = Instance(
                id=f"{frame_path.stem}_{index:02d}",
                camera=camera,
                condition=condition,
                frame=frame_path.name,
                resolution=f"{width}x{height}",
                vehicle_class=detection.vehicle_class,
                vehicle_box=[round(v, 1) for v in (detection.x, detection.y, detection.w, detection.h)],
                vehicle_crop="",
            )
            if best is not None:
                plate_crop, _px, _py = crop_with_padding(
                    vehicle_crop, best.x, best.y, best.w, best.h,
                    ANPR_DEFAULTS.crop_pad_ratio * 2,
                )
                instance.plate_box = [round(v, 1) for v in (best.x, best.y, best.w, best.h)]
                instance.plate_conf = round(best.confidence, 3)
                instance.plate_width_px = round(best.w, 1)
                if plate_crop.size:
                    name = f"{instance.id}_plate.jpg"
                    cv2.imwrite(str(crops_dir / name), plate_crop, CROP_ENCODE)
                    instance.plate_crop = f"crops/{name}"
            name = f"{instance.id}_vehicle.jpg"
            # **Native resolution, never upscaled.** The evaluator re-runs the real pipeline over
            # this file, and an upscaled crop would hand the plate detector a vehicle four times the
            # size the camera delivered — measuring a resolution the estate does not have. The
            # upscaling for human eyes happens in `sheet`, on a copy nothing is measured from.
            cv2.imwrite(str(crops_dir / name), vehicle_crop, CROP_ENCODE)
            instance.vehicle_crop = f"crops/{name}"
            pool.append(instance)

    pool = deduplicate(pool)

    rng = random.Random(seed)
    with_plate = [i for i in pool if i.plate_width_px is not None]
    with_plate.sort(key=lambda i: -(i.plate_width_px or 0.0))
    chosen_enriched = with_plate[:enriched]
    chosen_ids = {i.id for i in chosen_enriched}
    for instance in chosen_enriched:
        instance.stratum = "enriched"

    remaining = [i for i in pool if i.id not in chosen_ids]
    rng.shuffle(remaining)
    chosen_representative = remaining[:representative]

    chosen = chosen_enriched + chosen_representative
    log.info(
        "%s: %d vehicle passes mined from %d frames — %d with a plate box; "
        "sampling %d representative + %d enriched",
        condition, len(pool), len(frames), len(with_plate),
        len(chosen_representative), len(chosen_enriched),
    )
    _prune_unreferenced_crops(crops_dir, chosen, condition)
    return Manifest(instances=chosen)


def _prune_unreferenced_crops(
    crops_dir: pathlib.Path, chosen: list[Instance], condition: str
) -> int:
    """Deletes the crops of instances that were mined but not sampled.

    Mining writes a crop for every vehicle it finds — thousands — and only a few dozen are sampled.
    Committing the rest would put tens of megabytes of unlabelled, unmeasured images in the
    repository, which is the opposite of what a committed fixture set is for. Scoped by condition so
    mining `night` cannot delete the `day` set.
    """
    referenced = {
        pathlib.Path(path).name
        for instance in chosen
        for path in [*instance.pass_crops, instance.plate_crop or ""]
        if path
    }
    removed = 0
    for path in crops_dir.glob(f"{condition}_*"):
        if path.name not in referenced:
            path.unlink()
            removed += 1
    log.info("%s: pruned %d unreferenced crops, kept %d", condition, removed, len(referenced))
    return removed


#: Frames within which two overlapping vehicle boxes are assumed to be the same vehicle pass.
#:
#: Frames are sampled at 2 fps, so 6 frames is 3 seconds — longer than a vehicle takes to cross one
#: of these junction views, and short enough that two different vehicles stopping in the same lane
#: minutes apart are still counted separately.
DEDUPE_WINDOW_FRAMES = 6
#: Vehicle-box overlap above which two instances are the same vehicle.
DEDUPE_IOU = 0.3


def _iou(a: list[float], b: list[float]) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x0, y0 = max(ax, bx), max(ay, by)
    x1, y1 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    if x1 <= x0 or y1 <= y0:
        return 0.0
    intersection = (x1 - x0) * (y1 - y0)
    return intersection / (aw * ah + bw * bh - intersection)


def deduplicate(pool: list[Instance]) -> list[Instance]:
    """One instance per vehicle *pass*, not one per frame.

    Without this the set is dishonest in the most flattering possible direction: at 2 fps a vehicle
    crossing a junction appears in six consecutive frames, so an "enriched" stratum taken as the
    top-N by plate width would be six views of the same car, and a set of "50 hand-labelled plates"
    would be eight vehicles. Every count in `docs/anpr-accuracy.md` depends on this being right.

    Matched by box overlap within a short frame window, because there is no tracker here — these are
    sampled stills, not a decoded stream. The one kept is the one with the widest plate, which is the
    best evidence that pass produced.
    """
    kept: list[Instance] = []
    for instance in sorted(pool, key=lambda i: (i.camera, i.frame)):
        instance.pass_crops = [instance.vehicle_crop]
        index = _frame_index(instance.frame)
        duplicate_of = None
        for candidate in reversed(kept):
            if candidate.camera != instance.camera:
                continue
            if index - _frame_index(candidate.frame) > DEDUPE_WINDOW_FRAMES:
                break
            if _iou(candidate.vehicle_box, instance.vehicle_box) >= DEDUPE_IOU:
                duplicate_of = candidate
                break
        if duplicate_of is None:
            kept.append(instance)
            continue
        # The pass keeps every frame of itself; only the *representative* one changes.
        siblings = duplicate_of.pass_crops + [instance.vehicle_crop]
        if (instance.plate_width_px or 0.0) > (duplicate_of.plate_width_px or 0.0):
            kept[kept.index(duplicate_of)] = instance
            instance.pass_crops = siblings
        else:
            duplicate_of.pass_crops = siblings
    return kept


def _frame_index(frame_name: str) -> int:
    stem = pathlib.Path(frame_name).stem
    tail = stem.rsplit("_", 1)[-1]
    return int(tail) if tail.isdigit() else 0


# ── contact sheets ──────────────────────────────────────────────────────────────────────────────


def sheet(manifest: Manifest, out_dir: pathlib.Path, *, condition: str, per_sheet: int = 8) -> int:
    """Grids of numbered crops, so a human can label many instances per glance.

    Every tile is labelled with the instance id, so a verdict can never be written against the wrong
    row — the single most likely way a hand-labelled set goes quietly wrong.
    """
    sheets_dir = out_dir / "sheets"
    sheets_dir.mkdir(parents=True, exist_ok=True)
    subset = [i for i in manifest.instances if i.condition == condition]
    made = 0
    for start in range(0, len(subset), per_sheet):
        batch = subset[start : start + per_sheet]
        tiles = []
        for instance in batch:
            source = instance.plate_crop or instance.vehicle_crop
            image = cv2.imread(str(out_dir / source))
            if image is None:
                continue
            # INTER_NEAREST: a human labelling a 30-px plate must see the pixels that are there,
            # not a cubic interpolation's plausible guess at the ones that are not.
            tile = cv2.resize(image, (520, 180), interpolation=cv2.INTER_NEAREST)
            caption = f"{instance.id}  {instance.camera} {instance.vehicle_class}"
            if instance.plate_width_px:
                caption += f"  plate {int(instance.plate_width_px)}px"
            cv2.rectangle(tile, (0, 0), (520, 24), (0, 0, 0), -1)
            cv2.putText(
                tile, caption, (4, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.45,
                (255, 255, 255), 1, cv2.LINE_AA,
            )
            tiles.append(tile)
        if not tiles:
            continue
        rows = [np.hstack(tiles[i : i + 2]) for i in range(0, len(tiles) - len(tiles) % 2, 2)]
        if len(tiles) % 2:
            rows.append(np.hstack([tiles[-1], np.zeros_like(tiles[-1])]))
        grid = np.vstack(rows)
        path = sheets_dir / f"{condition}_{start // per_sheet:02d}.png"
        cv2.imwrite(str(path), grid)
        made += 1
    return made


# ── CLI ─────────────────────────────────────────────────────────────────────────────────────────


def load_manifest(path: pathlib.Path) -> Manifest:
    if not path.exists():
        return Manifest()
    raw = json.loads(path.read_text(encoding="utf-8"))
    return Manifest(instances=[Instance(**item) for item in raw.get("instances", [])])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m workers.analytics.anpr.dataset")
    sub = parser.add_subparsers(dest="command", required=True)

    cap = sub.add_parser("capture", help="pull frames from the sandbox at a day or night offset")
    cap.add_argument("--cameras", nargs="+", required=True)
    cap.add_argument("--condition", choices=("day", "night"), required=True)
    cap.add_argument("--offset", type=int, default=None)
    cap.add_argument("--seconds", type=int, default=90)
    cap.add_argument("--fps", type=float, default=2.0)
    cap.add_argument("--out", default=str(FIXTURES / "frames"))

    mineparser = sub.add_parser("mine", help="turn frames into labelled-set candidates")
    mineparser.add_argument("--condition", choices=("day", "night"), required=True)
    mineparser.add_argument("--frames", default=str(FIXTURES / "frames"))
    mineparser.add_argument("--out", default=str(FIXTURES))
    mineparser.add_argument("--representative", type=int, default=25)
    mineparser.add_argument("--enriched", type=int, default=15)
    mineparser.add_argument("--weights", default=os.environ.get("SAAKSHI_YOLO_WEIGHTS", "models/yolo11n.pt"))
    mineparser.add_argument("--plate-model", default=DEFAULT_PLATE_MODEL)

    sheetparser = sub.add_parser("sheet", help="contact sheets for human labelling")
    sheetparser.add_argument("--condition", choices=("day", "night"), required=True)
    sheetparser.add_argument("--out", default=str(FIXTURES))

    statusparser = sub.add_parser("status", help="how much of the set is labelled")
    statusparser.add_argument("--out", default=str(FIXTURES))

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")

    if args.command == "capture":
        offset = args.offset
        if offset is None:
            offset = DAY_OFFSET_S if args.condition == "day" else NIGHT_OFFSET_S
        count = capture(
            args.cameras, offset_s=offset, condition=args.condition,
            seconds=args.seconds, fps=args.fps, out=pathlib.Path(args.out),
        )
        print(f"{count} frames in {args.out}")
        return 0 if count else 1

    out_dir = pathlib.Path(args.out)
    labels_path = out_dir / "labels.json"

    if args.command == "mine":
        manifest = mine(
            pathlib.Path(args.frames), out_dir,
            condition=args.condition, representative=args.representative,
            enriched=args.enriched, weights=args.weights, plate_model=args.plate_model,
        )
        existing = load_manifest(labels_path)
        known = {i.id for i in existing.instances}
        existing.instances.extend(i for i in manifest.instances if i.id not in known)
        labels_path.write_text(existing.to_json(), encoding="utf-8")
        print(f"{len(manifest.instances)} instances added — {labels_path}")
        return 0

    if args.command == "sheet":
        manifest = load_manifest(labels_path)
        made = sheet(manifest, out_dir, condition=args.condition)
        print(f"{made} contact sheets in {out_dir / 'sheets'}")
        return 0

    manifest = load_manifest(labels_path)
    labelled = [i for i in manifest.instances if i.plate_visible is not None]
    legible = [i for i in labelled if i.label]
    print(
        f"{len(manifest.instances)} instances · {len(labelled)} labelled · "
        f"{len(legible)} human-legible"
    )
    for condition in ("day", "night"):
        subset = [i for i in manifest.instances if i.condition == condition]
        done = [i for i in subset if i.plate_visible is not None]
        print(f"  {condition:<6} {len(done)}/{len(subset)} labelled")
    return 0


if __name__ == "__main__":
    sys.exit(main())
