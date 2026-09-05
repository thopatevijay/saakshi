"""Where a best-shot plate crop is kept, and the URI that goes in the `plate_reads` row.

**The evidence store itself is D2-02's ticket**, not this one: MinIO, signed URLs, retention and the
storage-per-1000-sightings measurement all belong there. What this ticket must not do is invent a
*different* object naming scheme in the meantime, because D2-02 would then have to migrate every URI
this pipeline has written.

So the key is D2-02's stated convention exactly —

    evidence/<camera_external_id>/<yyyy-mm-dd>/<track_id>-plate.jpg

— and only the backend behind it is local. Swapping `LocalCropStore` for an S3 one changes the URI
scheme and nothing else.

One deviation from D2-02's convention, stated so it is not discovered later: the file is named by
**`track_id`, not `sighting_id`**. The worker cannot know a sighting id — Postgres generates it on
insert, downstream of the bus — so no crop written from the worker can ever be named after one.
D2-02 inherits the same constraint.

**Crops are written only for best-shots**, which is D2-02's AC and is enforced here at the source:
the engine calls `put` once per track, at the moment the vote is emitted.
"""

from __future__ import annotations

import logging
import os
import pathlib
import threading
from typing import Protocol, runtime_checkable

import cv2
import numpy as np

log = logging.getLogger("saakshi.analytics.anpr")

Frame = np.ndarray

__all__ = ["CropStore", "LocalCropStore", "NullCropStore", "crop_key", "DEFAULT_CROP_DIR"]

#: Gitignored (`evidence/*`). A crop is personal data about a vehicle in a public place and belongs
#: in an object store with a retention clock (D3-05), never in version control.
DEFAULT_CROP_DIR = "evidence/plates"


def crop_key(camera_external_id: str, day: str, track_id: int, kind: str = "plate") -> str:
    """D2-02's object key. `day` is `yyyy-mm-dd`, taken from the sighting's PTS-derived timestamp."""
    return f"evidence/{camera_external_id}/{day}/{track_id}-{kind}.jpg"


@runtime_checkable
class CropStore(Protocol):
    def put(self, image: Frame, key: str) -> str | None: ...


class NullCropStore:
    """Stores nothing, returns no URI. What `bench.py` uses — it measures throughput, not storage."""

    def put(self, image: Frame, key: str) -> str | None:  # noqa: ARG002
        return None


class LocalCropStore:
    """Writes JPEGs under a base directory and returns a `file://` URI.

    Failures are logged and counted, never raised: a full disk must not take down eight decode
    threads, and a plate read without its crop is still a plate read. The counter is what makes the
    loss visible instead of silent.
    """

    def __init__(self, base_dir: str | os.PathLike[str] = DEFAULT_CROP_DIR, quality: int = 92):
        self.base = pathlib.Path(base_dir).resolve()
        self.quality = quality
        self.written = 0
        self.failed = 0
        self._lock = threading.Lock()

    def put(self, image: Frame, key: str) -> str | None:
        if image is None or image.size == 0:
            return None
        path = self.base / key
        try:
            with self._lock:
                path.parent.mkdir(parents=True, exist_ok=True)
                ok = cv2.imwrite(str(path), image, [int(cv2.IMWRITE_JPEG_QUALITY), self.quality])
            if not ok:
                raise OSError(f"cv2.imwrite refused {path}")
            self.written += 1
        except Exception as exc:  # noqa: BLE001 — a crop is evidence, not a dependency
            self.failed += 1
            if self.failed <= 5:
                log.warning("crop store: %s (%s)", exc, type(exc).__name__)
            return None
        return path.as_uri()
