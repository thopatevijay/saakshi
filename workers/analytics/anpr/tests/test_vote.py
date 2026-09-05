"""Multi-frame voting — AC 3.

The headline test is the ticket's own: five noisy reads of a known plate must recover the plate.
The rest exist because a vote that recovers the right answer for the wrong reason is worse than one
that fails — it will fail silently later, on data nobody is looking at.
"""

from __future__ import annotations

from workers.analytics.anpr.ocr import OcrRead
from workers.analytics.anpr.vote import vote_reads


def read(text: str, confidence: float, char_confidences: tuple[float, ...] | None = None) -> OcrRead:
    return OcrRead(
        text=text,
        confidence=confidence,
        char_confidences=char_confidences or tuple([confidence] * len(text)),
        backend="test",
    )


def test_five_noisy_reads_recover_the_known_plate() -> None:
    """AC 3, verbatim: five noisy reads of `GJ01AB1234` must vote to `GJ01AB1234`.

    Each read is wrong in a *different* position, which is how per-frame OCR noise actually behaves:
    every individual read here is wrong, and no majority of any single read exists.
    """
    truth = "GJ01AB1234"
    reads = [
        read("GJ01AB1234", 0.81),
        read("GJ01AB1284", 0.74),  # 8 for 3
        read("GJ0IAB1234", 0.69),  # I for 1
        read("GJ01A81234", 0.77),  # 8 for B
        read("GT01AB1234", 0.72),  # T for J
    ]

    voted = vote_reads(reads)

    assert voted is not None
    assert voted.text == truth
    assert voted.vote_count == 5
    assert 0.0 < voted.confidence <= 1.0


def test_per_character_confidence_outvotes_a_bare_majority() -> None:
    """Three confident-but-unsure reads must not beat two that are sure about that position.

    This is the whole reason the vote is weighted rather than counted. Without weighting, the
    majority string wins and the recogniser's own uncertainty — the most useful signal it produces —
    is discarded.
    """
    reads = [
        read("GJ01AB1284", 0.60, (0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.05, 0.9)),
        read("GJ01AB1284", 0.60, (0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.05, 0.9)),
        read("GJ01AB1284", 0.60, (0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.05, 0.9)),
        read("GJ01AB1234", 0.95, (0.99,) * 10),
        read("GJ01AB1234", 0.95, (0.99,) * 10),
    ]

    voted = vote_reads(reads)

    assert voted is not None
    assert voted.text == "GJ01AB1234"


def test_reads_of_a_different_length_do_not_vote_and_are_reported() -> None:
    """A 9-character read disagrees about *where* the characters are, so it must not vote.

    Aligning it positionally would let one dropped character corrupt every position after it — the
    quietest way a vote can produce a confident wrong answer.
    """
    reads = [
        read("GJ01AB1234", 0.80),
        read("GJ01AB1234", 0.78),
        read("GJ01AB123", 0.90),
    ]

    voted = vote_reads(reads)

    assert voted is not None
    assert voted.text == "GJ01AB1234"
    assert voted.vote_count == 2
    assert voted.reads_offered == 3


def test_a_single_read_is_a_real_result_not_a_failure() -> None:
    """On a gateway delivering ~4 fps a vehicle can genuinely show its plate once."""
    voted = vote_reads([read("GJ01AB1234", 0.66)])

    assert voted is not None
    assert voted.text == "GJ01AB1234"
    assert voted.vote_count == 1
    assert voted.unanimous


def test_unanimous_agreement_scores_above_a_split() -> None:
    """Agreement has to move the number, or the confidence is just the mean wearing a hat."""
    agreed = vote_reads([read("GJ01AB1234", 0.7) for _ in range(4)])
    split = vote_reads(
        [read("GJ01AB1234", 0.7), read("GJ01AB1284", 0.7),
         read("GJ01AB1274", 0.7), read("GJ01AB1264", 0.7)]
    )

    assert agreed is not None
    assert split is not None
    assert agreed.confidence > split.confidence


def test_no_usable_reads_votes_nothing() -> None:
    assert vote_reads([]) is None
    assert vote_reads([read("", 0.9)]) is None
