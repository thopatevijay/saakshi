"""Prometheus exposition for the trust prober (D3-10).

    python -m workers.prober.run --interval 1800 --all --metrics-port 9466

The prober is a sweep, not a stream: it probes every active camera, writes a `camera_health_checks`
row, and moves on. So unlike the analytics worker there is no live state to read at scrape time —
the metrics are *updated as each result lands*, which matters, because a sweep takes **23.6 minutes**
at pool 4 on this estate and a board that only updated at the end of a pass would be showing
half-hour-old health for half an hour.

Three semantics this module exists to preserve, all of them corrections to real mistakes:

- **`measured_fps IS NULL` means "could not measure", never zero.** A null publishes no fps sample at
  all and instead sets `saakshi_prober_camera_fps_unmeasurable{camera,reason}` from
  `breakdown.fps.unmeasurable_reason`. D1-05 recorded a camera as unmeasurable after a 516-second
  probe and at 20 fps after an 85-second one — same code, same camera, different network. Graphing
  the first as 0 condemns the camera for the gateway's behaviour.
- **`pts_drift_ms` means two different things.** `breakdown.pts_drift_meaning` says which per row:
  on a live source it is encoder clock drift and worth alerting on; on VOD it is pull-rate skew and
  means nothing. The meaning travels as a label so an alert rule can select `meaning="live"` and
  every sandbox row (all of them VOD) is correctly ignored.
- **A retryable failure is not a health verdict.** `saakshi_prober_camera_probe_failed` carries a
  `retryable` label; a timeout says something about the network, not the camera.
"""

from __future__ import annotations

import logging
import time

from prometheus_client import REGISTRY, CollectorRegistry, Counter, Gauge, start_http_server

from .probe import ProbeResult

log = logging.getLogger("saakshi.prober.metrics")

COMPONENT = "prober-worker"


class ProberMetrics:
    """Gauges and counters for one prober process, updated result by result."""

    def __init__(self, registry: CollectorRegistry | None = None) -> None:
        target = registry if registry is not None else REGISTRY

        self.connectable = Gauge(
            "saakshi_prober_camera_connectable",
            "1 when the newest probe reached this camera.",
            ["component", "camera"],
            registry=target,
        )
        self.decodable = Gauge(
            "saakshi_prober_camera_decodable",
            "1 when the newest probe decoded a frame from this camera.",
            ["component", "camera"],
            registry=target,
        )
        self.measured_fps = Gauge(
            "saakshi_prober_camera_measured_fps",
            "Frame rate counted from PTS, with the connect-burst discarded. ABSENT, never zero, "
            "when it could not be measured.",
            ["component", "camera"],
            registry=target,
        )
        self.declared_fps = Gauge(
            "saakshi_prober_camera_declared_fps",
            "Frame rate the camera declares. Exported only so the divergence from measured is "
            "drawable — a 30-declared / 15.4-measured camera is the estate's normal case.",
            ["component", "camera"],
            registry=target,
        )
        self.fps_diverged = Gauge(
            "saakshi_prober_camera_fps_diverged",
            "1 when measured and declared differ by more than 15%. A product feature, not a bug.",
            ["component", "camera"],
            registry=target,
        )
        self.fps_unmeasurable = Gauge(
            "saakshi_prober_camera_fps_unmeasurable",
            "Always 1. Present only for a camera whose frame rate could not be measured; the "
            "reason label distinguishes 'too slow to measure' from 'no measurable frame rate'.",
            ["component", "camera", "reason"],
            registry=target,
        )
        self.blur_score = Gauge(
            "saakshi_prober_camera_blur_score",
            "Variance of Laplacian. Spans five orders of magnitude across this estate — do not "
            "scale it linearly.",
            ["component", "camera"],
            registry=target,
        )
        self.luma_mean = Gauge(
            "saakshi_prober_camera_luma_mean",
            "Mean luma. 8 of 30 cameras fail the night-usable threshold on this estate.",
            ["component", "camera"],
            registry=target,
        )
        self.night_usable = Gauge(
            "saakshi_prober_camera_night_usable",
            "1 when the frame is bright enough to be usable at night.",
            ["component", "camera"],
            registry=target,
        )
        self.tamper_score = Gauge(
            "saakshi_prober_camera_tamper_score",
            "Composite tamper score, 0-1, from median frame differencing and edge density.",
            ["component", "camera"],
            registry=target,
        )
        self.pts_drift_ms = Gauge(
            "saakshi_prober_camera_pts_drift_ms",
            "Wall time minus PTS. The meaning label is load-bearing: encoder clock drift on a live "
            "source, pull-rate skew on VOD. Only meaning='live' is worth alerting on.",
            ["component", "camera", "meaning"],
            registry=target,
        )
        self.probe_ms = Gauge(
            "saakshi_prober_camera_probe_ms",
            "Wall time the newest probe of this camera took. 516,783 ms has been observed on a "
            "throttled gateway.",
            ["component", "camera"],
            registry=target,
        )
        self.probe_failed = Gauge(
            "saakshi_prober_camera_probe_failed",
            "Always 1. Present only for a camera whose newest probe failed. retryable='true' means "
            "the failure says nothing about the camera — a timeout, a throttled gateway.",
            ["component", "camera", "retryable"],
            registry=target,
        )
        self.results = Counter(
            "saakshi_prober_results",
            "Probe results recorded, by outcome.",
            ["component", "outcome"],
            registry=target,
        )
        self.pass_duration = Gauge(
            "saakshi_prober_pass_duration_seconds",
            "Wall seconds the last completed sweep took. 1418.5 s (23.6 min) for 30 cameras at "
            "pool 4 is the measured baseline — do not run one before a demo.",
            ["component"],
            registry=target,
        )
        self.pass_cameras = Gauge(
            "saakshi_prober_pass_cameras",
            "Cameras in the last completed sweep.",
            ["component"],
            registry=target,
        )
        self.uptime = Gauge(
            "saakshi_worker_uptime_seconds",
            "Seconds since this worker started.",
            ["component"],
            registry=target,
        )
        self._started_at = time.monotonic()
        self.uptime.labels(COMPONENT).set_function(lambda: time.monotonic() - self._started_at)

    # ── recording ───────────────────────────────────────────────────────────────────────────────

    def record(self, result: ProbeResult) -> None:
        """One probe result, as it lands. Called inside the sweep, not after it."""
        camera = result.external_id
        labels = (COMPONENT, camera)

        self.connectable.labels(*labels).set(1.0 if result.connectable else 0.0)
        self.decodable.labels(*labels).set(1.0 if result.decodable else 0.0)

        fps = result.breakdown.get("fps", {}) if isinstance(result.breakdown, dict) else {}
        declared = fps.get("declared") if isinstance(fps, dict) else None
        if declared is not None:
            self.declared_fps.labels(*labels).set(float(declared))

        if result.measured_fps is None:
            # A NULL is not a zero. No fps sample at all; a marker instead, carrying the reason the
            # prober itself recorded rather than one invented here.
            reason = "unknown"
            if isinstance(fps, dict):
                reason = str(fps.get("unmeasurable_reason") or "unknown")
            self._forget(self.measured_fps, labels)
            self.fps_unmeasurable.labels(*labels, reason).set(1.0)
        else:
            self.measured_fps.labels(*labels).set(float(result.measured_fps))

        if isinstance(fps, dict) and fps.get("diverged") is not None:
            self.fps_diverged.labels(*labels).set(1.0 if fps.get("diverged") else 0.0)

        self._maybe(self.blur_score, labels, result.blur_score)
        self._maybe(self.luma_mean, labels, result.luma_mean)
        self._maybe(self.tamper_score, labels, result.tamper_score)
        if result.night_usable is not None:
            self.night_usable.labels(*labels).set(1.0 if result.night_usable else 0.0)

        if result.pts_drift_ms is not None:
            meaning = "unknown"
            if isinstance(result.breakdown, dict):
                meaning = str(result.breakdown.get("pts_drift_meaning") or "unknown")
            self.pts_drift_ms.labels(*labels, meaning).set(float(result.pts_drift_ms))

        if isinstance(result.breakdown, dict) and result.breakdown.get("probe_ms") is not None:
            self.probe_ms.labels(*labels).set(float(result.breakdown["probe_ms"]))

        if result.error is not None:
            self.probe_failed.labels(*labels, "true" if result.retryable else "false").set(1.0)

        outcome = (
            "decodable"
            if result.decodable
            else "retryable"
            if result.retryable
            else "unreachable"
            if not result.connectable
            else "undecodable"
        )
        self.results.labels(COMPONENT, outcome).inc()

    def record_pass(self, *, cameras: int, duration_s: float) -> None:
        self.pass_cameras.labels(COMPONENT).set(float(cameras))
        self.pass_duration.labels(COMPONENT).set(float(duration_s))

    # ── helpers ─────────────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _maybe(gauge: Gauge, labels: tuple[str, ...], value: object) -> None:
        """Sets a gauge only when there is a value. A missing measurement stays missing."""
        if value is None:
            return
        gauge.labels(*labels).set(float(value))  # type: ignore[arg-type]

    @staticmethod
    def _forget(gauge: Gauge, labels: tuple[str, ...]) -> None:
        """Drops a label set entirely.

        A camera that measured 25 fps last pass and could not be measured this pass must stop
        publishing 25, not keep it: a stale sample is worse than an absent one, because a stale one
        looks healthy.
        """
        try:
            gauge.remove(*labels)
        except KeyError:
            pass


def serve(port: int, registry: CollectorRegistry | None = None) -> ProberMetrics:
    """Builds the metric set and starts the exposition server.

    Failure is logged and swallowed: observability must never be the reason a sweep does not run.
    """
    target = registry if registry is not None else REGISTRY
    metrics = ProberMetrics(target)
    try:
        start_http_server(port, registry=target)
        log.info("metrics on :%d/metrics", port)
    except Exception as exc:  # noqa: BLE001 — never fatal
        log.warning("metrics server did not start on :%d: %s", port, exc)
    return metrics
