#!/usr/bin/env bash
# Generate the voiceover, one mp3 per section, in parallel.
# The key is loaded from .env into the environment and never printed.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
set -a; . ./.env; set +a
: "${OPENAI_API_KEY:?OPENAI_API_KEY not set}"
VOICE="${VOICE:-onyx}"
MODEL="${MODEL:-tts-1-hd}"
for f in demo-video/audio/section-*.txt; do
  n=$(basename "$f" .txt)
  (
    python3 - "$f" > "demo-video/audio/$n.json" <<'PY'
import json,sys
print(json.dumps({"model": __import__('os').environ.get('MODEL','tts-1-hd'),
                  "voice": __import__('os').environ.get('VOICE','onyx'),
                  "speed": float(__import__("os").environ.get("SPEED","1.0")), "response_format": "mp3",
                  "input": open(sys.argv[1]).read()}))
PY
    curl -sS -X POST https://api.openai.com/v1/audio/speech \
      -H "Authorization: Bearer $OPENAI_API_KEY" \
      -H "Content-Type: application/json" \
      --data-binary "@demo-video/audio/$n.json" \
      -o "demo-video/audio/$n.mp3"
    rm -f "demo-video/audio/$n.json"
  ) &
done
wait
echo "generated:"
for f in demo-video/audio/section-*.mp3; do
  d=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null || echo 0)
  printf "  %-34s %6.1fs  %sB\n" "$(basename "$f")" "$d" "$(wc -c < "$f" | tr -d ' ')"
done
