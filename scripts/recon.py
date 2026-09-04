#!/usr/bin/env python3
"""
SAAKSHI Day-0 reconnaissance — Sentinel camera grid (cctv.corp8.cloud).

Answers the questions that decide the build, before a line of feature code:
  1. What cameras exist?        -> GET /cameras.json  (id + name only; nothing else is declared)
  2. Do they decode?            -> ffprobe each HLS playlist
  3. What are they really?      -> measured codec / resolution / fps / duration, not declared
  4. Are plates readable?       -> samples DAY and NIGHT frames, scores sharpness + brightness
  5. Which cameras do we demo?  -> ranked shortlist

Reality of this sandbox (differs from the published Integrator's Guide — see BL-01):
  * HLS only. No RTSP (:8554), no WHEP (:8889), no /api/ingest.
  * VOD, not live: PLAYLIST-TYPE:VOD with ENDLIST, fully seekable, 7200 x ~6s = 12.0 h per camera.
  * AES-128 encrypted (key at /enc.key) — ffmpeg handles this transparently.
  * Auth: `sentinel=<token>` cookie required; every path 302s without it.
  * Cloudflare rejects ffmpeg's default UA — a browser User-Agent is mandatory.
  * Footage window 13-06-2026 21:00 -> 14-06-2026 09:00, so ~9 of 12 h are NIGHT.
    Daylight is roughly offsets 32400-43200 s. Sampling only the start gives a night-only view.

Usage:
    pip install opencv-python requests            # ffmpeg must be on PATH
    set -a; . ./.env; set +a
    python3 scripts/recon.py
    python3 scripts/recon.py --only cam12,cam14 --offsets 39600
"""
from __future__ import annotations

import argparse, csv, json, os, statistics, subprocess, sys
from pathlib import Path

try:
    import cv2, requests
except ImportError:
    sys.exit("pip install opencv-python requests")

OUT = Path("recon-out"); FRAMES = OUT / "frames"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
# Durations vary 1.0-24.5 h across the estate, so absolute offsets are meaningless: on a short
# camera a fixed 39600 s "day" seek lands past the end and ffmpeg silently clamps, mislabelling a
# night frame as daylight. Sample at FRACTIONS of each camera's own duration instead, then pick
# day/night by measured brightness — which needs no knowledge of when the recording started.
SAMPLE_FRACTIONS = (0.08, 0.35, 0.62, 0.90)


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def hdrs() -> list[str]:
    """ffmpeg/ffprobe args carrying auth + a browser UA (Cloudflare rejects the default)."""
    return ["-user_agent", UA, "-headers", f"Cookie: {env('SENTINEL_PORTAL_COOKIE')}\r\n"]


def m3u8(cam_id: str) -> str:
    return f"https://{env('SENTINEL_HOST','cctv.corp8.cloud')}/{cam_id}/index.m3u8"


def catalogue() -> list[dict]:
    url = env("SENTINEL_INGEST_URL") or f"https://{env('SENTINEL_HOST')}/cameras.json"
    r = requests.get(url, headers={"Cookie": env("SENTINEL_PORTAL_COOKIE"), "User-Agent": UA},
                     timeout=30, allow_redirects=False)
    if r.status_code != 200:
        sys.exit(f"catalogue -> HTTP {r.status_code}. Cookie expired or missing "
                 f"(must be `sentinel=<token>`). Re-copy it from DevTools.")
    OUT.mkdir(exist_ok=True)
    (OUT / "catalogue.json").write_text(json.dumps(r.json(), indent=2))
    return r.json()


def playlist_stats(cam_id: str) -> dict:
    """Segment count and true duration, straight from the VOD playlist."""
    try:
        r = requests.get(m3u8(cam_id), headers={"Cookie": env("SENTINEL_PORTAL_COOKIE"),
                                                "User-Agent": UA}, timeout=30)
        text = r.text
        durs = [float(x.split(":")[1].rstrip(",")) for x in text.splitlines()
                if x.startswith("#EXTINF")]
        return {"segments": len(durs), "duration_s": round(sum(durs)),
                "is_vod": "#EXT-X-ENDLIST" in text,
                "encrypted": "#EXT-X-KEY" in text}
    except Exception as e:
        return {"segments": 0, "duration_s": 0, "is_vod": None, "encrypted": None,
                "playlist_error": str(e)[:80]}


def probe(cam_id: str) -> dict:
    """Measured stream properties. Nothing here is declared by the catalogue."""
    cmd = ["ffprobe", "-hide_banner", "-loglevel", "error", *hdrs(),
           "-select_streams", "v:0", "-show_entries",
           "stream=codec_name,width,height,avg_frame_rate", "-of", "json", "-i", m3u8(cam_id)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        st = (json.loads(r.stdout or "{}").get("streams") or [{}])[0]
        fr = st.get("avg_frame_rate", "0/1")
        num, _, den = fr.partition("/")
        fps = round(float(num) / float(den), 2) if den and float(den) else None
        return {"codec": st.get("codec_name"), "width": st.get("width"),
                "height": st.get("height"), "fps": fps,
                "probe_error": (r.stderr or "").strip()[:100] or None}
    except Exception as e:
        return {"codec": None, "width": None, "height": None, "fps": None,
                "probe_error": str(e)[:100]}


def grab(cam_id: str, offset: int, label: str) -> Path | None:
    out = FRAMES / f"{cam_id}_{label}.jpg"
    FRAMES.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", *hdrs(),
           "-ss", str(offset), "-i", m3u8(cam_id), "-frames:v", "1", "-q:v", "2", "-y", str(out)]
    try:
        subprocess.run(cmd, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired:
        return None
    return out if out.exists() and out.stat().st_size > 0 else None


def score_frame(path: Path) -> dict:
    """Crude plate-readability proxy. The automated number is a hint; your eyes decide."""
    img = cv2.imread(str(path))
    if img is None:
        return {}
    h, w = img.shape[:2]
    # Ignore the burned-in timestamp/name overlays at top and bottom when scoring.
    core = img[int(h * 0.15):int(h * 0.88), :]
    g = cv2.cvtColor(core, cv2.COLOR_BGR2GRAY)
    sharp = float(cv2.Laplacian(g, cv2.CV_64F).var())
    bright = float(g.mean())
    return {"sharpness": round(sharp, 1), "brightness": round(bright, 1)}
    # NOTE: deliberately no composite "plate score". The previous heuristic
    # (0.5*sharpness + 0.2*brightness + 0.3*pixels) rewarded wide, sharp, 1080p scenes — i.e. exactly
    # the PTZ traffic-overview cameras where plates are a few pixels — and ranked the genuinely
    # ANPR-viable toll/RLVD cameras BELOW them. A misleading number is worse than none.
    # Rank by geometry, judged by eye; confirm with a real plate detector in D2-01.


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="comma-separated camera ids")
    ap.add_argument("--offsets", help="comma-separated seconds; default night+predawn+day")
    args = ap.parse_args()

    if not env("SENTINEL_PORTAL_COOKIE"):
        sys.exit("SENTINEL_PORTAL_COOKIE not set. Run:  set -a; . ./.env; set +a")

    cams = catalogue()
    if args.only:
        keep = {s.strip() for s in args.only.split(",")}
        cams = [c for c in cams if c["id"] in keep]
    plan = (args.offsets if args.offsets
            else ", ".join(f"{int(f*100)}%" for f in SAMPLE_FRACTIONS))
    print(f"{len(cams)} cameras · sampling at {plan} of each camera's own duration\n")

    rows = []
    for i, cam in enumerate(cams, 1):
        cid = cam["id"]
        row = {"id": cid, "name": cam.get("name", ""), **playlist_stats(cid), **probe(cid)}
        dur = row.get("duration_s") or 0

        # Sample at fractions of THIS camera's duration. Explicit offsets override.
        if args.offsets:
            points = [(f"t{o}", int(o)) for o in args.offsets.split(",")]
        elif dur > 60:
            points = [(f"p{int(f*100):02d}", int(dur * f)) for f in SAMPLE_FRACTIONS]
        else:
            points = [("p50", max(1, dur // 2))]

        samples = []
        for label, off in points:
            f = grab(cid, off, label)
            sc = score_frame(f) if f else {}
            if sc:
                samples.append({"label": label, "offset_s": off, "path": str(f), **sc})

        row["samples"] = samples
        row["decodable"] = bool(samples)
        if samples:
            # Brightness separates daylight from night far more reliably than any offset guess.
            day = max(samples, key=lambda x: x["brightness"])
            night = min(samples, key=lambda x: x["brightness"])
            row.update({
                "day_offset_s": day["offset_s"], "day_brightness": day["brightness"],
                "day_sharpness": day["sharpness"], "day_frame": day["path"],
                "night_brightness": night["brightness"],
                "brightness_range": round(day["brightness"] - night["brightness"], 1),
                # A camera whose brightest and darkest samples barely differ never saw daylight
                # (or is indoors / IR-only). That is itself a finding.
                "saw_daylight": (day["brightness"] - night["brightness"]) > 25 and day["brightness"] > 70,
            })
            Path(day["path"]).replace(FRAMES / f"{cid}_day.jpg")
            row["day_frame"] = str(FRAMES / f"{cid}_day.jpg")
        rows.append(row)
        print(f"[{i:>2}/{len(cams)}] {cid} {str(row['codec']):>5} "
              f"{row['width']}x{row['height']} {row['fps']}fps {dur/3600:>4.1f}h  "
              f"day@{row.get('day_offset_s','-')}s bright={row.get('day_brightness','-')} "
              f"range={row.get('brightness_range','-')} "
              f"{'DAYLIGHT' if row.get('saw_daylight') else 'no-daylight'}  {row['name'][:30]}")

    OUT.mkdir(exist_ok=True)
    (OUT / "report.json").write_text(json.dumps(rows, indent=2))
    keys = sorted({k for r in rows for k in r})
    with (OUT / "report.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); w.writerows(rows)

    live = [r for r in rows if r["decodable"]]
    day_ok = [r for r in live if r.get("saw_daylight")]
    print(f"\n{'='*78}\nSUMMARY")
    print(f"  catalogued            {len(rows)}")
    print(f"  decodable             {len(live)}")
    print(f"  dead / unreachable    {len(rows)-len(live)}")
    print(f"  genuine daylight frame{len(day_ok):>4}   (brightness range > 25 and day > 70)")
    print(f"  never saw daylight    {len(live)-len(day_ok):>4}   <- short recordings / night-only / IR")
    print(f"  codecs                {sorted({r['codec'] for r in live if r['codec']})}")
    print(f"  resolutions           {sorted({f'{r["width"]}x{r["height"]}' for r in live})}")
    print(f"  frame rates           {sorted({r['fps'] for r in live if r['fps']})}")
    durs = [r["duration_s"] for r in live if r["duration_s"]]
    if durs:
        print(f"  duration              {min(durs)/3600:.1f}-{max(durs)/3600:.1f} h")

    print("\nPER-CAMERA — judge ANPR viability BY EYE from recon-out/frames/<id>_day.jpg.")
    print("There is deliberately no composite score: sharpness x resolution ranks wide PTZ")
    print("overview cameras above the toll/RLVD cameras that actually read plates.\n")
    print(f"  {'id':<7}{'res':<11}{'fps':>4}{'dur_h':>7}{'day@s':>8}{'bright':>8}{'range':>7}  daylight  name")
    for r in sorted(live, key=lambda r: r["id"]):
        print(f"  {r['id']:<7}{str(r['width'])+'x'+str(r['height']):<11}{r['fps'] or 0:>4.0f}"
              f"{(r['duration_s'] or 0)/3600:>7.1f}{r.get('day_offset_s',0):>8}"
              f"{r.get('day_brightness',0):>8.1f}{r.get('brightness_range',0):>7.1f}"
              f"  {'yes' if r.get('saw_daylight') else 'NO ':>7}   {r['name'][:32]}")

    print(f"\nwrote {OUT/'report.json'}, {OUT/'report.csv'}, {FRAMES}/")
    print("Next: open the day frames. Look for vehicles passing CLOSE, SLOW and NEAR-FRONTAL")
    print("(toll lanes, stop lines). Record the Go / re-weight decision on the D0-01 issue.")


if __name__ == "__main__":
    main()
