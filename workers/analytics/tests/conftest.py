"""Synthetic clips, generated with ffmpeg.

Every clip exists to make one acceptance criterion falsifiable without a live camera, and each is a
few ffmpeg flags rather than a committed binary — a fixture nobody can regenerate is a fixture
nobody can audit. D1-05's `workers/prober/tests/conftest.py` established the pattern; the clips here
are the ones *this* ticket's criteria need:

- `h264_small`   — 640x480 H.264. With `hevc_720` it makes AC 6 (mixed codecs *and* resolutions in
                   one run) a real decode of two different streams, not an assertion about config.
- `hevc_720`     — 1280x720 H.265.
- `static`       — a still image. The motion gate must skip nearly all of it.
- `moving`       — a bar crossing the frame. The motion gate must skip nearly none of it. Both
                   directions, because a gate that skips everything would pass a one-sided test.
- `scene_cut`    — two unrelated scenes butted together: the loop point. AC 3.
- `gentle`       — motion without a cut, so the cut detector can be shown *not* to fire.
- `truncated`    — a file that ends mid-frame: the decoder must not treat it as fatal. AC 5.
- `corrupt`      — a file whose middle is damaged but whose index is intact, so libav complains
                   loudly the way a mid-GOP join does and the run must survive it. AC 5.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

FFMPEG = shutil.which("ffmpeg")
requires_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")


def _run(args: list[str]) -> None:
    result = subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr[:800]}")


@pytest.fixture(scope="session")
def clips(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    if FFMPEG is None:
        pytest.skip("ffmpeg not on PATH")

    out = tmp_path_factory.mktemp("analytics-clips")

    h264_small = out / "h264_640x480.mp4"
    _run(["-f", "lavfi", "-i", "testsrc=size=640x480:rate=25:duration=4", "-c:v", "libx264",
          "-pix_fmt", "yuv420p", "-g", "25", str(h264_small)])

    hevc_720 = out / "hevc_1280x720.mp4"
    _run(["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25:duration=4", "-c:v", "libx265",
          "-x265-params", "log-level=error", "-pix_fmt", "yuv420p", "-g", "25", str(hevc_720)])

    static = out / "static.mp4"
    # A frozen scene with structure in it. Not black: a uniform frame would make the gate look good
    # for the wrong reason — there would be nothing to detect a change *in*.
    _run(["-f", "lavfi", "-i", "testsrc=size=640x480:rate=25:duration=1", "-vf", "select=eq(n\\,0)",
          "-frames:v", "1", str(out / "still.png")])
    _run(["-loop", "1", "-i", str(out / "still.png"), "-t", "4", "-r", "25", "-c:v", "libx264",
          "-pix_fmt", "yuv420p", "-g", "25", str(static)])

    moving = out / "moving.mp4"
    # A bright bar sweeping across a dark frame: unambiguous motion on every single frame.
    #
    # `overlay`, not `drawbox`: ffmpeg 8 evaluates drawbox's `x` once at filter init, so the
    # drawbox version produced a *static* bar and the gate correctly skipped 98% of it — a fixture
    # that would have made the negative direction of this AC untestable while looking fine.
    _run(["-f", "lavfi", "-i", "color=c=black:s=640x480:r=25:d=4",
          "-f", "lavfi", "-i", "color=c=white:s=80x300:r=25:d=4",
          "-filter_complex", "[0:v][1:v]overlay=x='mod(t*200\\,560)':y=90",
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", str(moving)])

    first = out / "first.mp4"
    _run(["-f", "lavfi", "-i", "testsrc=size=640x480:rate=25:duration=2", "-c:v", "libx264",
          "-pix_fmt", "yuv420p", "-g", "25", str(first)])
    second = out / "second.mp4"
    # The second scene must **move**, not merely look different. A still second half meant the
    # motion gate skipped it, ByteTrack never confirmed a track after the cut, and the disjointness
    # assertion passed for the wrong reason — "nothing was tracked after the cut" is not evidence
    # that identity did not bleed.
    _run(["-f", "lavfi", "-i", "color=c=black:s=640x480:r=25:d=2",
          "-f", "lavfi", "-i", "color=c=white:s=80x300:r=25:d=2",
          "-filter_complex", "[0:v][1:v]overlay=x='mod(t*200\\,560)':y=90",
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", str(second)])

    scene_cut = out / "scene_cut.mp4"
    concat = out / "concat.txt"
    concat.write_text(f"file '{first}'\nfile '{second}'\n")
    _run(["-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", str(scene_cut)])

    gentle = out / "gentle.mp4"
    # Continuous motion, no cut: the control that stops "detects a cut" from meaning "fires often".
    _run(["-f", "lavfi", "-i", "testsrc=size=640x480:rate=25:duration=4", "-c:v", "libx264",
          "-pix_fmt", "yuv420p", "-g", "25", str(gentle)])

    # MPEG-TS, not MP4: an MP4 keeps its index in a trailing `moov` atom, so a truncated one will
    # not open **at all** and the test would be about a missing file rather than about a stream that
    # ends mid-frame. TS is also what HLS actually carries, which is what this estate serves.
    full_ts = out / "full.ts"
    _run(["-f", "lavfi", "-i", "testsrc=size=640x480:rate=25:duration=4", "-c:v", "libx264",
          "-pix_fmt", "yuv420p", "-g", "25", "-f", "mpegts", str(full_ts)])
    truncated = out / "truncated.ts"
    truncated.write_bytes(full_ts.read_bytes()[: int(full_ts.stat().st_size * 0.55)])

    # A file whose *middle* is damaged, with the index at the front (`+faststart`) so it still
    # opens. This is the one that makes libav complain the way a mid-GOP join does — a truncated
    # tail just ends, quietly. Long GOP and B-frames so the damage propagates across references,
    # exactly as it does when a segment arrives half-fetched.
    clean = out / "clean_faststart.mp4"
    _run(["-f", "lavfi", "-i", "testsrc=size=640x480:rate=25:duration=6", "-c:v", "libx264",
          "-pix_fmt", "yuv420p", "-g", "150", "-bf", "3", "-movflags", "+faststart", str(clean)])
    data = bytearray(clean.read_bytes())
    for index in range(int(len(data) * 0.35), int(len(data) * 0.40)):
        data[index] = 0
    corrupt = out / "corrupt.mp4"
    corrupt.write_bytes(bytes(data))

    return {
        "h264_small": h264_small,
        "hevc_720": hevc_720,
        "static": static,
        "moving": moving,
        "scene_cut": scene_cut,
        "gentle": gentle,
        "truncated": truncated,
        "corrupt": corrupt,
    }
