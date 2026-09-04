"""Synthetic fixtures, generated with ffmpeg.

Every clip here exists to make one acceptance criterion falsifiable without a live camera:

- `black_clip`      — a covered lens. Must score high tamper.
- `motion_clip`     — a working camera. Must score low tamper.
- `scene_cut_clip`  — the loop point. Must **also** score low tamper, which is the criterion the
                      median statistics in `signals.tamper_score` exist to satisfy.
- `truncated_clip`  — a stream that ends mid-frame, for the decoder-warning path.

Generated rather than committed: a binary fixture in git is a fixture nobody can regenerate or
audit, and these are a few ffmpeg flags each.
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

    out = tmp_path_factory.mktemp("clips")

    black = out / "black.mp4"
    # A covered lens: uniform, featureless, and identical frame to frame.
    _run(["-f", "lavfi", "-i", "color=c=black:s=640x480:r=25:d=6", "-c:v", "libx264",
          "-pix_fmt", "yuv420p", "-g", "25", str(black)])

    motion = out / "motion.mp4"
    # A working camera: structure to produce edges, and movement between frames.
    _run(["-f", "lavfi", "-i", "testsrc=size=640x480:rate=25:duration=6", "-c:v", "libx264",
          "-pix_fmt", "yuv420p", "-g", "25", str(motion)])

    second_scene = out / "second.mp4"
    _run(["-f", "lavfi", "-i", "smptebars=size=640x480:rate=25:duration=3", "-c:v", "libx264",
          "-pix_fmt", "yuv420p", "-g", "25", str(second_scene)])

    first_scene = out / "first.mp4"
    _run(["-f", "lavfi", "-i", "testsrc=size=640x480:rate=25:duration=3", "-c:v", "libx264",
          "-pix_fmt", "yuv420p", "-g", "25", str(first_scene)])

    # The loop point: two visually unrelated scenes butted together, exactly what a feed that loops
    # produces once per cycle.
    scene_cut = out / "scene_cut.mp4"
    concat_list = out / "concat.txt"
    concat_list.write_text(f"file '{first_scene}'\nfile '{second_scene}'\n")
    _run(["-f", "concat", "-safe", "0", "-i", str(concat_list), "-c", "copy", str(scene_cut)])

    truncated = out / "truncated.mp4"
    truncated.write_bytes(motion.read_bytes()[: int(motion.stat().st_size * 0.55)])

    return {
        "black": black,
        "motion": motion,
        "scene_cut": scene_cut,
        "truncated": truncated,
    }
