"""`python -m workers.analytics.run --cameras cam01 cam02 ... --minutes 5`

The analytics worker's entrypoint. One thread per camera in a bounded pool, each decoding its own
stream and publishing `Sighting` payloads to the Valkey `sightings` stream.

    python -m workers.analytics.run --cameras cam01 cam02 --minutes 5
    python -m workers.analytics.run --source mtx=rtsp://127.0.0.1:8554/saakshi-test --minutes 1
    python -m workers.analytics.run --cameras cam01 --minutes 5 --no-publish   # measure only

**Why the measured window starts after every camera is connected.** On this estate a single open
has measured 82 s and 144 s, and one D1-03 probe took 516,783 ms. If the clock started at process
start, `--minutes 5` would mean "five minutes, most of which one camera spent in TCP setup", and the
concurrency the AC asks about would never actually happen. So cameras connect concurrently first,
report their connect time separately (it is the gateway's number, not ours), and the measured window
opens when the last one is ready or `--connect-deadline` expires — whichever comes first.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict

from .anpr.crops import DEFAULT_CROP_DIR, LocalCropStore
from .anpr.engine import AnprEngine
from .anpr.ocr import OCR_BACKENDS, create_ocr_backend, ocr_backend_name
from .anpr.plates import DEFAULT_PLATE_MODEL, PlateDetector
from .anpr.thresholds import thresholds_from_env
from .bus import NullSink, SightingSink, ValkeySink
from .detect import DEFAULT_MODEL, Detector
from .device import select_device
from .pipeline import CameraPipeline, CameraSource, CameraStats
from .sources import from_registry, parse_source_override
from .thresholds import DEFAULTS

log = logging.getLogger("saakshi.analytics")

#: Concurrent decode threads. Bounded, per scope ("worker assigned a camera subset by config;
#: concurrency bounded"). 8 is the AC's floor and this machine's performance core count.
DEFAULT_POOL = 8
#: Wall seconds to wait for every camera to connect before opening the measured window anyway.
DEFAULT_CONNECT_DEADLINE_S = 420.0


def run_worker(
    sources: list[CameraSource],
    *,
    minutes: float,
    pool: int = DEFAULT_POOL,
    sink: SightingSink | None = None,
    weights: str = DEFAULT_MODEL,
    device_override: str | None = None,
    connect_deadline_s: float = DEFAULT_CONNECT_DEADLINE_S,
    cookie: str | None = None,
    detector: object | None = None,
    anpr: AnprEngine | None = None,
) -> dict:
    """Runs every source concurrently for `minutes` and returns the run summary."""
    if not sources:
        raise ValueError("no cameras in scope")

    device = select_device(device_override)
    engine = detector if detector is not None else Detector(device, weights)
    out_sink = sink if sink is not None else NullSink()

    stop = threading.Event()
    start_gate = threading.Event()
    ready = threading.Semaphore(0)

    pipelines = [
        CameraPipeline(source, engine, out_sink, thresholds=DEFAULTS, cookie=cookie, anpr=anpr)
        for source in sources
    ]

    started_wall = time.time()
    connect_started = time.monotonic()
    # The deadline is set once the gate opens; until then it is "no deadline", so a camera stuck in
    # a 500-second open is not silently counted as having run.
    deadline_holder: dict[str, float | None] = {"at": None}

    def worker(pipeline: CameraPipeline) -> CameraStats:
        return pipeline.run(
            stop,
            None if deadline_holder["at"] is None else deadline_holder["at"],
            on_open=ready.release,
            start_gate=start_gate,
            gate_timeout_s=connect_deadline_s,
        )

    with ThreadPoolExecutor(max_workers=max(1, min(pool, len(pipelines)))) as executor:
        futures = [executor.submit(worker, p) for p in pipelines]

        connected = 0
        for _ in range(len(pipelines)):
            remaining = connect_deadline_s - (time.monotonic() - connect_started)
            if remaining <= 0 or not ready.acquire(timeout=remaining):
                break
            connected += 1

        connect_wall_s = round(time.monotonic() - connect_started, 1)
        log.info(
            "%d/%d cameras connected in %.1f s — opening the %.1f-minute measured window",
            connected, len(pipelines), connect_wall_s, minutes,
        )
        window_opened = time.monotonic()
        deadline_holder["at"] = window_opened + minutes * 60.0
        start_gate.set()

        # The threads read `deadline_holder` only after the gate opens, but a camera that connected
        # late holds a stale `None`; the stop event is the backstop that ends every one of them.
        stop_at = window_opened + minutes * 60.0
        while time.monotonic() < stop_at:
            if all(f.done() for f in futures):
                break
            time.sleep(0.25)
        stop.set()

        stats = [f.result() for f in futures]

    window_s = round(time.monotonic() - window_opened, 1)
    summary = summarise(
        stats,
        device=device.description,
        weights=weights,
        minutes=minutes,
        connect_wall_s=connect_wall_s,
        cameras_connected=connected,
        window_s=window_s,
        started_wall=started_wall,
        sink=out_sink,
    )

    stats_source = getattr(engine, "stats", None)
    if stats_source is not None:
        # The device-side half of the throughput table. Kept separate from wall-clock fps because
        # on a throttled gateway they answer different questions: how fast the model is, versus how
        # fast the frames arrived.
        summary["inference"] = {
            "calls": stats_source.calls,
            "p50_ms": stats_source.percentile(50),
            "p95_ms": stats_source.percentile(95),
        }

    if anpr is not None:
        # Reported next to, never merged into, the detector's numbers. Plate detection and OCR are
        # a second and a third model on the same device, and a single blended latency would hide
        # which of the three a capacity claim is actually about.
        summary["anpr"] = {
            **anpr.stats.as_dict(),
            "tracks_unemitted_at_deadline": anpr.tracks_unemitted,
            "ocr_backend": getattr(anpr.ocr, "name", "unknown"),
            "ocr_model": getattr(anpr.ocr, "model_name", "unknown"),
            "plate_model": anpr.plate_detector.model,
            "plate_detect_p50_ms": anpr.plate_detector.stats.percentile(50),
            "plate_detect_p95_ms": anpr.plate_detector.stats.percentile(95),
            "ocr_p50_ms": getattr(anpr.ocr, "stats", None)
            and anpr.ocr.stats.percentile(50),  # type: ignore[attr-defined]
            "ocr_p95_ms": getattr(anpr.ocr, "stats", None)
            and anpr.ocr.stats.percentile(95),  # type: ignore[attr-defined]
        }
    return summary


def summarise(
    stats: list[CameraStats],
    *,
    device: str,
    weights: str,
    minutes: float,
    connect_wall_s: float,
    cameras_connected: int,
    window_s: float,
    started_wall: float,
    sink: SightingSink | None = None,
) -> dict:
    """The run summary. Every number in it was measured; nothing is declared."""
    producing = [s for s in stats if s.frames_decoded > 0]
    frames = sum(s.frames_decoded for s in stats)
    considered = sum(s.frames_considered for s in stats)
    inferences = sum(s.inferences_run for s in stats)
    upstream = round(sum(s.upstream_wait_s for s in stats), 1)
    self_time = round(sum(s.loop_self_time_s for s in stats), 1)

    return {
        "device": device,
        "weights": weights,
        "started": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(started_wall)),
        "cameras": len(stats),
        "cameras_producing_frames": len(producing),
        "cameras_connected_before_window": cameras_connected,
        "connect_wall_s": connect_wall_s,
        "window_s": window_s,
        "minutes_requested": minutes,
        "frames_decoded": frames,
        "aggregate_effective_fps": round(frames / window_s, 2) if window_s > 0 else None,
        "sightings_published": sum(s.sightings for s in stats),
        "detections": sum(s.detections for s in stats),
        "scene_cuts": sum(s.scene_cuts for s in stats),
        "reconnects": sum(s.reconnects for s in stats),
        "benign_decoder_warnings": sum(s.benign_warnings for s in stats),
        "other_decoder_warnings": sum(s.other_warnings for s in stats),
        "resolutions": sorted({s.resolution for s in producing if s.resolution}),
        "codecs": sorted({s.codec for s in producing if s.codec}),
        "motion_gate": {
            "frames_considered": considered,
            "inferences_run": inferences,
            "keepalive_inferences": sum(s.keepalive_inferences for s in stats),
            "skip_ratio": round(1.0 - inferences / considered, 4) if considered else 0.0,
        },
        # The split that says whose stall it was. A large `upstream_wait_s` with a small
        # `loop_self_time_s` is a throttled gateway, not a frame-loop stall in this worker.
        "time_split": {"upstream_wait_s": upstream, "loop_self_time_s": self_time},
        "plate_reads_published": sum(s.plate_reads for s in stats),
        "publish_failures": getattr(sink, "failed", 0),
        # `effective_fps` and `skip_ratio` are properties, so `asdict` does not carry them. Merged in
        # explicitly: they are the two per-camera numbers the throughput table is made of, and a
        # summary that omits them forces every reader to recompute them from the raw counters.
        "per_camera": [
            {**asdict(s), "effective_fps": s.effective_fps, "skip_ratio": s.skip_ratio}
            for s in stats
        ],
    }


def render(summary: dict) -> str:
    lines: list[str] = ["", f"  device            {summary['device']}  ({summary['weights']})"]
    lines.append(
        f"  cameras           {summary['cameras_producing_frames']}/{summary['cameras']} producing frames"
    )
    lines.append(
        f"  connect           {summary['connect_wall_s']} s for "
        f"{summary['cameras_connected_before_window']} cameras (upstream, not our loop)"
    )
    lines.append(f"  window            {summary['window_s']} s measured")
    lines.append(
        f"  frames            {summary['frames_decoded']} "
        f"({summary['aggregate_effective_fps']} fps aggregate)"
    )
    gate = summary["motion_gate"]
    lines.append(
        f"  motion gate       {gate['inferences_run']}/{gate['frames_considered']} inferred "
        f"— skip ratio {gate['skip_ratio']:.1%} ({gate['keepalive_inferences']} keep-alive)"
    )
    split = summary["time_split"]
    lines.append(
        f"  time split        upstream {split['upstream_wait_s']} s vs our loop "
        f"{split['loop_self_time_s']} s"
    )
    lines.append(f"  sightings         {summary['sightings_published']} published")
    anpr = summary.get("anpr")
    if anpr is not None:
        lines.append(
            f"  anpr              {anpr['votes_emitted']} plate reads from "
            f"{anpr['tracks_seen']} tracks · {anpr['ocr_calls']} OCR calls "
            f"({anpr['ocr_backend']}) · {anpr['plate_detector_calls']} plate-detect calls"
        )
        lines.append(
            f"  anpr latency      plate-detect p50 {anpr['plate_detect_p50_ms']} ms / "
            f"p95 {anpr['plate_detect_p95_ms']} ms · OCR p50 {anpr['ocr_p50_ms']} ms / "
            f"p95 {anpr['ocr_p95_ms']} ms"
        )
        lines.append(
            f"  anpr rejects      {anpr['plates_too_narrow']} plate boxes below the width floor · "
            f"{anpr['votes_below_floor']} votes below the confidence floor · "
            f"{anpr['tracks_unemitted_at_deadline']} tracks unemitted at the deadline"
        )
    lines.append(
        f"  scene cuts        {summary['scene_cuts']}   reconnects {summary['reconnects']}"
    )
    lines.append(
        f"  decoder warnings  {summary['benign_decoder_warnings']} benign / "
        f"{summary['other_decoder_warnings']} other (logged, never fatal)"
    )
    lines.append(f"  resolutions       {', '.join(summary['resolutions']) or 'none'}")
    lines.append(f"  codecs            {', '.join(summary['codecs']) or 'none'}")
    lines.append("")
    header = f"  {'camera':<10}{'res':>11}{'codec':>7}{'fps(m)':>8}{'frames':>8}{'infer':>7}{'sight':>7}{'cuts':>6}{'recon':>7}{'connect':>9}"
    lines.append(header)
    lines.append("  " + "-" * (len(header) - 2))
    for cam in summary["per_camera"]:
        lines.append(
            f"  {cam['external_id']:<10}{cam['resolution'] or '-':>11}{cam['codec'] or '-':>7}"
            f"{('-' if cam['measured_fps'] is None else f'{cam['measured_fps']:.2f}'):>8}"
            f"{cam['frames_decoded']:>8}{cam['inferences_run']:>7}{cam['sightings']:>7}"
            f"{cam['scene_cuts']:>6}{cam['reconnects']:>7}"
            f"{('-' if cam['connect_s'] is None else f'{cam['connect_s']:.1f}s'):>9}"
        )
    lines.append("")
    return "\n".join(lines)


def _split(values: list[str]) -> list[str]:
    out: list[str] = []
    for value in values:
        out.extend(part for part in value.replace(",", " ").split() if part)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m workers.analytics.run")
    parser.add_argument("--cameras", nargs="+", default=[], help="registry external ids")
    parser.add_argument(
        "--source", action="append", default=[],
        help="ad-hoc stream, <external_id>=<url> (MediaMTX, a local file)",
    )
    parser.add_argument("--minutes", type=float, default=5.0)
    parser.add_argument("--pool", type=int, default=DEFAULT_POOL)
    parser.add_argument("--weights", default=os.environ.get("SAAKSHI_YOLO_WEIGHTS", DEFAULT_MODEL))
    parser.add_argument("--device", default=None, help="cuda | mps | cpu (default: auto-detect)")
    parser.add_argument("--connect-deadline", type=float, default=DEFAULT_CONNECT_DEADLINE_S)
    parser.add_argument("--no-publish", action="store_true", help="measure without writing to the bus")
    parser.add_argument("--anpr", action="store_true", help="run the ANPR stage (D2-01)")
    parser.add_argument(
        "--ocr-backend", default=None,
        help=f"OCR engine: {', '.join(sorted(OCR_BACKENDS))}",
    )
    parser.add_argument("--plate-model", default=DEFAULT_PLATE_MODEL)
    parser.add_argument(
        "--crop-dir", default=DEFAULT_CROP_DIR,
        help="where best-shot plate crops are written (gitignored; D2-02 replaces this with MinIO)",
    )
    parser.add_argument(
        "--anpr-every-frame", action="store_true",
        help="AC 1's control arm: OCR every examined frame instead of the best shots",
    )
    parser.add_argument("--json", default=None, help="write the run summary to this path")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
    )
    logging.getLogger("libav").setLevel(logging.WARNING)

    sources = [parse_source_override(spec) for spec in args.source]
    ids = _split(args.cameras)
    if ids:
        sources.extend(from_registry(ids))
    if not sources:
        print("no cameras in scope — pass --cameras or --source", file=sys.stderr)
        return 2

    anpr: AnprEngine | None = None
    if args.anpr:
        backend = ocr_backend_name(args.ocr_backend)
        log.info("anpr: plate model %s · ocr backend %s", args.plate_model, backend)
        anpr_thresholds = thresholds_from_env()
        anpr = AnprEngine(
            PlateDetector(args.plate_model, anpr_thresholds),
            create_ocr_backend(backend),
            LocalCropStore(args.crop_dir),
            anpr_thresholds,
            every_frame=args.anpr_every_frame,
        )

    sink: SightingSink = NullSink() if args.no_publish else ValkeySink()
    try:
        summary = run_worker(
            sources,
            minutes=args.minutes,
            pool=args.pool,
            sink=sink,
            weights=args.weights,
            device_override=args.device,
            connect_deadline_s=args.connect_deadline,
            cookie=os.environ.get("SENTINEL_PORTAL_COOKIE"),
            anpr=anpr,
        )
    finally:
        sink.close()

    print(render(summary))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(summary, handle, indent=2)
        print(f"  summary written to {args.json}\n")
    return 0 if summary["cameras_producing_frames"] > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
