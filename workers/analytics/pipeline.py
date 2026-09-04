"""One camera's frame loop: open, decode, gate, detect, track, publish.

Everything here is **PTS-driven**. `frame_pts_ms` is the presentation timestamp, and the absolute
`ts` is `stream_epoch + pts`, re-anchored on every reconnect. Arrival time is used for exactly two
things, both of which are *measurements of us and of the network* rather than of the video: the
watchdog that separates upstream starvation from our own loop, and the throughput table.

Three inherited findings are load-bearing and are the reason this is not a `cv2.VideoCapture` loop:

- **PyAV surfaces our own deadline as `av.error.ExitError`**, not `TimeoutError` (D1-03/#7). Both are
  *retry later*, never a health verdict. D1-05 recorded a healthy camera as broken by getting this
  wrong.
- **Some PTS deltas on this estate are exactly 0.0** (D1-03/#7). Every divisor is floored at
  `MIN_PTS_DELTA_S`; an unfloored one yields infinite velocity, which reaches D3-02 as an
  impossible-transition alert against a vehicle that did nothing wrong.
- **The gateway replays a buffered GOP on connect** (D1-05/#9). Counting it reads >55 fps against a
  true 25, so the first `BURST_DISCARD_S` of PTS never counts toward a measurement.
"""

from __future__ import annotations

import logging
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable, Iterator

import av
import av.error
import av.logging

from workers.prober.probe import BENIGN_DECODER_WARNINGS

from .bus import SightingSink
from .capabilities import CameraCapabilities, inference_size
from .backoff import backoff_delay_ms
from .detect import Detection
from .motion import MotionGate, SceneCutDetector, thumbnail
from .thresholds import DEFAULTS, AnalyticsThresholds
from .track import SessionTracker

log = logging.getLogger("saakshi.analytics")

#: Seconds of PTS over which `measured_fps` is taken, after the burst discard.
FPS_MEASURE_PTS_S = 20.0
#: Below this many post-burst frames, `measured_fps` stays `None` — *could not measure*, never zero.
MIN_FPS_SAMPLE_FRAMES = 10


@dataclass
class CameraSource:
    """A camera to process. `camera_uuid` is informational — the consumer resolves ids itself."""

    external_id: str
    url: str
    declared_fps: float | None = None
    camera_uuid: str | None = None


@dataclass
class CameraStats:
    """One camera's run. Every field is a measurement; nothing here is declared."""

    external_id: str
    url: str
    connect_s: float | None = None
    connect_attempts: int = 0
    reconnects: int = 0
    frames_decoded: int = 0
    frames_considered: int = 0
    inferences_run: int = 0
    keepalive_inferences: int = 0
    detections: int = 0
    sightings: int = 0
    scene_cuts: int = 0
    sessions: int = 1
    benign_warnings: int = 0
    other_warnings: int = 0
    #: Wall seconds this thread spent blocked in `decode()` — the gateway's time, not ours.
    upstream_wait_s: float = 0.0
    #: Wall seconds this thread spent gating, inferring, tracking and publishing — ours.
    loop_self_time_s: float = 0.0
    #: Longest wall gap between two decoded frames. A stall shows up here, and the `upstream_wait_s`
    #: vs `loop_self_time_s` split says whose stall it was.
    max_interframe_gap_s: float = 0.0
    pts_span_s: float = 0.0
    measured_fps: float | None = None
    resolution: str | None = None
    codec: str | None = None
    imgsz: int | None = None
    errors: list[str] = field(default_factory=list)
    retryable_errors: int = 0

    @property
    def effective_fps(self) -> float | None:
        """Frames actually delivered per wall second — the throughput number, not the stream's rate."""
        wall = self.upstream_wait_s + self.loop_self_time_s
        if wall <= 0 or self.frames_decoded == 0:
            return None
        return round(self.frames_decoded / wall, 2)

    @property
    def skip_ratio(self) -> float:
        if self.frames_considered == 0:
            return 0.0
        return round(1.0 - (self.inferences_run / self.frames_considered), 4)


class _WarningCollector(logging.Handler):
    """Captures libav's chatter. Join-time complaints are recorded, never fatal."""

    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self.benign = 0
        self.other = 0
        self.samples: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        message = record.getMessage()
        if any(known in message for known in BENIGN_DECODER_WARNINGS):
            self.benign += 1
        else:
            self.other += 1
        if len(self.samples) < 10:
            self.samples.append(message)


@contextmanager
def capture_decoder_warnings() -> Iterator[_WarningCollector]:
    """Routes libav's own complaints into a counter for the duration of one session.

    `av.logging.set_level` is **required**, not decorative. PyAV's default level is `None`, and with
    it libav's messages never reach Python's `logging` at all: attaching a handler to the `libav`
    logger and reading zero is exactly what a healthy stream looks like, so the mistake is invisible.
    Measured here on a deliberately corrupted clip that libav complains about six times — the
    handler saw none of them until the level was set.

    Set once and never restored: it is process-global, eight camera threads enter this block
    concurrently, and restoring it from whichever thread happens to exit first would switch logging
    off underneath the other seven.
    """
    if av.logging.get_level() is None:
        av.logging.set_level(av.logging.WARNING)
    collector = _WarningCollector()
    av_log = logging.getLogger("libav")
    av_log.addHandler(collector)
    try:
        yield collector
    finally:
        av_log.removeHandler(collector)


@contextmanager
def opened(
    url: str, options: dict[str, str], timeout_s: float | tuple[float, float]
) -> Iterator[av.container.InputContainer]:
    """Opens a container and **always** closes it.

    The `finally` is the entire mechanism behind "no leaked capture handles over a 20-minute run":
    at eight streams reconnecting on a throttled gateway, a handle leaked per reconnect exhausts the
    descriptor table and surfaces as *unrelated* cameras becoming unreachable.
    """
    container = av.open(url, options=options, timeout=timeout_s)
    try:
        yield container
    finally:
        container.close()


def stream_options(url: str, cookie: str | None, user_agent: str) -> dict[str, str]:
    """libav input options.

    RTSP is forced over TCP (failure mode 1). Over UDP, RTP packets drop silently on a congested
    link: the stream keeps running while frames vanish and the analytics degrade with nothing in any
    log to explain it. The sandbox serves no RTSP at all, which is why this is proven against
    MediaMTX and recorded as such.
    """
    options: dict[str, str] = {"user_agent": user_agent}
    if url.startswith("rtsp://"):
        options["rtsp_transport"] = "tcp"
    if cookie:
        options["headers"] = f"Cookie: {cookie}\r\n"
    return options


def is_retryable(error: BaseException) -> bool:
    """A timeout is *retry later*, never a health verdict.

    `av.error.ExitError` is the one that matters: PyAV implements `timeout=` with libav's interrupt
    callback, so **our own deadline firing** raises `ExitError: Immediate exit requested` and never
    `TimeoutError`. D1-05 caught only the obvious name and wrote down a healthy camera as broken.
    """
    return isinstance(
        error,
        (
            av.error.ExitError,
            av.error.TimeoutError,
            av.error.ConnectionResetError,
            # A half-fetched HLS segment reads as "Invalid data found when processing input". That is
            # the network delivering less than a segment, not the camera being broken — the same
            # class of mistake, one layer down.
            av.error.InvalidDataError,
            OSError,
        ),
    )


DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


class CameraPipeline:
    """One camera, one thread, forever (or until the deadline).

    Reconnects with the 2s->30s ladder and re-anchors the PTS epoch each time, because a reconnect
    replays a buffered GOP and an un-anchored clock would emit timestamps from the past as if they
    were now.
    """

    def __init__(
        self,
        source: CameraSource,
        detector: object,
        sink: SightingSink,
        *,
        thresholds: AnalyticsThresholds = DEFAULTS,
        cookie: str | None = None,
        user_agent: str = DEFAULT_USER_AGENT,
        jitter: float = 0.2,
    ) -> None:
        self.source = source
        self.detector = detector
        self.sink = sink
        self.thresholds = thresholds
        self.cookie = cookie
        self.user_agent = user_agent
        self.jitter = jitter
        self.stats = CameraStats(external_id=source.external_id, url=source.url)
        #: The backoff ladder actually walked, in ms. AC 4's evidence.
        self.backoff_ladder_ms: list[int] = []
        # One gate and one cut detector for the life of the camera, `reset()` between sessions.
        # Their counters are the run's skip ratio and cut count, so they must survive a reconnect
        # even though their *state* must not: the scene after a reconnect is a different scene.
        self._gate = MotionGate(thresholds=thresholds)
        self._cuts = SceneCutDetector(thresholds=thresholds)
        self._tracker: SessionTracker | None = None
        #: `on_open` fires once per camera, not once per reconnect — the run's connect count is
        #: "how many cameras came up", and a camera that reconnects twice is still one camera.
        self._announced = False

    # ── the loop ────────────────────────────────────────────────────────────────────────────────

    def run(
        self,
        stop: threading.Event,
        deadline_at: float | None = None,
        *,
        on_open: Callable[[], None] | None = None,
        start_gate: threading.Event | None = None,
        gate_timeout_s: float = 0.0,
        max_sessions: int | None = None,
    ) -> CameraStats:
        """Decode until `stop` is set or `deadline_at` (a `time.monotonic()` value) passes.

        `max_sessions` bounds the number of connect-to-disconnect cycles. A live camera never uses
        it; a finite file does, because "reconnect forever" against a four-second clip is a test that
        never ends.
        """
        attempt = 0
        sessions = 0
        while not stop.is_set() and (deadline_at is None or time.monotonic() < deadline_at):
            if max_sessions is not None and sessions >= max_sessions:
                break
            sessions += 1
            try:
                self._session(
                    stop, deadline_at, on_open=on_open, start_gate=start_gate,
                    gate_timeout_s=gate_timeout_s,
                )
                on_open = None  # only the first successful open opens the gate
                attempt = 0
            except Exception as exc:  # noqa: BLE001 — a camera never takes the worker down
                retryable = is_retryable(exc)
                self.stats.retryable_errors += int(retryable)
                if len(self.stats.errors) < 20:
                    self.stats.errors.append(f"{type(exc).__name__}: {exc}")
                delay_ms = backoff_delay_ms(attempt, self.jitter)
                self.backoff_ladder_ms.append(delay_ms)
                self.stats.reconnects += 1
                attempt += 1
                log.warning(
                    "%s: %s (%s) — reconnect in %d ms (attempt %d)",
                    self.source.external_id,
                    type(exc).__name__,
                    "retryable" if retryable else "non-retryable",
                    delay_ms,
                    attempt,
                )
                if stop.wait(delay_ms / 1000.0):
                    break
            else:
                # A clean end of stream (VOD ends rather than loops) is also a reconnect.
                if stop.is_set() or (deadline_at is not None and time.monotonic() >= deadline_at):
                    break
                delay_ms = backoff_delay_ms(attempt, self.jitter)
                self.backoff_ladder_ms.append(delay_ms)
                self.stats.reconnects += 1
                attempt += 1
                log.info(
                    "%s: stream ended — reopening in %d ms", self.source.external_id, delay_ms
                )
                if stop.wait(delay_ms / 1000.0):
                    break

        return self.stats

    def _session(
        self,
        stop: threading.Event,
        deadline_at: float | None,
        *,
        on_open: Callable[[], None] | None,
        start_gate: threading.Event | None,
        gate_timeout_s: float,
    ) -> None:
        """One connect-to-disconnect session. Raises on anything that warrants a reconnect."""
        options = stream_options(self.source.url, self.cookie, self.user_agent)
        self.stats.connect_attempts += 1
        connect_started = time.monotonic()

        # The warning counts are folded into `stats` in the `finally` below rather than after the
        # `with`: a session that ends by raising is exactly the session whose decoder warnings
        # matter most, and accumulating them only on the clean path threw every warning that
        # preceded a reconnect away.
        with capture_decoder_warnings() as warnings_seen:
          try:
            # `(open, read)`: the open deadline is sized for a gateway that has taken 516 s on a
            # single probe; the read deadline is what lets a stopped worker leave the decode call
            # rather than block until the next frame that may never come.
            with opened(
                self.source.url,
                options,
                (self.thresholds.open_timeout_s, self.thresholds.read_timeout_s),
            ) as container:
                if self.stats.connect_s is None:
                    self.stats.connect_s = round(time.monotonic() - connect_started, 2)

                stream = container.streams.video[0]
                # Per-camera decoder shape from the container's own header — never a fixed batch.
                # `thread_type='AUTO'` lets libav use frame threading, which is what makes eight
                # concurrent 1080p decodes affordable on one machine.
                stream.thread_type = "AUTO"
                capabilities = self._capabilities(stream)
                self.stats.resolution = capabilities.resolution
                self.stats.codec = capabilities.codec
                self.stats.imgsz = inference_size(capabilities, self.thresholds)

                if on_open is not None and not self._announced:
                    self._announced = True
                    on_open()
                if start_gate is not None and not start_gate.is_set():
                    # Hold here so every camera starts its measured window together. The container
                    # stays open; libav is pull-based, so nothing is fetched while we wait.
                    start_gate.wait(gate_timeout_s)

                self._decode(container, stream, capabilities, stop, deadline_at)
          finally:
            self.stats.benign_warnings += warnings_seen.benign
            self.stats.other_warnings += warnings_seen.other
            if warnings_seen.samples:
                log.info(
                    "%s: %d benign / %d other decoder warnings — logged, never fatal, e.g. %s",
                    self.source.external_id,
                    warnings_seen.benign,
                    warnings_seen.other,
                    warnings_seen.samples[0][:120],
                )

    def _capabilities(self, stream: av.video.stream.VideoStream) -> CameraCapabilities:
        ctx = stream.codec_context
        declared = self.source.declared_fps
        if declared is None and stream.average_rate:
            declared = float(stream.average_rate)
        return CameraCapabilities(
            width=int(ctx.width or 0) or 640,
            height=int(ctx.height or 0) or 480,
            codec=str(ctx.name or "unknown"),
            declared_fps=declared,
            measured_fps=self.stats.measured_fps,
        )

    def _decode(
        self,
        container: av.container.InputContainer,
        stream: av.video.stream.VideoStream,
        capabilities: CameraCapabilities,
        stop: threading.Event,
        deadline_at: float | None,
    ) -> None:
        gate, cuts = self._gate, self._cuts
        gate.reset()
        cuts.reset()
        if self._tracker is None:
            self._tracker = SessionTracker(capabilities.effective_fps, thresholds=self.thresholds)
        else:
            # A reconnect replays a buffered GOP: the frames that follow are not a continuation of
            # the ones before, so identity must not bleed across it any more than across a cut.
            self.stats.sessions = self._tracker.new_session() + 1
        tracker = self._tracker

        time_base = float(stream.time_base) if stream.time_base else 1 / 90_000
        epoch: datetime | None = None
        first_pts_s: float | None = None
        last_pts_s: float | None = None
        # Frames counted for `measured_fps`: post-burst only, so the replayed GOP cannot inflate it.
        window_first_pts: float | None = None
        window_frames = 0

        last_frame_wall = time.monotonic()
        frames = container.decode(stream)
        ended = False

        try:
          while True:
            if stop.is_set() or (deadline_at is not None and time.monotonic() >= deadline_at):
                break

            wait_started = time.monotonic()
            try:
                frame = next(frames)
            except StopIteration:
                ended = True
                break
            finally:
                self.stats.upstream_wait_s += time.monotonic() - wait_started

            work_started = time.monotonic()
            gap = work_started - last_frame_wall
            if gap > self.stats.max_interframe_gap_s:
                self.stats.max_interframe_gap_s = round(gap, 2)
            if gap > self.thresholds.stall_warn_s:
                log.warning(
                    "%s: %.1f s without a frame — upstream starvation, not our loop "
                    "(self %.1f s vs upstream %.1f s so far)",
                    self.source.external_id, gap, self.stats.loop_self_time_s,
                    self.stats.upstream_wait_s,
                )
            last_frame_wall = work_started

            if frame.pts is None:
                self.stats.loop_self_time_s += time.monotonic() - work_started
                continue

            pts_s = float(frame.pts) * time_base
            self.stats.frames_decoded += 1

            if first_pts_s is None:
                first_pts_s = pts_s
                # The epoch: wall clock now, minus this frame's own PTS. Every subsequent `ts` is
                # `epoch + pts`, so timing is the stream's, not our read loop's. Re-anchored on each
                # reconnect because the gateway replays a buffered GOP.
                epoch = datetime.now(timezone.utc) - timedelta(seconds=pts_s)
            last_pts_s = pts_s

            in_burst = (pts_s - first_pts_s) < self.thresholds.burst_discard_s
            if not in_burst:
                if window_first_pts is None:
                    window_first_pts = pts_s
                window_frames += 1

            try:
                self._process(
                    frame, pts_s, epoch, gate, cuts, tracker, capabilities, in_burst=in_burst
                )
            finally:
                self.stats.loop_self_time_s += time.monotonic() - work_started
        finally:
            # Always, not only on a clean end of stream: the deadline and the stop signal are the
            # normal ways a session ends, and a measurement that only exists when the feed ran out
            # is a measurement the gate run would never see.
            self._finish(first_pts_s, last_pts_s, window_first_pts, window_frames)
            if ended:
                log.debug("%s: end of stream after %.1f s of PTS",
                          self.source.external_id, self.stats.pts_span_s)

    def _process(
        self,
        frame: av.video.frame.VideoFrame,
        pts_s: float,
        epoch: datetime | None,
        gate: MotionGate,
        cuts: SceneCutDetector,
        tracker: SessionTracker,
        capabilities: CameraCapabilities,
        *,
        in_burst: bool,
    ) -> None:
        image = frame.to_ndarray(format="bgr24")
        thumb = thumbnail(image, self.thresholds.motion_grey_width)

        if cuts.update(thumb):
            # The loop point. Identity must not bleed across it: the tracker starts a new session,
            # so every id emitted afterwards lives in a different `track_id` band by construction.
            session = tracker.new_session()
            gate.reset()
            self.stats.sessions = session + 1
            log.info(
                "%s: scene cut at pts %.2fs (diff %.1f vs median %s) — tracking session %d",
                self.source.external_id, pts_s, cuts.last_diff or 0.0,
                f"{cuts.last_median:.1f}" if cuts.last_median is not None else "n/a", session,
            )

        # The connect burst is decoded (the cut detector and the tracker need continuity) but never
        # inferred and never published: those frames are a replay, not the camera's present.
        if in_burst or epoch is None:
            return

        if not gate.should_infer(thumb, pts_s):
            self.stats.frames_considered = gate.frames_considered
            return

        detections: list[Detection] = self.detector.infer(image, capabilities)  # type: ignore[attr-defined]
        self.stats.detections += len(detections)
        tracked = tracker.update(detections)

        ts = epoch + timedelta(seconds=pts_s)
        for item in tracked:
            self.sink.publish(
                {
                    "cameraId": self.source.external_id,
                    "ts": ts.isoformat().replace("+00:00", "Z"),
                    "framePtsMs": int(round(pts_s * 1000.0)),
                    "trackId": item.track_id,
                    "class": item.vehicle_class,
                    "bbox": {
                        "x": round(item.x, 2),
                        "y": round(item.y, 2),
                        "w": round(item.w, 2),
                        "h": round(item.h, 2),
                    },
                    "detConfidence": round(item.confidence, 3),
                }
            )
            self.stats.sightings += 1

        self.stats.frames_considered = gate.frames_considered
        self.stats.inferences_run = gate.inferences_run
        self.stats.keepalive_inferences = gate.keepalive_inferences

    def _finish(
        self,
        first_pts_s: float | None,
        last_pts_s: float | None,
        window_first_pts: float | None,
        window_frames: int,
    ) -> None:
        self.stats.frames_considered = self._gate.frames_considered
        self.stats.inferences_run = self._gate.inferences_run
        self.stats.keepalive_inferences = self._gate.keepalive_inferences
        self.stats.scene_cuts = self._cuts.cuts
        if first_pts_s is not None and last_pts_s is not None:
            self.stats.pts_span_s += round(max(0.0, last_pts_s - first_pts_s), 2)
        fps = measured_fps(window_first_pts, last_pts_s, window_frames, self.thresholds)
        # `None` means *could not measure*, never zero — so a later throttled session must not erase
        # a rate an earlier one did manage to measure.
        if fps is not None:
            self.stats.measured_fps = fps


def measured_fps(
    window_first_pts: float | None,
    last_pts_s: float | None,
    window_frames: int,
    thresholds: AnalyticsThresholds = DEFAULTS,
) -> float | None:
    """Frames per second of **PTS**, measured after the burst discard.

    `None` means *could not measure*, never zero — D1-05's finding, and the reason a throttled
    gateway does not get recorded as a broken camera. The divisor is floored at `MIN_PTS_DELTA_S`
    because this estate really does produce PTS deltas of exactly 0.0 (D1-03).
    """
    if window_first_pts is None or last_pts_s is None or window_frames < MIN_FPS_SAMPLE_FRAMES:
        return None
    span = max(last_pts_s - window_first_pts, thresholds.min_pts_delta_s)
    return round(window_frames / span, 2)
