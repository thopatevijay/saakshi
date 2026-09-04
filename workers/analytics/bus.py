"""The Valkey `sightings` stream — the worker's only output.

Wire contract (D2-01 extends this payload with plate reads, so it is stated rather than implied):

    stream key   sightings
    entry        XADD sightings MAXLEN ~ 200000 * payload <json>
    payload      one `Sighting` as defined by `packages/shared/src/sighting.ts`, camelCase,
                 `cameraId` carrying the camera's **external id** (`cam01`) — the consumer resolves
                 it to `cameras.id`
    group        sightings-writer     (created by the consumer, `MKSTREAM`)

`MAXLEN ~` rather than an exact trim: exact trimming walks the radix tree and the approximate form is
O(1). The bound is what makes "no unbounded memory over a 20-minute run" true of the bus as well as
of the worker — a consumer that stops must not take the broker down with it.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Protocol

log = logging.getLogger("saakshi.analytics")

STREAM_KEY = "sightings"
CONSUMER_GROUP = "sightings-writer"
#: ~200k entries ≈ 20 minutes of the whole 30-camera estate at the rates D0-01 measured.
STREAM_MAXLEN = 200_000
DEFAULT_VALKEY_URL = "redis://localhost:6379"


class SightingSink(Protocol):
    """What the pipeline needs. A test substitutes a list; production substitutes Valkey."""

    def publish(self, sighting: dict) -> None: ...

    def close(self) -> None: ...


@dataclass
class NullSink:
    """Counts and discards. Used by `bench.py`, which measures throughput, not persistence."""

    published: int = 0

    def publish(self, sighting: dict) -> None:
        self.published += 1

    def close(self) -> None:
        return None


@dataclass
class CollectingSink:
    """Keeps everything, for tests."""

    sightings: list[dict] | None = None

    def __post_init__(self) -> None:
        if self.sightings is None:
            self.sightings = []

    def publish(self, sighting: dict) -> None:
        assert self.sightings is not None
        self.sightings.append(sighting)

    def close(self) -> None:
        return None


def valkey_url() -> str:
    return os.environ.get("VALKEY_URL", DEFAULT_VALKEY_URL)


class ValkeySink:
    """`XADD` to the `sightings` stream.

    Failures are logged and counted, never raised. A broker blip must not kill eight decode threads
    — the same rule as the prober's "a probe never raises", for the same reason.
    """

    def __init__(self, url: str | None = None, maxlen: int = STREAM_MAXLEN) -> None:
        import redis  # noqa: PLC0415 — deferred; `valkey` speaks the redis protocol

        self._client = redis.Redis.from_url(url or valkey_url(), decode_responses=True)
        self._maxlen = maxlen
        self.published = 0
        self.failed = 0

    def publish(self, sighting: dict) -> None:
        try:
            self._client.xadd(
                STREAM_KEY,
                {"payload": json.dumps(sighting, separators=(",", ":"))},
                maxlen=self._maxlen,
                approximate=True,
            )
            self.published += 1
        except Exception as exc:  # noqa: BLE001 — a broker blip must not kill a decode thread
            self.failed += 1
            if self.failed <= 5:
                log.warning("XADD to %s failed (%s): %s", STREAM_KEY, type(exc).__name__, exc)

    def close(self) -> None:
        try:
            self._client.close()
        except Exception as exc:  # noqa: BLE001
            log.debug("valkey close: %s", exc)
