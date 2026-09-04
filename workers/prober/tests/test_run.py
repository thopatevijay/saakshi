"""Tests for scope resolution and URL resolution — the two decisions made before any decoding."""

from __future__ import annotations

import pytest

from workers.prober.db import RegistryCamera
from workers.prober.run import stream_url


def camera(**overrides: object) -> RegistryCamera:
    defaults = {
        "id": "00000000-0000-0000-0000-000000000001",
        "external_id": "cam09",
        "name": "09 New Bypass",
        "adapter_kind": "hls",
        "endpoints": {},
        "declared_fps": None,
    }
    defaults.update(overrides)
    return RegistryCamera(**defaults)  # type: ignore[arg-type]


class TestStreamUrlResolution:
    """`GET /api/ingest` is the contract; **the URL pattern is not.**

    A hardcoded template is the single easiest way to fail this project on evaluation day, when the
    organisers change the URL shape and every camera goes dark at once.
    """

    def test_the_registry_endpoint_always_wins(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SENTINEL_HOST", "should-not-be-used.invalid")
        url = stream_url(camera(endpoints={"hls": "https://real.example/x/index.m3u8"}))
        assert url == "https://real.example/x/index.m3u8"

    def test_an_explicit_template_overrides_the_host_default(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The escape hatch for an estate whose URLs look nothing like this sandbox's.
        monkeypatch.setenv("SENTINEL_HOST", "ignored.invalid")
        monkeypatch.setenv("SENTINEL_STREAM_TEMPLATE", "https://vms.gov/api/v2/{external_id}/live")
        assert stream_url(camera()) == "https://vms.gov/api/v2/cam09/live"

    def test_the_host_default_is_the_last_resort(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("SENTINEL_STREAM_TEMPLATE", raising=False)
        monkeypatch.setenv("SENTINEL_HOST", "cctv.example")
        assert stream_url(camera()) == "https://cctv.example/cam09/index.m3u8"

    def test_no_configuration_at_all_returns_none_rather_than_guessing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("SENTINEL_STREAM_TEMPLATE", raising=False)
        monkeypatch.delenv("SENTINEL_HOST", raising=False)
        assert stream_url(camera()) is None

    def test_an_hls_endpoint_is_used_even_when_the_adapter_kind_differs(self) -> None:
        # The sandbox turned out HLS-only regardless of what a department declared its camera to be.
        url = stream_url(camera(adapter_kind="rtsp", endpoints={"hls": "https://h/x.m3u8"}))
        assert url == "https://h/x.m3u8"


def test_a_camera_with_no_url_is_a_configuration_fault_not_a_camera_fault(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """It must not be recorded as an unhealthy camera — nothing was measured about the camera."""
    from workers.prober.run import probe_one
    from workers.prober.thresholds import DEFAULTS

    monkeypatch.delenv("SENTINEL_STREAM_TEMPLATE", raising=False)
    monkeypatch.delenv("SENTINEL_HOST", raising=False)

    result = probe_one(camera(), DEFAULTS, max_wall_s=5.0)

    assert result.connectable is False
    assert result.retryable is False
    assert result.error is not None and "no stream URL" in result.error
    assert result.breakdown["note"] == "configuration, not a camera fault"
