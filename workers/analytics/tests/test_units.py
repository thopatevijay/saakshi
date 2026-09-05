"""The pure units: device selection, the backoff ladder, per-camera inference shape, `measured_fps`.

Nothing here touches a network or a decoder. They are the pieces whose failure modes were paid for
by earlier tickets, so each test names the finding it protects.
"""

from __future__ import annotations

import base64
import inspect
import types

import numpy as np
import pytest

from workers.analytics.anpr.engine import PlateEvidence
from workers.analytics.backoff import backoff_delay_ms, backoff_sequence_ms
from workers.analytics.capabilities import CameraCapabilities, inference_size
from workers.analytics.device import select_device
from workers.analytics.evidence import to_plate_record, to_record
from workers.analytics.pipeline import measured_fps
from workers.analytics.thresholds import DEFAULTS


# ── Backoff: AC 4's first half ──────────────────────────────────────────────────────────────────

def test_the_backoff_ladder_is_2s_doubling_to_a_30s_cap() -> None:
    assert backoff_sequence_ms(6) == [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]


def test_the_ladder_matches_the_typescript_adapter_exactly() -> None:
    """`packages/api/src/adapters/backoff.ts` is the same sequence.

    Two workers hitting one government gateway at different rates is still one integrator's IP; the
    numbers agreeing is the point, so they are asserted rather than assumed.
    """
    assert [backoff_delay_ms(i) for i in range(4)] == [2_000, 4_000, 8_000, 16_000]


def test_jitter_only_ever_reduces_the_delay_so_the_cap_holds() -> None:
    for attempt in range(8):
        for _ in range(50):
            assert backoff_delay_ms(attempt, jitter=1.0) <= backoff_delay_ms(attempt)
            assert backoff_delay_ms(attempt, jitter=0.2) <= 30_000


# ── Device: MPS here, CUDA by monkeypatch ───────────────────────────────────────────────────────

def _torch(cuda: bool, mps: bool) -> types.SimpleNamespace:
    return types.SimpleNamespace(
        cuda=types.SimpleNamespace(is_available=lambda: cuda),
        backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: mps)),
    )


def test_cuda_wins_when_both_are_available() -> None:
    device = select_device(torch_module=_torch(cuda=True, mps=True))
    assert device.name == "cuda"
    assert device.half_precision is True


def test_mps_is_chosen_on_apple_silicon_and_does_not_claim_fp16() -> None:
    """`half=True` on MPS silently falls back to FP32 on some torch builds.

    A bench table that says FP16 while FP32 ran is a number that describes nothing.
    """
    device = select_device(torch_module=_torch(cuda=False, mps=True))
    assert device.name == "mps"
    assert device.half_precision is False


def test_cpu_is_the_floor_not_a_failure() -> None:
    assert select_device(torch_module=_torch(cuda=False, mps=False)).name == "cpu"


def test_the_device_can_be_forced_for_a_shared_gpu_box() -> None:
    device = select_device("cpu")
    assert device.name == "cpu" and device.forced is True


def test_an_unknown_forced_device_fails_loudly() -> None:
    with pytest.raises(ValueError, match="unknown device"):
        select_device("tpu")


# ── Per-camera inference shape: AC 6 ────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("width", "height", "expected"),
    [
        (640, 480, 640),      # a small camera infers at its own size
        (854, 480, 864),      # rounded to YOLO's stride of 32, explicitly rather than silently
        (1920, 1080, 960),    # clamped: 1080p on eight streams is an order of magnitude more compute
        (1280, 960, 960),
        (320, 240, 320),      # floor
    ],
)
def test_inference_size_follows_each_camera_rather_than_a_fixed_batch(
    width: int, height: int, expected: int
) -> None:
    """D0-01 measured six distinct resolutions across 30 cameras.

    One fixed shape would either waste compute on the small cameras or throw away half the pixels of
    the large ones, which is why failure mode 7 names per-camera batch shape explicitly.
    """
    assert inference_size(CameraCapabilities(width, height, "h264")) == expected


def test_two_different_cameras_get_two_different_shapes() -> None:
    small = inference_size(CameraCapabilities(640, 480, "h264"))
    large = inference_size(CameraCapabilities(1920, 1080, "hevc"))
    assert small != large


def test_effective_fps_prefers_the_measured_rate_over_the_declared_one() -> None:
    """`cam01` declares 30 and measures 15.4. Never trust `CAP_PROP_FPS`."""
    caps = CameraCapabilities(1920, 1080, "h264", declared_fps=30.0, measured_fps=15.4)
    assert caps.effective_fps == 15.4


def test_effective_fps_falls_back_rather_than_refusing_to_track() -> None:
    caps = CameraCapabilities(1920, 1080, "h264", declared_fps=None, measured_fps=None)
    assert caps.effective_fps == 25.0


# ── measured_fps: D1-05's "None means could not measure, never zero" ─────────────────────────────

def test_measured_fps_is_none_when_too_few_frames_arrived_to_measure() -> None:
    assert measured_fps(0.0, 5.0, 3) is None


def test_measured_fps_divides_by_a_floored_span_so_a_zero_delta_cannot_produce_infinity() -> None:
    """This estate really does produce PTS deltas of exactly 0.0 (D1-03 / #7).

    An unfloored divisor yields infinite velocity, which reaches D3-02 as an impossible-transition
    alert against a vehicle that did nothing wrong.
    """
    value = measured_fps(10.0, 10.0, 25)
    assert value is not None
    assert value == pytest.approx(25 / DEFAULTS.min_pts_delta_s)


def test_measured_fps_over_a_clean_window_is_the_stream_rate() -> None:
    assert measured_fps(2.0, 22.0, 500) == 25.0


# ── D2-11: the plate crop's wire record ─────────────────────────────────────────────────────────

def _plate_evidence() -> PlateEvidence:
    return PlateEvidence(
        camera_external_id="cam06",
        track_id=100_007,
        ts="2026-09-05T04:30:00Z",
        frame_pts_ms=37_280,
        vehicle_class="car",
        det_confidence=0.6123,
        bbox={"x": 42.5, "y": 61.25, "w": 96.0, "h": 31.0},
        score=0.41371,
        focus=184.6234,
        observations=5,
        crop=np.full((32, 96, 3), 127, dtype=np.uint8),
    )


def test_a_plate_record_carries_the_same_wire_shape_as_a_vehicle_record() -> None:
    """One `EvidenceRecord`, one consumer, one uploader.

    D2-02's consumer validates every entry on the `evidence` stream against one zod schema. If the
    plate builder ever grows or loses a field relative to the vehicle builder, every plate crop is
    counted `invalidPayloads` and silently dropped — the alert reverts to "no crop stored" and
    nothing says why. Asserting the key sets are identical is what makes that drift a test failure.
    """
    record = to_plate_record(_plate_evidence())
    vehicle_keys = {
        line.strip().split('"')[1]
        for line in inspect.getsource(to_record).splitlines()
        if line.strip().startswith('"') and '":' in line
    }
    assert vehicle_keys, "could not read to_record's wire keys"
    assert set(record) == vehicle_keys


def test_a_plate_record_is_kind_plate_and_claims_no_colour_it_did_not_measure() -> None:
    """A plate crop has had no colour classifier over it. `unknown` with the flag set is the honest
    value for a measurement nobody made — and the consumer's plate branch writes none of them, so a
    plate crop can never erase a vehicle crop's real colour read.
    """
    record = to_plate_record(_plate_evidence())
    assert record["kind"] == "plate"
    assert record["vehicleColor"] == "unknown"
    assert record["vehicleColorConfidence"] == 0.0
    assert record["attributesLowConfidence"] is True
    assert record["vehicleType"] is None
    # The tuple the consumer matches on to find the `plate_reads` row.
    assert record["cameraId"] == "cam06"
    assert record["trackId"] == 100_007
    assert record["framePtsMs"] == 37_280
    # Within the schema's bounds: `bestShotScore` is 0..1 and `detConfidence` is 0..1, and a value
    # outside either is dropped by the consumer as an invalid payload.
    assert 0.0 <= record["bestShotScore"] <= 1.0
    assert 0.0 <= record["detConfidence"] <= 1.0
    # A real JPEG, base64'd, and the byte count agrees with it.
    decoded = base64.b64decode(record["cropBase64"])
    assert decoded[:2] == b"\xff\xd8"
    assert len(decoded) == record["cropBytes"]
