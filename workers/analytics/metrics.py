"""Prometheus exposition for the analytics worker (D3-10).

    python -m workers.analytics.run --cameras cam01 cam02 --minutes 30 --metrics-port 9465

**Why a scrape-time collector rather than a set of gauges the loop updates.** The decode loop is the
hot path: eight threads, tens of frames a second each, and every one of them would otherwise pay for
a lock and a label lookup per frame in order to produce a number nobody reads more often than every
fifteen seconds. `CameraStats` is already the authoritative counter set, so the collector simply
reads it when Prometheus asks. Nothing is buffered, nothing can go stale, and the frame loop is
untouched.

**Three rates, not one.** The single most useful thing this exporter publishes is the gap between
what a camera *declares*, what its stream actually *carries* (`measured_fps`, counted from PTS) and
what we actually *receive* (`effective_fps`, frames per wall second). On the government sandbox those
three read 30 / 14.99 / 4.00 for `cam01` — the gateway throttles roughly tenfold, and that gap is the
evidence behind every capacity claim SAAKSHI makes. A dashboard with one fps number cannot show it.

**Starvation is a ratio, not a latency.** D1-09 measured 2302.9 s blocked upstream against 150.1 s of
our own loop over a 22-minute soak — 92% upstream-bound, with zero reconnects. A board that showed
only "frames per second fell" would have read that as our outage. `upstream_wait_seconds_total` and
`loop_self_seconds_total` are exported separately so the ratio can be drawn.

**A null is not a zero.** `measured_fps` is `None` when it could not be measured; that camera's
series is simply absent, and `saakshi_worker_camera_fps_unmeasurable` marks it. Publishing 0 would
condemn a camera for the network's behaviour.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Iterable, Iterator, Protocol

from prometheus_client import REGISTRY, CollectorRegistry, start_http_server
from prometheus_client.core import CounterMetricFamily, GaugeMetricFamily
from prometheus_client.metrics_core import Metric

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .pipeline import CameraPipeline

log = logging.getLogger("saakshi.analytics.metrics")

#: Component label, so a dashboard can tell the two workers apart on one Prometheus.
COMPONENT = "analytics-worker"


class InferenceStats(Protocol):
    """The slice of `detect.Detector.stats` this exporter reads."""

    calls: int

    def percentile(self, p: float) -> float | None: ...


class PipelineCollector:
    """Reads live `CameraPipeline` state at scrape time and yields it as Prometheus families."""

    def __init__(
        self,
        pipelines: Iterable["CameraPipeline"],
        *,
        inference: InferenceStats | None = None,
        started_at: float | None = None,
    ) -> None:
        self._pipelines = list(pipelines)
        self._inference = inference
        self._started_at = started_at if started_at is not None else time.monotonic()

    def collect(self) -> Iterator[Metric]:  # noqa: C901 - one metric family per branch, not logic
        connected = GaugeMetricFamily(
            "saakshi_worker_camera_connected",
            "1 while a decode session is open for this camera. The camera-down alert is built on "
            "this: it goes to 0 when the container closes and reconnects cannot re-open it.",
            labels=["component", "camera"],
        )
        since_frame = GaugeMetricFamily(
            "saakshi_worker_camera_seconds_since_frame",
            "Wall seconds since the last decoded frame. Absent until the first frame arrives. A "
            "large value with a large upstream_wait share is the gateway starving us, not a stalled "
            "loop — read it next to the time split, never alone.",
            labels=["component", "camera"],
        )
        declared = GaugeMetricFamily(
            "saakshi_worker_camera_declared_fps",
            "Frame rate the registry says this camera has. Never trusted; exported so the gap to "
            "measured and effective is drawable.",
            labels=["component", "camera"],
        )
        measured = GaugeMetricFamily(
            "saakshi_worker_camera_measured_fps",
            "The stream's own rate, from PTS. ABSENT, never zero, when it could not be measured.",
            labels=["component", "camera"],
        )
        unmeasurable = GaugeMetricFamily(
            "saakshi_worker_camera_fps_unmeasurable",
            "Always 1. Present only while this camera's frame rate cannot be measured yet.",
            labels=["component", "camera", "reason"],
        )
        effective = GaugeMetricFamily(
            "saakshi_worker_camera_effective_fps",
            "Frames per WALL second — what we actually receive. On a throttled gateway this is "
            "roughly a tenth of measured_fps, and it is the number any capacity claim must use.",
            labels=["component", "camera"],
        )
        skip_ratio = GaugeMetricFamily(
            "saakshi_worker_camera_motion_gate_skip_ratio",
            "Fraction of considered frames the motion gate skipped. Measured 32.5% on live traffic "
            "cameras and 59.9% on a synthetic mix — it is the compute the gate saves.",
            labels=["component", "camera"],
        )
        max_gap = GaugeMetricFamily(
            "saakshi_worker_camera_max_interframe_gap_seconds",
            "Longest wall gap between two decoded frames so far this run.",
            labels=["component", "camera"],
        )
        sessions = GaugeMetricFamily(
            "saakshi_worker_camera_tracking_sessions",
            "Tracking sessions so far. A session ends at every loop-point scene cut and every "
            "reconnect, and track ids are unique only within one — never join across a cut.",
            labels=["component", "camera"],
        )
        resolution = GaugeMetricFamily(
            "saakshi_worker_camera_info",
            "Always 1. Labels carry the measured resolution, codec and inference size — measured "
            "from the container's own header, never declared.",
            labels=["component", "camera", "resolution", "codec", "imgsz"],
        )

        frames = CounterMetricFamily(
            "saakshi_worker_camera_frames_decoded",
            "Frames decoded.",
            labels=["component", "camera"],
        )
        considered = CounterMetricFamily(
            "saakshi_worker_camera_frames_considered",
            "Frames offered to the motion gate.",
            labels=["component", "camera"],
        )
        inferences = CounterMetricFamily(
            "saakshi_worker_camera_inferences",
            "Detector calls made.",
            labels=["component", "camera"],
        )
        detections = CounterMetricFamily(
            "saakshi_worker_camera_detections",
            "Raw detections returned by the detector.",
            labels=["component", "camera"],
        )
        sightings = CounterMetricFamily(
            "saakshi_worker_camera_sightings_published",
            "Sightings published to the bus. rate()*60 is this camera's read rate.",
            labels=["component", "camera"],
        )
        plate_reads = CounterMetricFamily(
            "saakshi_worker_camera_plate_reads_published",
            "Voted plate reads published — one per vehicle track that produced one. ANPR is the "
            "only mandatory analytic, so this is the mandatory throughput counter.",
            labels=["component", "camera"],
        )
        reconnects = CounterMetricFamily(
            "saakshi_worker_camera_reconnects",
            "Reconnects. A clean end of stream counts, because a VOD feed that ends is a feed we "
            "must reopen.",
            labels=["component", "camera"],
        )
        decode_errors = CounterMetricFamily(
            "saakshi_worker_camera_decode_errors",
            "Session failures. The retryable label separates 'this says nothing about the camera' "
            "(a timeout, a throttled gateway) from a real fault.",
            labels=["component", "camera", "retryable"],
        )
        warnings = CounterMetricFamily(
            "saakshi_worker_camera_decoder_warnings",
            "libav warnings, by kind. Join-time complaints are benign and are logged, never fatal.",
            labels=["component", "camera", "kind"],
        )
        scene_cuts = CounterMetricFamily(
            "saakshi_worker_camera_scene_cuts",
            "Hard scene cuts seen. Feeds loop, so a cut is normal — it resets track ids.",
            labels=["component", "camera"],
        )
        upstream_wait = CounterMetricFamily(
            "saakshi_worker_camera_upstream_wait_seconds",
            "Seconds this camera's thread spent blocked inside decode(). The GATEWAY's time.",
            labels=["component", "camera"],
        )
        loop_self = CounterMetricFamily(
            "saakshi_worker_camera_loop_self_seconds",
            "Seconds this camera's thread spent gating, inferring, tracking and publishing. OURS. "
            "upstream/(upstream+self) is the starvation ratio; 0.92 was measured on the sandbox.",
            labels=["component", "camera"],
        )

        now = time.monotonic()
        for pipeline in self._pipelines:
            stats = pipeline.stats
            camera = stats.external_id
            key = [COMPONENT, camera]

            connected.add_metric(key, 1.0 if pipeline.connected else 0.0)
            if pipeline.last_frame_at > 0.0:
                since_frame.add_metric(key, now - pipeline.last_frame_at)

            declared_fps = getattr(pipeline.source, "declared_fps", None)
            if declared_fps is not None:
                declared.add_metric(key, float(declared_fps))

            if stats.measured_fps is None:
                # "Not measured yet" and "unmeasurable" are the same shape here — the run is still
                # in flight — so the reason is honest about which it is rather than guessing.
                unmeasurable.add_metric([*key, "no_pts_window_yet"], 1.0)
            else:
                measured.add_metric(key, float(stats.measured_fps))

            eff = stats.effective_fps
            if eff is not None:
                effective.add_metric(key, float(eff))

            skip_ratio.add_metric(key, float(stats.skip_ratio))
            max_gap.add_metric(key, float(stats.max_interframe_gap_s))
            sessions.add_metric(key, float(stats.sessions))
            if stats.resolution is not None:
                resolution.add_metric(
                    [
                        *key,
                        stats.resolution,
                        stats.codec or "unknown",
                        str(stats.imgsz) if stats.imgsz is not None else "unknown",
                    ],
                    1.0,
                )

            frames.add_metric(key, float(stats.frames_decoded))
            considered.add_metric(key, float(stats.frames_considered))
            inferences.add_metric(key, float(stats.inferences_run))
            detections.add_metric(key, float(stats.detections))
            sightings.add_metric(key, float(stats.sightings))
            plate_reads.add_metric(key, float(stats.plate_reads))
            reconnects.add_metric(key, float(stats.reconnects))
            decode_errors.add_metric([*key, "true"], float(stats.retryable_errors))
            decode_errors.add_metric(
                [*key, "false"], float(max(len(stats.errors) - stats.retryable_errors, 0))
            )
            warnings.add_metric([*key, "benign"], float(stats.benign_warnings))
            warnings.add_metric([*key, "other"], float(stats.other_warnings))
            scene_cuts.add_metric(key, float(stats.scene_cuts))
            upstream_wait.add_metric(key, float(stats.upstream_wait_s))
            loop_self.add_metric(key, float(stats.loop_self_time_s))

        yield from (
            connected,
            since_frame,
            declared,
            measured,
            unmeasurable,
            effective,
            skip_ratio,
            max_gap,
            sessions,
            resolution,
            frames,
            considered,
            inferences,
            detections,
            sightings,
            plate_reads,
            reconnects,
            decode_errors,
            warnings,
            scene_cuts,
            upstream_wait,
            loop_self,
        )

        run_uptime = GaugeMetricFamily(
            "saakshi_worker_uptime_seconds",
            "Seconds since this worker opened its measured window.",
            labels=["component"],
        )
        run_uptime.add_metric([COMPONENT], now - self._started_at)
        yield run_uptime

        cameras_up = GaugeMetricFamily(
            "saakshi_worker_cameras_connected",
            "Cameras with an open decode session right now.",
            labels=["component"],
        )
        cameras_up.add_metric([COMPONENT], float(sum(1 for p in self._pipelines if p.connected)))
        yield cameras_up

        if self._inference is not None:
            calls = CounterMetricFamily(
                "saakshi_worker_inference_calls",
                "Detector calls across every camera on this device.",
                labels=["component"],
            )
            calls.add_metric([COMPONENT], float(self._inference.calls))
            yield calls

            latency = GaugeMetricFamily(
                "saakshi_worker_inference_latency_ms",
                "Detector latency percentiles over this run. A gauge of a percentile rather than a "
                "histogram because the detector already keeps the sample list and re-bucketing it "
                "per frame would cost the hot path for no extra answer.",
                labels=["component", "quantile"],
            )
            for q in (50, 95):
                value = self._inference.percentile(q)
                if value is not None:
                    latency.add_metric([COMPONENT, f"p{q}"], float(value))
            yield latency


def serve(
    pipelines: Iterable["CameraPipeline"],
    port: int,
    *,
    inference: InferenceStats | None = None,
    registry: CollectorRegistry | None = None,
) -> PipelineCollector:
    """Registers the collector and starts the exposition server. Returns the collector.

    Failure here is logged and swallowed: a worker that will not start because a metrics port is
    taken is a worker whose observability took its own subject down.
    """
    target = registry if registry is not None else REGISTRY
    collector = PipelineCollector(pipelines, inference=inference)
    try:
        target.register(collector)
        start_http_server(port, registry=target)
        log.info("metrics on :%d/metrics", port)
    except Exception as exc:  # noqa: BLE001 — never fatal
        log.warning("metrics server did not start on :%d: %s", port, exc)
    return collector
