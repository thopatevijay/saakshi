"""Resolving "which cameras, at which URLs" — from the registry, never from a hardcoded pattern.

`GET /api/ingest` is the contract; the stream URL pattern is not. The registry's `endpoints` value
wins whenever a camera has one; the fallback is configuration (`SENTINEL_STREAM_TEMPLATE`, then
`SENTINEL_HOST`), never a constant compiled into the worker.

That resolution already exists and is already tested as `workers.prober.run.stream_url`, so it is
reused here rather than reimplemented — two copies of a URL rule is how an estate with different
URLs ends up half-working.
"""

from __future__ import annotations

import logging

from workers.prober import db as prober_db
from workers.prober.run import stream_url

from .pipeline import CameraSource

log = logging.getLogger("saakshi.analytics")


def parse_source_override(spec: str) -> CameraSource:
    """`--source cam01=rtsp://127.0.0.1:8554/loop` — an ad-hoc stream with no registry row.

    This is what makes the four RTSP-specific failure modes provable at all: the sandbox serves no
    RTSP, so modes 1, 4, 5 and 8 are demonstrated against local MediaMTX, which has no registry row
    and must not be given one (the registry describes the government estate, not our test rig).
    """
    external_id, separator, url = spec.partition("=")
    if not separator or not external_id or not url:
        raise ValueError(f"--source expects <external_id>=<url>, got {spec!r}")
    return CameraSource(external_id=external_id, url=url)


def from_registry(
    only: list[str] | None = None,
    *,
    limit: int | None = None,
    database_url: str | None = None,
) -> list[CameraSource]:
    """The cameras this worker is assigned, resolved to URLs.

    A camera with no resolvable URL is dropped with a warning rather than failing the run: one
    misconfigured row must not stop the other seven, which is the same rule the prober applies.
    """
    with prober_db.connect(database_url) as conn:
        cameras = prober_db.select_cameras(conn, only=only, limit=limit)

    sources: list[CameraSource] = []
    for camera in cameras:
        url = stream_url(camera)
        if url is None:
            log.warning(
                "%s: no stream URL — registry carries no endpoint and neither "
                "SENTINEL_STREAM_TEMPLATE nor SENTINEL_HOST is configured",
                camera.external_id,
            )
            continue
        sources.append(
            CameraSource(
                external_id=camera.external_id,
                url=url,
                declared_fps=camera.declared_fps,
                camera_uuid=camera.id,
            )
        )
    return sources
