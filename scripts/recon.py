#!/usr/bin/env python3
"""
SAAKSHI Day-0 reconnaissance.

Answers the questions that decide the whole build, before a line of feature code:
  1. What cameras exist?           -> pulls the /api/ingest catalogue (the contract)
  2. Do they actually work?        -> RTSP/TCP connect + decode per camera
  3. Is the declared metadata true?-> measured FPS / resolution / codec vs declared
  4. Are plates readable?          -> sharpness + brightness score + a saved sample frame
  5. Which 10-12 do we demo on?    -> ranked shortlist

Usage:
    pip install opencv-python requests
    python scripts/recon.py --ingest http://<host>/api/ingest --seconds 12
    python scripts/recon.py --ingest ... --only 3,7,11        # re-probe specific cameras

Outputs to recon-out/:
    catalogue.json   raw /api/ingest response
    report.json      full per-camera probe results
    report.csv       same, spreadsheet-friendly
    frames/<id>.jpg  one sample frame per camera -> eyeball plate visibility yourself
"""
from __future__ import annotations

import argparse, csv, json, os, statistics, sys, time
from pathlib import Path

os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")

try:
    import cv2, requests
except ImportError:
    sys.exit("pip install opencv-python requests")

OUT = Path("recon-out"); FRAMES = OUT / "frames"


def fetch_catalogue(url: str, cookie: str | None) -> list[dict]:
    headers = {"Cookie": cookie} if cookie else {}
    r = requests.get(url, headers=headers, timeout=30)
    r.raise_for_status()
    data = r.json()
    OUT.mkdir(exist_ok=True)
    (OUT / "catalogue.json").write_text(json.dumps(data, indent=2))
    # Be liberal: the payload shape is not documented.
    for key in ("cameras", "data", "streams", "items", "results"):
        if isinstance(data, dict) and isinstance(data.get(key), list):
            return data[key]
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        vals = [v for v in data.values() if isinstance(v, dict)]
        if vals:
            return vals
    raise SystemExit(f"Could not find a camera list in the response. Inspect {OUT/'catalogue.json'}")


def pick(cam: dict, *names, default=None):
    for n in names:
        if n in cam and cam[n] not in (None, ""):
            return cam[n]
    return default


def rtsp_url(cam: dict, host: str | None) -> str | None:
    for k in ("rtsp", "rtsp_url", "rtspUrl", "url"):
        v = cam.get(k)
        if isinstance(v, str) and v.startswith("rtsp://"):
            return v
    for v in cam.values():                       # nested urls dict
        if isinstance(v, dict):
            for k2 in ("rtsp", "rtsp_url", "rtspUrl"):
                if isinstance(v.get(k2), str) and v[k2].startswith("rtsp://"):
                    return v[k2]
    cid = pick(cam, "id", "camera_id", "stream_id", "streamId")
    return f"rtsp://{host}:8554/stream/{cid}" if host and cid is not None else None


def probe(cam: dict, host: str | None, seconds: float) -> dict:
    cid = pick(cam, "id", "camera_id", "stream_id", "streamId", default="?")
    url = rtsp_url(cam, host)
    row = {
        "id": cid,
        "name": pick(cam, "name", "title", "location", "camera_name", default=""),
        "department": pick(cam, "department", "dept", "owner", default=""),
        "declared_codec": pick(cam, "codec", "video_codec", default=""),
        "declared_fps": pick(cam, "fps", "framerate", "frame_rate", default=""),
        "declared_res": pick(cam, "resolution", default=""),
        "live_flag": pick(cam, "live", "status", "is_live", default=""),
        "rtsp_url": url or "",
        "connectable": False, "decodable": False,
        "reported_fps": None, "measured_fps": None, "fps_matches_declared": None,
        "width": None, "height": None,
        "frames": 0, "first_frame_ms": None,
        "sharpness": None, "brightness": None,
        "pts_span_s": None, "pts_available": False,
        "plate_score": None, "verdict": "", "error": "",
    }
    if not url:
        row["error"] = "no rtsp url resolvable"; return row

    t0 = time.time()
    cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
    if not cap.isOpened():
        row["error"] = "VideoCapture failed to open (blocked port? wrong host? auth?)"
        cap.release(); return row
    row["connectable"] = True
    row["reported_fps"] = round(cap.get(cv2.CAP_PROP_FPS) or 0, 2)  # do NOT trust this

    sharps, lumas, pts, n = [], [], [], 0
    deadline, first = time.time() + seconds, None
    while time.time() < deadline:
        ok, frame = cap.read()
        if not ok:
            if n == 0:
                row["error"] = "opened but no decodable frame"
            break
        if first is None:
            first = time.time()
            row["first_frame_ms"] = int((first - t0) * 1000)
            row["decodable"] = True
            row["height"], row["width"] = frame.shape[:2]
            FRAMES.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(FRAMES / f"{cid}.jpg"), frame)
        n += 1
        p = cap.get(cv2.CAP_PROP_POS_MSEC)
        if p and p > 0:
            pts.append(p)
        if n % 5 == 0:                                    # sample, don't grind
            g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            sharps.append(cv2.Laplacian(g, cv2.CV_64F).var())
            lumas.append(float(g.mean()))
    cap.release()

    row["frames"] = n
    if not row["decodable"]:
        return row

    wall = max(time.time() - (first or t0), 1e-6)
    row["measured_fps"] = round(n / wall, 2)
    if row["reported_fps"]:
        row["fps_matches_declared"] = abs(row["measured_fps"] - row["reported_fps"]) < 2.0
    if len(pts) > 1:
        row["pts_available"] = True
        row["pts_span_s"] = round((max(pts) - min(pts)) / 1000.0, 2)
    if sharps:
        row["sharpness"] = round(statistics.median(sharps), 1)
        row["brightness"] = round(statistics.median(lumas), 1)
        # Crude plate-readability proxy: sharp enough, lit enough, enough pixels.
        px = (row["width"] or 0) * (row["height"] or 0)
        s = min(row["sharpness"] / 150.0, 1.0)
        b = 1.0 if 55 <= row["brightness"] <= 200 else 0.35
        r = min(px / (1920 * 1080), 1.0)
        row["plate_score"] = round(100 * (0.5 * s + 0.2 * b + 0.3 * r), 1)
        row["verdict"] = ("GOOD - demo candidate" if row["plate_score"] >= 55 else
                          "MARGINAL" if row["plate_score"] >= 35 else "POOR for ANPR")
    return row


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ingest", required=True, help="full /api/ingest URL")
    ap.add_argument("--host", help="stream host, if URLs must be constructed")
    ap.add_argument("--cookie", help="portal session cookie, if required")
    ap.add_argument("--seconds", type=float, default=12.0, help="probe seconds per camera")
    ap.add_argument("--only", help="comma-separated camera ids to probe")
    args = ap.parse_args()

    host = args.host or args.ingest.split("//", 1)[-1].split("/", 1)[0].split(":")[0]
    cams = fetch_catalogue(args.ingest, args.cookie)
    if args.only:
        keep = {s.strip() for s in args.only.split(",")}
        cams = [c for c in cams if str(pick(c, "id", "camera_id", "stream_id")) in keep]

    print(f"catalogue: {len(cams)} cameras · host {host} · {args.seconds}s each "
          f"(~{len(cams)*args.seconds/60:.1f} min)\n")

    rows = []
    for i, cam in enumerate(cams, 1):
        r = probe(cam, host, args.seconds)
        rows.append(r)
        print(f"[{i:>3}/{len(cams)}] id={str(r['id']):<8} "
              f"{'OK ' if r['decodable'] else 'DEAD'} "
              f"{str(r['width'] or '?')}x{str(r['height'] or '?'):<6} "
              f"fps decl={r['reported_fps']} meas={r['measured_fps']:<6} "
              f"sharp={r['sharpness']} plate={r['plate_score']} {r['verdict']} {r['error']}")

    OUT.mkdir(exist_ok=True)
    (OUT / "report.json").write_text(json.dumps(rows, indent=2))
    with (OUT / "report.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)

    live = [r for r in rows if r["decodable"]]
    liars = [r for r in live if r["fps_matches_declared"] is False]
    ranked = sorted((r for r in live if r["plate_score"] is not None),
                    key=lambda r: -r["plate_score"])

    print(f"\n{'='*70}\nSUMMARY")
    print(f"  catalogued        {len(rows)}")
    print(f"  decodable         {len(live)}")
    print(f"  dead / unreachable{len(rows)-len(live):>4}")
    print(f"  declared FPS wrong{len(liars):>4}   <- registry-truth evidence for the deck")
    print(f"  no PTS available  {sum(1 for r in live if not r['pts_available']):>4}")
    print("\nTOP DEMO CANDIDATES (eyeball recon-out/frames/<id>.jpg before trusting these):")
    for r in ranked[:12]:
        print(f"  id={str(r['id']):<8} plate={r['plate_score']:<6} "
              f"{r['width']}x{r['height']} sharp={r['sharpness']} "
              f"bright={r['brightness']} {r['name'][:34]}")
    print(f"\nwrote {OUT/'report.json'}, {OUT/'report.csv'}, {FRAMES}/")
    print("Next: open the frames. If plates are unreadable across the board, re-weight to "
          "Pillars 1/2/4 per PROJECT.md Day-0 contingency.")


if __name__ == "__main__":
    main()
