"""Opening a camera, decoding it, and turning it into signals.

Three rules from D1-03's handoff are load-bearing here and are the reason this file is not simply
`cv2.VideoCapture`:

1. **All timing from PTS.** OpenCV's `VideoCapture` gives frames but not reliable presentation
   timestamps, and `CAP_PROP_FPS` reports the container header — the exact value the organisers'
   guide warns is a lie. PyAV exposes `frame.pts` and the stream `time_base`, so the measurement is
   of the stream rather than of our own read loop.
2. **A probe never raises.** `health()` reports; it does not throw. A sweep of 80,000 cameras that
   aborts on the first unreachable one is not a sweep.
3. **A timeout is "retry later", never "unhealthy".** D1-03 made that mistake once and it condemned
   healthy cameras; closing D1-03 reproduced it — the same camera measured "unknown" over a 517 s
   probe and 20 fps over an 86 s one.
"""

from __future__ import annotations

import logging
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Iterator

import av
import av.error
import numpy as np

from . import signals
from .thresholds import Thresholds, DEFAULTS

log = logging.getLogger("saakshi.prober")

#: Join-time decoder complaints that are normal on this estate and must never fail a probe.
#:
#: Connecting mid-GOP means the first frames reference an IDR we never received. libav says so,
#: loudly, and then recovers at the next keyframe. D0-01 saw these on healthy cameras; treating them
#: as failures would mark the whole estate broken.
BENIGN_DECODER_WARNINGS = (
    "Error constructing the frame RPS",
    "Could not find ref with POC",
    "missing picture in access unit",
    "no frame!",
    "non-existing PPS",
    "decode_slice_header error",
    "Increasing reorder buffer",
)


@dataclass
class ProbeResult:
    """One camera, one pass. Mirrors the `camera_health_checks` row it becomes."""

    external_id: str
    connectable: bool
    decodable: bool
    measured_fps: float | None = None
    actual_resolution: str | None = None
    actual_codec: str | None = None
    blur_score: float | None = None
    luma_mean: float | None = None
    night_usable: bool | None = None
    tamper_score: float | None = None
    pts_drift_ms: int | None = None
    #: Measurement provenance. `trust_score` belongs to D1-06; this is what lets it calibrate
    #: against real data rather than invented weights, and lets the UI explain the number.
    breakdown: dict = field(default_factory=dict)
    error: str | None = None
    #: True when the probe failed for a reason that says nothing about the camera — a timeout, a
    #: throttled gateway. D1-06 must treat this as "unknown", never as "unhealthy".
    retryable: bool = False


class _WarningCollector(logging.Handler):
    """Captures libav's chatter so join-time warnings are recorded rather than printed and lost."""

    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


@contextmanager
def _capture_decoder_warnings() -> Iterator[_WarningCollector]:
    collector = _WarningCollector()
    av_log = logging.getLogger("libav")
    av_log.addHandler(collector)
    try:
        yield collector
    finally:
        av_log.removeHandler(collector)


@contextmanager
def _opened(url: str, options: dict[str, str], timeout_s: float) -> Iterator[av.container.InputContainer]:
    """Opens a container and **always** closes it.

    The AC says "without a leaked capture handle". A `finally: close()` is the whole mechanism: at
    80,000 cameras a handle leaked once per probe exhausts the file-descriptor table long before the
    sweep finishes, and the failure surfaces as unrelated cameras being unreachable.
    """
    container = av.open(url, options=options, timeout=timeout_s)
    try:
        yield container
    finally:
        container.close()


def stream_options(cookie: str | None, user_agent: str) -> dict[str, str]:
    """ffmpeg/libav input options for the sandbox gateway.

    Both were established by recon (D0-01), not guessed: Cloudflare 403s a default programmatic
    user-agent, and the session cookie is required on the playlist, the AES key **and** every
    segment. Miss either and the stream is empty while the camera is fine.
    """
    options = {"user_agent": user_agent}
    if cookie:
        options["headers"] = f"Cookie: {cookie}\r\n"
    return options


def probe_camera(
    external_id: str,
    url: str,
    *,
    declared_fps: float | None = None,
    cookie: str | None = None,
    user_agent: str = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128"
    ),
    thresholds: Thresholds = DEFAULTS,
    # 120 s, not 60. The gateway throttles ~10x under sustained use (D1-03), and a full probe of a
    # healthy camera measured 85 s today. A 60 s open deadline was timing out cameras that D0-01
    # confirmed decodable — the deadline has to be sized for the bad case, not the good one.
    open_timeout_s: float = 120.0,
    max_wall_s: float = 180.0,
    is_vod_hint: bool | None = None,
) -> ProbeResult:
    """Probes one camera and returns its signals. Never raises."""
    started = time.monotonic()
    options = stream_options(cookie, user_agent)

    with _capture_decoder_warnings() as warnings:
        try:
            with _opened(url, options, open_timeout_s) as container:
                return _probe_open_container(
                    container,
                    external_id=external_id,
                    declared_fps=declared_fps,
                    thresholds=thresholds,
                    started=started,
                    max_wall_s=max_wall_s,
                    warnings=warnings,
                    is_vod_hint=is_vod_hint,
                )
        except (av.error.HTTPUnauthorizedError, av.error.HTTPForbiddenError) as exc:
            # Auth, not health. The camera may be perfectly fine behind an expired cookie, and
            # dispatching a technician for it wastes somebody's day.
            return ProbeResult(
                external_id,
                connectable=True,
                decodable=False,
                error=f"auth rejected by the gateway: {exc}",
                retryable=False,
                breakdown=_provenance(started, warnings, note="refresh the session cookie"),
            )
        except (av.error.TimeoutError, av.error.ExitError, TimeoutError) as exc:
            # `ExitError` is **our own** timeout firing, not a camera fault.
            #
            # PyAV implements `timeout=` with libav's interrupt callback, and an interrupted open
            # surfaces as `ExitError: Immediate exit requested`, never as `TimeoutError`. Catching
            # only the obvious name recorded `cam06` — which D0-01 confirmed decodable — as a
            # non-retryable failure after 60,067 ms. That is precisely the mistake D1-03's handoff
            # warned about ("treat TimeoutError as 'retry later', never as a health failure"),
            # wearing a different exception class.
            return ProbeResult(
                external_id,
                connectable=False,
                decodable=False,
                error=f"timed out after {open_timeout_s:.0f}s: {type(exc).__name__}: {exc}",
                retryable=True,
                breakdown=_provenance(
                    started, warnings, note="retry later — says nothing about the camera"
                ),
            )
        except av.error.FFmpegError as exc:
            return ProbeResult(
                external_id,
                connectable=False,
                decodable=False,
                error=f"{type(exc).__name__}: {exc}",
                retryable=False,
                breakdown=_provenance(started, warnings),
            )
        except OSError as exc:
            return ProbeResult(
                external_id,
                connectable=False,
                decodable=False,
                error=f"{type(exc).__name__}: {exc}",
                retryable=True,
                breakdown=_provenance(started, warnings, note="network-level failure"),
            )


def _probe_open_container(
    container: av.container.InputContainer,
    *,
    external_id: str,
    declared_fps: float | None,
    thresholds: Thresholds,
    started: float,
    max_wall_s: float,
    warnings: _WarningCollector,
    is_vod_hint: bool | None,
) -> ProbeResult:
    video = next((s for s in container.streams if s.type == "video"), None)
    if video is None:
        return ProbeResult(
            external_id,
            connectable=True,
            decodable=False,
            error="container opened but carries no video stream",
            breakdown=_provenance(started, warnings),
        )

    codec = video.codec_context.name if video.codec_context else None
    time_base = float(video.time_base) if video.time_base else None

    pts_seconds: list[float] = []
    frames: list[np.ndarray] = []
    width: int | None = None
    height: int | None = None
    first_frame_wall: float | None = None
    last_frame_wall: float | None = None
    window_end: float | None = None
    last_kept_pts: float | None = None

    # Frames kept for the CV signals, spread evenly across the whole window rather than taken as
    # the first N decoded.
    #
    # Keeping the first N is the obvious implementation and it is wrong: at 15 fps the first 36
    # frames all fall inside the ~2 s connect burst, so `tamper_score` — which the ticket specifies
    # as **long-window** frame differencing — would be computed over two seconds of replayed GOP.
    # A camera covered five seconds after connect would score perfectly healthy.
    frame_budget = thresholds.tamper_sample_pairs * 3
    keep_every_s = (thresholds.burst_discard_s + thresholds.fps_window_s) / frame_budget

    for frame in container.decode(video=0):
        now = time.monotonic()
        if first_frame_wall is None:
            first_frame_wall = now
        last_frame_wall = now

        if frame.pts is not None and time_base is not None:
            pts = frame.pts * time_base
            pts_seconds.append(pts)
            if window_end is None:
                # The window opens at the first PTS and runs for the burst discard plus the
                # measurement window — the discarded burst is *extra*, not taken out of the window.
                window_end = pts + thresholds.burst_discard_s + thresholds.fps_window_s
            elif pts >= window_end:
                break

        if width is None:
            width, height = frame.width, frame.height

        # Subsampled by PTS, so the kept frames span the window instead of clustering at its start,
        # and a 30 s window never holds hundreds of 1080p arrays at once — at 80,000 cameras the
        # sweep's memory is a real constraint.
        frame_pts = (frame.pts * time_base) if (frame.pts is not None and time_base) else None
        if len(frames) < frame_budget and (
            frame_pts is None
            or last_kept_pts is None
            or (frame_pts - last_kept_pts) >= keep_every_s
        ):
            frames.append(frame.to_ndarray(format="bgr24"))
            last_kept_pts = frame_pts

        if now - started > max_wall_s:
            # Wall-clock backstop. Not a health verdict — the gateway throttles ~10x under sustained
            # use (D1-03), and a sweep that hangs on one slow camera never reaches the other 29.
            break

    if not pts_seconds and not frames:
        return ProbeResult(
            external_id,
            connectable=True,
            decodable=False,
            actual_codec=codec,
            error="opened but decoded no frames",
            retryable=True,
            breakdown=_provenance(started, warnings, note="upstream delivered nothing in the window"),
        )

    fps = signals.measure_fps(pts_seconds, thresholds)
    blur = signals.blur_score(frames, thresholds)
    luma = signals.luma_mean(frames)
    tamper = signals.tamper_score(frames, thresholds)
    divergence, diverged = signals.fps_divergence(declared_fps, fps.fps, thresholds)

    wall_span = (last_frame_wall - first_frame_wall) if (first_frame_wall and last_frame_wall) else 0.0
    drift = signals.pts_drift_ms(fps.pts_span_s, wall_span) if fps.pts_span_s > 0 else None

    is_vod = is_vod_hint if is_vod_hint is not None else _looks_vod(container)

    breakdown = _provenance(started, warnings)
    breakdown.update(
        {
            "fps": {
                "measured": fps.fps,
                "declared": declared_fps,
                "divergence_fraction": divergence,
                "diverged": diverged,
                "frames_counted": fps.frames_counted,
                "frames_discarded_as_connect_burst": fps.frames_discarded,
                "pts_span_s": fps.pts_span_s,
                "window_s": thresholds.fps_window_s,
                "burst_discard_s": thresholds.burst_discard_s,
                "unmeasurable_reason": fps.reason,
            },
            "tamper": None
            if tamper is None
            else {
                "score": tamper.score,
                "flagged": tamper.flagged,
                "median_frame_diff": tamper.median_frame_diff,
                "median_edge_density": tamper.median_edge_density,
                # Kept so a loop-point scene cut stays visible in the record even though the median
                # statistics deliberately do not let it vote.
                "max_frame_diff": tamper.max_frame_diff,
                "pairs_sampled": tamper.pairs_sampled,
                # The PTS span the tamper statistic actually covered. "Long-window" is a claim;
                # this is the number that supports or refutes it for a given row.
                "sampled_pts_span_s": round(
                    0.0 if last_kept_pts is None or not pts_seconds else last_kept_pts - min(pts_seconds),
                    3,
                ),
            },
            "light": {
                "luma_mean": luma,
                "blur_score": blur,
                "night_usable": signals.night_usable(luma, blur, thresholds),
            },
            "pts_drift_meaning": (
                # Measured on the real estate: cam01 +2,400 ms and cam12 +98,780 ms for ~10 s of
                # content. Positive, and large — we pulled the recording *slower* than real time,
                # because the gateway throttles. Calling that a clock fault would condemn the whole
                # estate for the network's behaviour.
                "vod_pull_rate_skew — the sign is the direction: positive means the file arrived "
                "slower than real time (a throttled upstream), negative means faster. Either way "
                "this is a property of the network, not of the camera's clock. Do not score it."
                if is_vod
                else "live_clock_drift — encoder clock against wall clock. Score it: a wrong clock "
                "corrupts every route reconstruction this camera contributes to."
            ),
            "source_is_vod": is_vod,
            "wall_span_s": round(wall_span, 3),
        }
    )

    return ProbeResult(
        external_id=external_id,
        connectable=True,
        decodable=True,
        measured_fps=fps.fps,
        actual_resolution=None if width is None or height is None else f"{width}x{height}",
        actual_codec=codec,
        blur_score=blur,
        luma_mean=luma,
        night_usable=signals.night_usable(luma, blur, thresholds),
        tamper_score=None if tamper is None else tamper.score,
        pts_drift_ms=drift,
        breakdown=breakdown,
    )


def _looks_vod(container: av.container.InputContainer) -> bool:
    """A finite duration means a recording, not a live camera.

    It decides only how `pts_drift_ms` is *interpreted*, never whether the camera is healthy.
    """
    try:
        return container.duration is not None and container.duration > 0
    except (AttributeError, av.error.FFmpegError):
        return False


def _provenance(started: float, warnings: _WarningCollector, note: str | None = None) -> dict:
    benign, unexpected = [], []
    for message in warnings.messages:
        (benign if any(w in message for w in BENIGN_DECODER_WARNINGS) else unexpected).append(message)

    provenance: dict = {
        "probe_ms": int((time.monotonic() - started) * 1000),
        # Logged, never fatal. Connecting mid-GOP always produces these on this estate.
        "decoder_warnings_benign": benign[:10],
        "decoder_warnings_benign_count": len(benign),
        "decoder_warnings_unexpected": unexpected[:10],
    }
    if note:
        provenance["note"] = note
    return provenance
