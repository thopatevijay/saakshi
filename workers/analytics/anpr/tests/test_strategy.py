"""Best-shot selection versus every-frame OCR — AC 1's controlled experiment.

**Why this is synthetic and the estate measurement is not enough.** The ticket asks for a test
showing "equal-or-better accuracy at materially lower inference count". The sandbox estate produced
**three** human-legible plates in a 120-instance hand-labelled sample (`docs/anpr-accuracy.md`), and
neither strategy reads any of them exactly, so a comparison of accuracy on that set is a comparison
of three data points and settles nothing. The inference-count half is measured there for real; the
accuracy half needs enough trials to mean anything.

So the accuracy half is measured here, on **synthetic vehicle passes with known ground truth**, in
the only shape that makes the question well posed: a pass is a handful of frames of one plate, a
couple of them good and most of them degraded the way a real pass degrades — motion blur as the
vehicle moves, obliqueness as it turns, small size as it recedes. Best-shot picks three; every-frame
reads all of them and lets the vote average over the bad ones.

The claim being tested is not "best-shot is magic". It is that **the frames every-frame adds are the
bad ones**, so paying for them buys noise. If that is false the test fails, and it should.

**The measured result, recorded here because the AC asks for both numbers:**

```
best-shot   8/8 exact, 24 OCR inferences
every-frame 8/8 exact, 64 OCR inferences
```

Equal accuracy at **37.5%** of the inference count. Note what that is *not*: on this fixture
best-shot is not more accurate than every-frame, only cheaper. The ticket asserts it should be both;
the accuracy half was not reproduced, and `docs/anpr-accuracy.md` says so rather than quietly
reporting the half that worked.
"""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from workers.analytics.anpr.best_shot import best_shot_score
from workers.analytics.anpr.ocr import create_ocr_backend
from workers.analytics.anpr.rectify import rectify
from workers.analytics.anpr.thresholds import ANPR_DEFAULTS
from workers.analytics.anpr.vote import vote_reads

from .conftest import draw_plate, oblique_crop

#: Registrations spanning several Indian states and both series shapes.
PLATES = (
    "GJ01AB1234",
    "GJ18XY7788",
    "MH12CD5678",
    "RJ39CA5180",
    "KA05MN9012",
    "DL8CAF4321",
    "TN22BC3344",
    "UP32EF5566",
)

#: Frames per synthetic pass, and how many of them are good.
#:
#: Two good frames out of eight is deliberately *pessimistic* for best-shot: it has to find them, and
#: its buffer holds three, so at least one of its three picks is guaranteed to be a degraded frame.
#: A pass where most frames were good would make the two strategies converge and prove nothing.
PASS_FRAMES = 8
GOOD_FRAMES = 2


def _good(text: str) -> np.ndarray:
    """A frame where the vehicle is close and square-on."""
    return oblique_crop(text, shift_ratio=0.10, out_width=260)


def _degraded(text: str, index: int) -> np.ndarray:
    """A frame degraded the way a real pass degrades: oblique, then blurred, then small."""
    crop = oblique_crop(text, shift_ratio=0.30 + 0.05 * (index % 4), out_width=150 - 12 * (index % 4))
    if index % 2:
        crop = cv2.GaussianBlur(crop, (5, 5), 0)
    return crop


def _synthetic_pass(text: str, seed: int) -> list[np.ndarray]:
    rng = np.random.default_rng(seed)
    frames = [_good(text) for _ in range(GOOD_FRAMES)]
    frames += [_degraded(text, i) for i in range(PASS_FRAMES - GOOD_FRAMES)]
    order = rng.permutation(len(frames))
    return [frames[i] for i in order]


def _read_pass(frames: list[np.ndarray], backend, *, every_frame: bool) -> tuple[str | None, int]:
    """Returns `(voted text, OCR calls)` for one strategy over one pass."""
    scored = [(best_shot_score(f.shape[1], f.shape[0], f, ANPR_DEFAULTS), f) for f in frames]
    scored.sort(key=lambda item: -item[0])
    chosen = scored if every_frame else scored[: ANPR_DEFAULTS.best_shot_top_n]

    reads = []
    for _score, crop in chosen:
        rectified = rectify(crop, ANPR_DEFAULTS, backend.preferred_interpolation)
        read = backend.read(rectified.image)
        if read is not None:
            reads.append(read)
    voted = vote_reads(reads)
    return (voted.text if voted else None), len(chosen)


@pytest.mark.parametrize("backend_name", ["fast_plate_ocr"])
def test_best_shot_matches_or_beats_every_frame_at_a_fraction_of_the_inferences(
    backend_name: str,
) -> None:
    """AC 1: equal-or-better accuracy, materially fewer OCR inferences. Both numbers recorded.

    Read with the shipped default backend. The assertion is deliberately two-sided — a cheaper
    strategy that is *worse* is not what the ticket claims, and a test that only checked the cost
    would pass for a pipeline that had quietly become less accurate.
    """
    backend = create_ocr_backend(backend_name)

    best_correct = every_correct = 0
    best_calls = every_calls = 0

    for index, text in enumerate(PLATES):
        frames = _synthetic_pass(text, seed=1000 + index)

        text_best, calls_best = _read_pass(frames, backend, every_frame=False)
        text_every, calls_every = _read_pass(frames, backend, every_frame=True)

        best_correct += int(text_best == text)
        every_correct += int(text_every == text)
        best_calls += calls_best
        every_calls += calls_every

    # Recorded, not just asserted — these two lines are the evidence the AC asks for and they are
    # printed by `pytest -s`.
    print(
        f"\n  best-shot   {best_correct}/{len(PLATES)} exact, {best_calls} OCR inferences"
        f"\n  every-frame {every_correct}/{len(PLATES)} exact, {every_calls} OCR inferences"
    )

    assert best_calls < every_calls * 0.6, "best-shot must cost materially less"
    assert best_correct >= every_correct, (
        f"best-shot was less accurate: {best_correct} against {every_correct} of {len(PLATES)}"
    )
    # And it must actually work, or "equal" would be satisfied by both strategies reading nothing.
    assert best_correct >= len(PLATES) // 2


def test_the_score_separates_good_frames_from_degraded_ones_on_average() -> None:
    """The selector's contribution, stated no more strongly than it measures.

    **What is *not* asserted, and why.** An earlier version of this test required both good frames
    to be in the top 3. They are not: the sharpest degraded frame — mildly oblique, unblurred, only
    somewhat further away — scores **0.968** against the good frames' **0.959** on this fixture. The
    ranking is a near-tie at the top, and asserting otherwise would have been a claim about a
    fixture rather than about the estate.

    What is true, and what the end-to-end result rests on, is the *average* separation: over a whole
    pass the good frames score above the degraded ones, so a buffer of three lands mostly on good
    frames and the strategy costs a third of the inferences for the same answer. The per-factor
    ordering claims — sharp over blurred, large over small, frontal over grazing — are asserted
    individually in `test_best_shot.py`, which is where a regression in any one of them will show.
    """
    text = "GJ01AB1234"
    good = [_good(text) for _ in range(GOOD_FRAMES)]
    degraded = [_degraded(text, i) for i in range(PASS_FRAMES - GOOD_FRAMES)]

    def score(frame: np.ndarray) -> float:
        return best_shot_score(frame.shape[1], frame.shape[0], frame, ANPR_DEFAULTS)

    mean_good = sum(score(f) for f in good) / len(good)
    mean_degraded = sum(score(f) for f in degraded) / len(degraded)

    assert mean_good > mean_degraded


def test_a_synthetic_pass_is_a_real_test_not_a_gift() -> None:
    """The degraded frames must actually be hard, or the comparison is between two easy problems."""
    backend = create_ocr_backend("fast_plate_ocr")
    text = "GJ01AB1234"

    good_read = backend.read(rectify(_good(text), ANPR_DEFAULTS, backend.preferred_interpolation).image)
    degraded_reads = [
        backend.read(rectify(_degraded(text, i), ANPR_DEFAULTS, backend.preferred_interpolation).image)
        for i in range(PASS_FRAMES - GOOD_FRAMES)
    ]

    assert good_read is not None and good_read.text == text
    wrong = sum(1 for r in degraded_reads if r is None or r.text != text)
    assert wrong >= len(degraded_reads) // 2, "the degraded frames are too easy to be a control"
