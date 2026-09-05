#!/usr/bin/env bash
# Build replay clips from the D0-01 recon stills, for testing the attribute and evidence path
# without a live gateway.
#
# WHAT THIS IS, PLAINLY: a **test rig**. It turns the real still frames recon captured from the
# sandbox cameras (`recon-out/frames/<cam>_<slot>.jpg`, 30 cameras x 4 times of day) into a short
# video per camera by panning a crop window across each still. The pixels are real frames from the
# real estate; the *motion* is synthetic.
#
# WHAT IT IS NOT: a live feed, and nothing measured through it may be presented as one. It exists
# because the sandbox gateway semaphore is held elsewhere during a parallel wave, and because a
# vehicle-attribute pipeline cannot be proven on synthetic colour bars — `testsrc` contains no
# vehicles, so YOLO finds nothing and the whole path would be untested.
#
# Why a pan rather than a held still: a static frame is skipped by the motion gate, so each vehicle
# would yield one or two sightings and every sighting would be its own best shot — the exact
# "one crop per sighting" shape this ticket exists to avoid, achieved by accident. A pan gives each
# track tens of observations, which is what makes the best-shot compression ratio measurable.
#
#   scripts/build-replay-clips.sh [frames-dir] [out-dir] [cameras...]
#
# Defaults to the eight cameras D1-09 measured, into /tmp/saakshi-replay.
set -euo pipefail

FRAMES_DIR="${1:-recon-out/frames}"
OUT_DIR="${2:-/tmp/saakshi-replay}"
shift 2 2>/dev/null || true
CAMERAS=("$@")
if [ ${#CAMERAS[@]} -eq 0 ]; then
  CAMERAS=(cam01 cam02 cam03 cam04 cam05 cam06 cam07 cam08)
fi

command -v ffmpeg >/dev/null || { echo "ffmpeg not on PATH" >&2; exit 1; }
[ -d "$FRAMES_DIR" ] || { echo "no frames directory: $FRAMES_DIR" >&2; exit 1; }
mkdir -p "$OUT_DIR"

# Seconds each still is panned across, and the output frame rate. 6 s at 12 fps is 72 frames per
# still — enough observations per track for the best-shot selector to have a real choice to make,
# and short enough that eight cameras replay in under a minute.
HOLD_S=6
FPS=12

for cam in "${CAMERAS[@]}"; do
  parts=()
  list="$OUT_DIR/$cam.txt"
  : > "$list"
  for still in "$FRAMES_DIR/${cam}_"*.jpg; do
    [ -e "$still" ] || continue
    slot="$(basename "$still" .jpg)"
    part="$OUT_DIR/${slot}.mp4"
    # Read the still's own size, then pan a window 80% of its width across it. Never a fixed size:
    # this estate publishes 854x480, 1280x720 and 1920x1080, and a hardcoded crop would silently
    # produce a black-bordered frame on two of the three.
    W="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$still")"
    H="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$still")"
    CW=$(( W * 8 / 10 ))
    CH=$(( H * 8 / 10 ))
    ffmpeg -hide_banner -loglevel error -y \
      -loop 1 -t "$HOLD_S" -i "$still" \
      -vf "crop=${CW}:${CH}:x='(iw-${CW})*t/${HOLD_S}':y='(ih-${CH})*0.5',fps=${FPS},format=yuv420p" \
      -c:v libx264 -preset veryfast -g "$FPS" "$part"
    printf "file '%s'\n" "$part" >> "$list"
    parts+=("$part")
  done
  if [ ${#parts[@]} -eq 0 ]; then
    echo "  $cam: no stills in $FRAMES_DIR — skipped"
    continue
  fi
  # Concatenated without re-encoding. The joins between two unrelated stills are hard scene cuts,
  # which is exactly what a looping feed's loop point looks like — so the replay also exercises the
  # session-boundary flush rather than only the happy path.
  ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$list" -c copy "$OUT_DIR/$cam.mp4"
  echo "  $cam -> $OUT_DIR/$cam.mp4 (${#parts[@]} stills)"
done

echo ""
echo "Run the worker against them (nothing here touches the sandbox gateway):"
printf '  python -m workers.analytics.run --evidence --minutes 3 \\\n'
for cam in "${CAMERAS[@]}"; do
  [ -f "$OUT_DIR/$cam.mp4" ] && printf '    --source %s=%s/%s.mp4 \\\n' "$cam" "$OUT_DIR" "$cam"
done
printf '    --json /tmp/replay-summary.json\n'
