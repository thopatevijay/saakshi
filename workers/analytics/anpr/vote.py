"""Multi-frame voting — turning several noisy reads of one plate into one answer with a number.

Per-frame OCR on a 40-px plate is wrong in a *shallow* way: it usually gets most characters right
and mangles one or two, and it mangles a different one on each frame. Averaging strings is
meaningless, but voting **per character position, weighted by the recogniser's own per-character
confidence**, cancels exactly that kind of noise.

Two decisions that are easy to get wrong:

- **Reads of different lengths are not aligned, they are separated.** An 8-character read and a
  9-character read of the same plate disagree about *where* the characters are, so voting them
  position-by-position mixes unrelated columns. The modal length wins the weight, and only reads of
  that length vote. The losers are still counted, and the loss is reported.
- **The emitted confidence is not the mean of the input confidences.** It is agreement x certainty:
  five reads that all say `GJ01AB1234` deserve more confidence than any one of them alone, and five
  reads that each say something different deserve less. A mean cannot express either.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from .ocr import OcrRead

__all__ = ["VotedPlate", "vote_reads"]


@dataclass(frozen=True)
class VotedPlate:
    """The result of a vote. `text` is raw — D2-03 owns normalisation and grammar validation."""

    text: str
    #: Aggregate confidence in `[0, 1]`: mean over positions of (agreement x winning certainty).
    confidence: float
    #: Reads that actually voted — i.e. reads of the winning length. This is the `vote_count`
    #: column, so it must never be inflated with reads that were excluded.
    vote_count: int
    #: Reads offered in total, including those excluded for disagreeing about length. The gap
    #: between the two is a real quality signal and is reported rather than hidden.
    reads_offered: int
    #: Per-position agreement fractions, for the eval report.
    position_confidence: tuple[float, ...] = ()

    @property
    def unanimous(self) -> bool:
        return all(value >= 0.999 for value in self.position_confidence)


def vote_reads(reads: list[OcrRead]) -> VotedPlate | None:
    """Confidence-weighted per-character-position vote. `None` when nothing usable was offered.

    A single read is a legitimate result with `vote_count = 1`, not a failure: on a gateway
    delivering ~4 fps a vehicle can genuinely show its plate once. Pretending otherwise would drop
    real vehicles to make the vote statistics look better.
    """
    usable = [read for read in reads if read.text]
    if not usable:
        return None

    # Modal length, weighted by read confidence rather than counted: three low-confidence 7-char
    # reads should not outvote two high-confidence 10-char ones.
    length_weight: dict[int, float] = defaultdict(float)
    for read in usable:
        length_weight[len(read.text)] += max(read.confidence, 1e-6)
    winning_length = max(length_weight.items(), key=lambda item: (item[1], item[0]))[0]

    voters = [read for read in usable if len(read.text) == winning_length]
    characters: list[str] = []
    position_confidence: list[float] = []

    for index in range(winning_length):
        scores: dict[str, float] = defaultdict(float)
        for read in voters:
            char_conf = (
                read.char_confidences[index]
                if index < len(read.char_confidences)
                else read.confidence
            )
            # The read's own confidence times this character's: a read that is confident overall but
            # unsure about position 4 must not carry position 4.
            scores[read.text[index]] += max(read.confidence, 1e-6) * max(char_conf, 1e-6)
        total = sum(scores.values())
        winner, winner_score = max(scores.items(), key=lambda item: item[1])
        characters.append(winner)
        position_confidence.append(winner_score / total if total > 0 else 0.0)

    agreement = sum(position_confidence) / len(position_confidence) if position_confidence else 0.0
    # Certainty: how sure the winning votes themselves were. Agreement alone would score five
    # identical guesses of 0.1 confidence as certain.
    certainty = sum(read.confidence for read in voters) / len(voters)
    return VotedPlate(
        text="".join(characters),
        confidence=round(min(1.0, max(0.0, agreement * certainty)), 3),
        vote_count=len(voters),
        reads_offered=len(usable),
        position_confidence=tuple(round(value, 3) for value in position_confidence),
    )
