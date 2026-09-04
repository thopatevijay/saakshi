"""Registry reads and health-check writes.

The registry is the single source (D1-04's handoff): the prober iterates `cameras`, never the
catalogue. Nothing here touches `catalogue_status` — that column belongs to ingest, and the field
ownership table exists so these two jobs cannot fight over the same row.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

import psycopg
from psycopg.rows import dict_row

from .probe import ProbeResult

DEFAULT_DATABASE_URL = "postgres://saakshi:saakshi@localhost:5432/saakshi"


@dataclass(frozen=True)
class RegistryCamera:
    id: str
    external_id: str
    name: str
    adapter_kind: str
    endpoints: dict
    declared_fps: float | None


def database_url() -> str:
    return os.environ.get("DATABASE_URL", DEFAULT_DATABASE_URL)


def connect(url: str | None = None) -> psycopg.Connection:
    return psycopg.connect(url or database_url(), row_factory=dict_row)


def select_cameras(
    conn: psycopg.Connection,
    *,
    include_absent: bool = False,
    only: list[str] | None = None,
    limit: int | None = None,
) -> list[RegistryCamera]:
    """The probe scope.

    "Every `active` camera" resolves to `deleted_at IS NULL AND catalogue_status = 'active'`.
    `camera_status` has no `'active'` value — it is `unknown|online|degraded|offline` and is this
    worker's *output*, not its input — so `catalogue_status` is the only literal reading.

    `include_absent` covers the other one. A camera delisted upstream that still serves frames is
    itself a Pillar 1 finding, so the option exists rather than the question being decided silently.
    """
    where = ["deleted_at is null"]
    params: list[object] = []
    if not include_absent:
        where.append("catalogue_status = 'active'")
    if only:
        where.append("external_id = any(%s)")
        params.append(only)

    sql = f"""
        select id::text, external_id, name, adapter_kind::text, endpoints, declared_fps
        from cameras
        where {' and '.join(where)}
        order by external_id
    """
    if limit:
        sql += " limit %s"
        params.append(limit)

    with conn.cursor() as cur:
        cur.execute(sql, params)
        return [
            RegistryCamera(
                id=row["id"],
                external_id=row["external_id"],
                name=row["name"],
                adapter_kind=row["adapter_kind"],
                endpoints=row["endpoints"] or {},
                declared_fps=None if row["declared_fps"] is None else float(row["declared_fps"]),
            )
            for row in cur.fetchall()
        ]


def insert_health_check(conn: psycopg.Connection, camera_id: str, result: ProbeResult) -> None:
    """Appends one row.

    `camera_health_checks` is a Timescale hypertable keyed `(camera_id, checked_at)`, so every pass
    appends and none overwrites. That is what makes the worker idempotent in the sense that matters:
    re-running it costs another row and changes no history. `trust_score` is left NULL — D1-06 owns
    scoring, and writing a placeholder here would be a number nobody computed.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into camera_health_checks (
                camera_id, checked_at,
                connectable, decodable,
                measured_fps, actual_resolution, actual_codec,
                blur_score, luma_mean, night_usable, tamper_score, pts_drift_ms,
                trust_score, breakdown
            ) values (
                %s::uuid, now(),
                %s, %s,
                %s, %s, %s,
                %s, %s, %s, %s, %s,
                null, %s::jsonb
            )
            """,
            (
                camera_id,
                result.connectable,
                result.decodable,
                result.measured_fps,
                result.actual_resolution,
                result.actual_codec,
                result.blur_score,
                result.luma_mean,
                result.night_usable,
                result.tamper_score,
                result.pts_drift_ms,
                json.dumps(_with_error(result)),
            ),
        )


def _with_error(result: ProbeResult) -> dict:
    breakdown = dict(result.breakdown)
    if result.error:
        breakdown["error"] = result.error
        # D1-03's handoff, in one field: a timeout is "retry later", never a health verdict. D1-06
        # scores this as unknown, not as zero.
        breakdown["retryable"] = result.retryable
    return breakdown
