"""`python -m workers.analytics.bench --cameras cam01 … --minutes 20 --sample-resources`

The measured-throughput script (AC 8) and the 20-minute soak (AC 9), in one place, because they are
the same run observed two ways.

**The number this produces feeds D3-08's GPU sizing model, so it has to be real.** Two things make
it honest rather than flattering:

1. **Two venues, reported separately.** Against the government sandbox the figure is bounded by the
   gateway — it throttles roughly tenfold under sustained use, and a "throughput" measured through
   it describes their network, not our hardware. Against local MediaMTX the same pipeline is bounded
   by the device. Both are printed; neither is presented as the other.
2. **`upstream_wait_s` vs `loop_self_time_s`.** If the worker spent 90% of its wall time blocked in
   `decode()`, the fps figure is a measurement of the upstream and the table says so out loud.

    python -m workers.analytics.bench --cameras cam01 cam02 … --minutes 20 --sample-resources
    python -m workers.analytics.bench --source mtx1=rtsp://127.0.0.1:8554/bench1 --minutes 2
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import threading
import time

from .bus import NullSink, ValkeySink
from .detect import DEFAULT_MODEL, Detector
from .device import select_device
from .run import DEFAULT_CONNECT_DEADLINE_S, DEFAULT_POOL, _split, render, run_worker
from .sources import from_registry, parse_source_override

log = logging.getLogger("saakshi.analytics")


def rss_kb() -> int | None:
    """Resident set size of this process, in KB. `None` when the platform will not say."""
    try:
        with open("/proc/self/statm", encoding="ascii") as handle:
            pages = int(handle.read().split()[1])
        return pages * (os.sysconf("SC_PAGE_SIZE") // 1024)
    except (OSError, IndexError, ValueError):
        pass
    try:
        out = subprocess.run(
            ["ps", "-o", "rss=", "-p", str(os.getpid())],
            capture_output=True, text=True, check=True, timeout=10,
        )
        return int(out.stdout.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def open_fds() -> int | None:
    """Open file descriptors. The leak check the AC actually asks for."""
    for path in ("/proc/self/fd", "/dev/fd"):
        try:
            return len(os.listdir(path))
        except OSError:
            continue
    return None


class ResourceSampler:
    """Samples RSS and descriptor count on a timer, in a daemon thread."""

    def __init__(self, interval_s: float = 15.0) -> None:
        self.interval_s = interval_s
        self.samples: list[dict[str, float | int | None]] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="resource-sampler")

    def _loop(self) -> None:
        started = time.monotonic()
        while not self._stop.is_set():
            self.samples.append(
                {
                    "t_s": round(time.monotonic() - started, 1),
                    "rss_kb": rss_kb(),
                    "open_fds": open_fds(),
                }
            )
            self._stop.wait(self.interval_s)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)
        self.samples.append(
            {"t_s": -1.0, "rss_kb": rss_kb(), "open_fds": open_fds()}
        )

    #: Seconds excluded from the slope. Loading YOLO11 and warming the MPS allocator moves RSS by
    #: hundreds of MB in the first few seconds; including that step makes every run look like a leak
    #: (measured: 147 MB/min over three minutes, of which the whole rise was the first sample).
    WARMUP_S = 60.0

    def report(self) -> dict:
        """Warm-up, then first vs last **after** it, plus the slope.

        A leak is a slope over steady state, not the distance from a cold process to a warm one.
        """
        readings = [s for s in self.samples if s["rss_kb"] is not None and float(s["t_s"]) >= 0]
        if len(readings) < 2:
            return {"samples": len(self.samples), "note": "too few samples to state a trend"}

        steady = [s for s in readings if float(s["t_s"]) >= self.WARMUP_S] or readings[-2:]
        first, last = steady[0], steady[-1]
        span_min = max((float(last["t_s"]) - float(first["t_s"])) / 60.0, 1e-6)
        return {
            "samples": len(readings),
            "warmup_s": self.WARMUP_S,
            "rss_kb_cold": readings[0]["rss_kb"],
            "rss_kb_steady_first": first["rss_kb"],
            "rss_kb_steady_last": last["rss_kb"],
            "rss_kb_max": max(int(s["rss_kb"] or 0) for s in readings),
            "rss_kb_per_min": round(
                (int(last["rss_kb"] or 0) - int(first["rss_kb"] or 0)) / span_min, 1
            ),
            "steady_span_min": round(span_min, 2),
            "open_fds_first": readings[0]["open_fds"],
            "open_fds_last": readings[-1]["open_fds"],
            "open_fds_max": max(int(s["open_fds"] or 0) for s in readings),
            "open_fds_after_shutdown": next(
                (s["open_fds"] for s in reversed(self.samples) if float(s["t_s"]) < 0), None
            ),
        }


def throughput_table(summary: dict, venue: str, note: str) -> str:
    """The deliverable: cameras x effective fps x device, with the caveats attached to it."""
    inference = summary.get("inference", {})
    split = summary["time_split"]
    upstream_share = (
        split["upstream_wait_s"] / max(split["upstream_wait_s"] + split["loop_self_time_s"], 1e-9)
    )

    rows = [
        "",
        f"  THROUGHPUT — {venue}",
        "",
        f"  device                      {summary['device']}  ({summary['weights']})",
        f"  cameras concurrent          {summary['cameras_producing_frames']} of {summary['cameras']}",
        f"  measured window             {summary['window_s']} s",
        f"  frames decoded              {summary['frames_decoded']}",
        f"  aggregate effective fps     {summary['aggregate_effective_fps']}",
        f"  per-camera effective fps    {_per_camera_fps(summary)}",
        f"  inference calls             {inference.get('calls', 0)}",
        f"  inference latency p50 / p95 {inference.get('p50_ms')} ms / {inference.get('p95_ms')} ms",
        f"  motion-gate skip ratio      {summary['motion_gate']['skip_ratio']:.1%}",
        f"  upstream-bound share        {upstream_share:.0%} of wall time blocked in decode()",
        f"  reconnects                  {summary['reconnects']}",
        f"  resolutions / codecs        {', '.join(summary['resolutions']) or '-'} / "
        f"{', '.join(summary['codecs']) or '-'}",
        "",
        f"  {note}",
        "",
    ]
    resources = summary.get("resources")
    if resources:
        rows.extend(
            [
                "  RESOURCES",
                f"    RSS cold                  {resources.get('rss_kb_cold')} KB "
                f"(before the model loaded)",
                f"    RSS steady first / last   {resources.get('rss_kb_steady_first')} / "
                f"{resources.get('rss_kb_steady_last')} KB "
                f"over {resources.get('steady_span_min')} min",
                f"    RSS peak                  {resources.get('rss_kb_max')} KB",
                f"    RSS slope (steady state)  {resources.get('rss_kb_per_min')} KB/min",
                f"    open fds first / last     {resources.get('open_fds_first')} / "
                f"{resources.get('open_fds_last')}",
                f"    open fds after shutdown   {resources.get('open_fds_after_shutdown')}",
                "",
            ]
        )
    return "\n".join(rows)


def _per_camera_fps(summary: dict) -> str:
    values = [c["effective_fps"] for c in summary["per_camera"] if c["frames_decoded"] > 0]
    values = [v for v in values if v is not None]
    if not values:
        return "-"
    return f"min {min(values)} / median {sorted(values)[len(values) // 2]} / max {max(values)}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m workers.analytics.bench")
    parser.add_argument("--cameras", nargs="+", default=[])
    parser.add_argument("--source", action="append", default=[])
    parser.add_argument("--minutes", type=float, default=5.0)
    parser.add_argument("--pool", type=int, default=DEFAULT_POOL)
    parser.add_argument("--weights", default=os.environ.get("SAAKSHI_YOLO_WEIGHTS", DEFAULT_MODEL))
    parser.add_argument("--device", default=None)
    parser.add_argument("--connect-deadline", type=float, default=DEFAULT_CONNECT_DEADLINE_S)
    parser.add_argument("--venue", default="sandbox", help="label for the table, e.g. sandbox | mediamtx")
    parser.add_argument("--sample-resources", action="store_true", help="RSS and fd sampling (the soak)")
    parser.add_argument("--sample-interval", type=float, default=15.0)
    parser.add_argument("--publish", action="store_true", help="also write to the Valkey bus")
    parser.add_argument("--json", default=None)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s")

    sources = [parse_source_override(spec) for spec in args.source]
    ids = _split(args.cameras)
    if ids:
        sources.extend(from_registry(ids))
    if not sources:
        print("no cameras in scope — pass --cameras or --source", file=sys.stderr)
        return 2

    device = select_device(args.device)
    detector = Detector(device, args.weights)
    sink = ValkeySink() if args.publish else NullSink()

    sampler = ResourceSampler(args.sample_interval) if args.sample_resources else None
    if sampler:
        sampler.start()

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
            detector=detector,
        )
    finally:
        sink.close()
        if sampler:
            sampler.stop()

    if sampler:
        summary["resources"] = sampler.report()
        summary["resource_samples"] = sampler.samples

    split = summary["time_split"]
    upstream_share = split["upstream_wait_s"] / max(
        split["upstream_wait_s"] + split["loop_self_time_s"], 1e-9
    )
    note = (
        "UPSTREAM-BOUND: the figure describes the gateway, not this hardware. Re-measure "
        "against a local source for a device number."
        if upstream_share > 0.5
        else "DEVICE-BOUND: the figure describes this hardware."
    )

    print(render(summary))
    print(throughput_table(summary, args.venue, note))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(summary, handle, indent=2)
        print(f"  summary written to {args.json}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
