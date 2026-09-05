"""The `evidence` Valkey stream — best-shot crops on their way to the object store.

A **second** stream, deliberately, rather than more fields on `sightings`:

* `sightings` carries ~1 entry per detection per inferred frame and must stay small and fast;
  `evidence` carries ~1 entry per *track session* and each one is a JPEG. Mixing a 200-byte
  high-rate stream with a 20 KB low-rate one gives the bounded stream one trim policy that is wrong
  for both.
* The MinIO credentials live in exactly one place — the API. The worker never holds them, never
  signs a request, and cannot write to the bucket even if it is compromised.
* D2-01 is extending the `sightings` payload with plate reads in the same milestone. Two tickets
  editing one wire format in one wave is a merge conflict with a data-loss failure mode.

Wire contract — D2-06 (alerts) and D3-04 (export bundles) both read what this produces:

    stream key   evidence
    entry        XADD evidence MAXLEN ~ 2000 * payload <json>
    payload      one EvidenceRecord, camelCase, `cameraId` carrying the camera's EXTERNAL id
                 ("cam01") exactly as the `sightings` stream does; `cropBase64` is the JPEG
    group        evidence-writer     (created MKSTREAM by packages/api/src/consumers/evidence.ts)

`MAXLEN ~ 2000` rather than the sightings stream's 200,000: at ~20 KB per entry that is a ~40 MB
ceiling on the broker, and a stopped consumer must not be able to take Valkey down. Best shots
arrive at roughly one per vehicle appearance, so 2,000 is over an hour of the eight-camera estate.

The consumer resolves the record to its `sightings` row by `(camera_id, track_id, frame_pts_ms)` —
which is unique *because* `track_id` is session-qualified. Joining on the raw tracker id would match
two different vehicles across a loop-point cut.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from dataclasses import dataclass
from typing import Protocol

log = logging.getLogger("saakshi.analytics")

STREAM_KEY = "evidence"
CONSUMER_GROUP = "evidence-writer"
#: ~2,000 entries x ~20 KB ≈ 40 MB ceiling on the broker. Bounded on purpose; see the module note.
STREAM_MAXLEN = 2_000
DEFAULT_VALKEY_URL = "redis://localhost:6379"


class EvidenceSink(Protocol):
    """What the pipeline needs. A test substitutes a list; production substitutes Valkey."""

    def publish(self, record: dict) -> None: ...

    def close(self) -> None: ...


def to_record(shot: object) -> dict:
    """One `BestShot` as the wire record.

    Kept as a free function rather than a method so `attributes.py` stays pure CV with no knowledge
    of a broker, and so the payload shape is readable in one place next to the contract above.
    """
    from .attributes import BestShot  # noqa: PLC0415 — avoids a cycle; attributes stays I/O-free

    assert isinstance(shot, BestShot)
    return {
        "cameraId": shot.camera_id,
        "trackId": shot.track_id,
        "ts": shot.ts,
        "framePtsMs": shot.frame_pts_ms,
        "kind": "vehicle",
        "class": shot.vehicle_class,
        "detConfidence": round(float(shot.det_confidence), 3),
        "bbox": shot.bbox,
        "bestShotScore": shot.score,
        "focus": round(float(shot.focus), 2),
        "observations": shot.observations,
        "vehicleType": shot.body,
        # `unknown` when the read was refused — never the runner-up quietly promoted. The consumer
        # writes the name through as-is, so a low-confidence row is visible in SQL rather than
        # indistinguishable from a confident one.
        "vehicleColor": shot.color.name,
        "vehicleColorConfidence": shot.color.confidence,
        "attributesLowConfidence": shot.color.low_confidence,
        "colorChromaShare": shot.color.chroma_share,
        "colorRunnerUp": shot.color.runner_up,
        "contentType": "image/jpeg",
        # Base64 rather than a binary stream field: both clients (redis-py with
        # `decode_responses=True`, ioredis with its default string replies) round-trip text safely
        # and neither round-trips raw bytes without a second code path. The 33% is paid once per
        # track session, not once per sighting.
        "cropBase64": base64.b64encode(shot.crop_jpeg).decode("ascii"),
        "cropBytes": len(shot.crop_jpeg),
    }


@dataclass
class CollectingEvidenceSink:
    """Keeps everything, for tests and for the offline measurement runs."""

    records: list[dict] | None = None

    def __post_init__(self) -> None:
        if self.records is None:
            self.records = []

    def publish(self, record: dict) -> None:
        assert self.records is not None
        self.records.append(record)

    def close(self) -> None:
        return None


@dataclass
class NullEvidenceSink:
    """Counts and discards. Used by `bench.py`, which measures throughput, not persistence."""

    published: int = 0

    def publish(self, record: dict) -> None:
        self.published += 1

    def close(self) -> None:
        return None


def valkey_url() -> str:
    return os.environ.get("VALKEY_URL", DEFAULT_VALKEY_URL)


class ValkeyEvidenceSink:
    """`XADD` to the `evidence` stream.

    Failures are logged and counted, never raised — the same rule the sightings sink follows, for
    the same reason: a broker blip must not kill eight decode threads. An evidence record lost this
    way costs one crop, and the sighting row it belongs to is already safe on the other stream.
    """

    def __init__(self, url: str | None = None, maxlen: int = STREAM_MAXLEN) -> None:
        import redis  # noqa: PLC0415 — deferred; `valkey` speaks the redis protocol

        self._client = redis.Redis.from_url(url or valkey_url(), decode_responses=True)
        self._maxlen = maxlen
        self.published = 0
        self.failed = 0
        self.bytes_published = 0

    def publish(self, record: dict) -> None:
        try:
            self._client.xadd(
                STREAM_KEY,
                {"payload": json.dumps(record, separators=(",", ":"))},
                maxlen=self._maxlen,
                approximate=True,
            )
            self.published += 1
            self.bytes_published += int(record.get("cropBytes", 0))
        except Exception as exc:  # noqa: BLE001 — a broker blip must not kill a decode thread
            self.failed += 1
            if self.failed <= 5:
                log.warning("XADD to %s failed (%s): %s", STREAM_KEY, type(exc).__name__, exc)

    def close(self) -> None:
        try:
            self._client.close()
        except Exception as exc:  # noqa: BLE001
            log.debug("valkey close: %s", exc)
