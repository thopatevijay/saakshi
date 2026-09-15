#!/usr/bin/env bash
# Run one take: capture the screen while the pointer choreography plays against it.
#
# **ffmpeg/avfoundation, not `screencapture -v`.** The latter is unusable on this machine: it ignored
# its own `-V` duration, and a capture measured against the wall clock produced **407 frames over
# 119 seconds — 3.4 fps**, which is a slideshow, not a recording. Its frame timestamps were wrong in
# both directions too, so the same request yielded files reporting 23s, 76s and 139s for the same
# span. avfoundation gives an exact duration at a true 30fps and honours `-capture_cursor`, so the
# real macOS pointer is in frame.
#
# The crop takes 70px off the top — the menu strip only. An earlier 170px crop was sized to hide
# Chrome's "started debugging this browser" infobar and ate the page header with it; that banner
# auto-dismisses, so it does not need cropping for.
#
# Usage: take.sh <section> <seconds> <choreography-function>
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N="$1"; SECS="$2"; FN="$3"
source "$ROOT/demo-video/drive.sh"
source "$ROOT/demo-video/choreography.sh"
OUT="$ROOT/demo-video/clips/section-$N.mp4"

ffmpeg -y -f avfoundation -capture_cursor 1 -framerate 30 -i "2" -t "$SECS" \
  -vf "crop=3420:1924:0:70,scale=1920:1080:flags=lanczos" \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p "$OUT" >/dev/null 2>&1 &
CAP=$!
sleep 1.6                      # avfoundation takes a moment to open the display stream
"$FN"
wait $CAP

D=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$OUT" 2>/dev/null || echo 0)
F=$(ffprobe -v quiet -select_streams v -show_entries stream=nb_frames -of csv=p=0 "$OUT" 2>/dev/null)
printf "  section %s: %.2fs · %s frames\n" "$N" "$D" "${F:-?}"
