"""`python -m workers.prober.run --once --all`

The trust prober's entrypoint. Selects the scope from the registry, probes each camera through a
bounded pool, and appends one `camera_health_checks` row per camera per pass.

    python -m workers.prober.run --once --all
    python -m workers.prober.run --once --camera cam01 --camera cam12
    python -m workers.prober.run --once --all --pool 8 --window 10
    python -m workers.prober.run --interval 900 --all      # scheduled sweep

A pass never aborts because one camera failed. `probe_camera` reports rather than raises, so an
unreachable camera costs one row that says "unreachable" and the sweep continues — the alternative
is a sweep of 80,000 cameras that stops at the first dead one.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

from . import db
from .probe import ProbeResult, probe_camera
from .thresholds import DEFAULTS, Thresholds

log = logging.getLogger("saakshi.prober")

#: Concurrent probes. Modest by default and configurable, because the sandbox gateway throttles
#: roughly tenfold under sustained use (D1-03) — hammering it makes every camera look worse and the
#: measurement then describes our own load rather than the estate.
DEFAULT_POOL = 4


def stream_url(camera: db.RegistryCamera) -> str | None:
    """Resolves a camera to a stream URL.

    `GET /api/ingest` is the contract; **the URL pattern is not**. The registry's `endpoints` value
    wins whenever it has one. The sandbox's catalogue supplies only `{id, name}`, so all 30 rows
    carry `endpoints = {}`, and the fallback is a *configurable* template — never a constant
    compiled into the worker. `SENTINEL_STREAM_TEMPLATE` overrides it entirely for an estate whose
    URLs look nothing like this one's.
    """
    endpoint = camera.endpoints.get(camera.adapter_kind) or camera.endpoints.get("hls")
    if endpoint:
        return endpoint

    template = os.environ.get("SENTINEL_STREAM_TEMPLATE")
    if template:
        return template.format(external_id=camera.external_id)

    host = os.environ.get("SENTINEL_HOST")
    if host:
        return f"https://{host}/{camera.external_id}/index.m3u8"
    return None


def probe_one(camera: db.RegistryCamera, thresholds: Thresholds, max_wall_s: float) -> ProbeResult:
    url = stream_url(camera)
    if url is None:
        return ProbeResult(
            camera.external_id,
            connectable=False,
            decodable=False,
            error=(
                "no stream URL: the registry carries no endpoint for this camera and neither "
                "SENTINEL_STREAM_TEMPLATE nor SENTINEL_HOST is configured"
            ),
            retryable=False,
            breakdown={"note": "configuration, not a camera fault"},
        )

    return probe_camera(
        camera.external_id,
        url,
        declared_fps=camera.declared_fps,
        cookie=os.environ.get("SENTINEL_PORTAL_COOKIE"),
        thresholds=thresholds,
        max_wall_s=max_wall_s,
    )


def run_pass(
    *,
    include_absent: bool = False,
    only: list[str] | None = None,
    limit: int | None = None,
    pool: int = DEFAULT_POOL,
    thresholds: Thresholds = DEFAULTS,
    max_wall_s: float = 180.0,
    database_url: str | None = None,
) -> list[ProbeResult]:
    """One sweep. Returns every result, written or not."""
    pass_id = str(uuid.uuid4())
    started = time.monotonic()

    with db.connect(database_url) as conn:
        cameras = db.select_cameras(conn, include_absent=include_absent, only=only, limit=limit)
        if not cameras:
            log.warning("no cameras in scope — is the registry empty? run `npm run sync:catalogue`")
            return []

        log.info("pass %s: probing %d cameras, pool=%d", pass_id[:8], len(cameras), pool)

        with ThreadPoolExecutor(max_workers=pool) as executor:
            results = list(executor.map(lambda c: probe_one(c, thresholds, max_wall_s), cameras))

        # Writes happen after the sweep, on one connection, so a slow database cannot hold decoder
        # handles open — the leak this ordering prevents is the one the AC names.
        for index, (camera, result) in enumerate(zip(cameras, results)):
            stamped = replace(result, breakdown={**result.breakdown, "pass_id": pass_id})
            db.insert_health_check(conn, camera.id, stamped)
            results[index] = stamped
        conn.commit()

    elapsed = time.monotonic() - started
    log.info(
        "pass %s: %d rows in %.1fs — %d decodable, %d unreachable, %d retryable",
        pass_id[:8],
        len(results),
        elapsed,
        sum(1 for r in results if r.decodable),
        sum(1 for r in results if not r.connectable),
        sum(1 for r in results if r.retryable),
    )
    return results


def summarise(results: list[ProbeResult]) -> str:
    lines = [
        "",
        f"  {'camera':<10} {'conn':<5} {'dec':<4} {'fps':>7} {'decl':>6} {'res':<10} "
        f"{'blur':>9} {'luma':>7} {'tamper':>7} {'drift ms':>9}",
        f"  {'-' * 88}",
    ]
    for r in sorted(results, key=lambda x: x.external_id):
        lines.append(
            f"  {r.external_id:<10} {str(r.connectable):<5} {str(r.decodable):<4} "
            f"{_n(r.measured_fps):>7} {_n(r.breakdown.get('fps', {}).get('declared')):>6} "
            f"{(r.actual_resolution or '—'):<10} {_n(r.blur_score):>9} {_n(r.luma_mean):>7} "
            f"{_n(r.tamper_score):>7} {_n(r.pts_drift_ms):>9}"
        )
    failed = [r for r in results if not r.decodable]
    if failed:
        lines.append("")
        for r in failed:
            tag = "RETRY" if r.retryable else "FAIL "
            lines.append(f"  {tag} {r.external_id}: {r.error}")
    lines.append("")
    return "\n".join(lines)


def _n(value: object) -> str:
    return "—" if value is None else str(value)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m workers.prober.run")
    parser.add_argument("--once", action="store_true", help="run a single pass and exit")
    parser.add_argument("--interval", type=int, help="run every N seconds instead of once")
    parser.add_argument("--all", action="store_true", help="every active camera in the registry")
    parser.add_argument("--camera", action="append", help="probe only this external_id (repeatable)")
    parser.add_argument("--limit", type=int, help="cap the number of cameras probed")
    parser.add_argument("--pool", type=int, default=DEFAULT_POOL, help="concurrent probes")
    parser.add_argument("--window", type=float, help="PTS seconds counted for measured_fps")
    parser.add_argument("--max-wall", type=float, default=180.0, help="per-camera wall-clock cap")
    parser.add_argument(
        "--include-absent",
        action="store_true",
        help="also probe cameras delisted from the catalogue (a delisted camera that still serves "
        "is itself a finding)",
    )
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
    )

    if not args.all and not args.camera:
        parser.error("pass --all or at least one --camera")

    thresholds = DEFAULTS if args.window is None else replace(DEFAULTS, fps_window_s=args.window)

    def one() -> list[ProbeResult]:
        results = run_pass(
            include_absent=args.include_absent,
            only=args.camera,
            limit=args.limit,
            pool=args.pool,
            thresholds=thresholds,
            max_wall_s=args.max_wall,
        )
        if not args.quiet:
            print(summarise(results))
        return results

    if args.interval:
        while True:
            one()
            time.sleep(args.interval)

    results = one()
    # A pass that reached the database and wrote rows succeeded, even when cameras were unreachable:
    # "this camera is down" is a result, not an error. Only an empty scope is a failure.
    return 0 if results else 1


if __name__ == "__main__":
    sys.exit(main())
