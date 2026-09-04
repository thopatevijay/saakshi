"""Reconnect backoff: 2 s doubling to a 30 s cap.

A deliberate mirror of `packages/api/src/adapters/backoff.ts`, not an independent invention — the
two must agree, because a Python worker and a Node adapter hammering the same government gateway at
different rates is one gateway's view of one integrator. The TS file carries the full rationale; the
short version is that a tight reconnect loop against a government host is indistinguishable from a
denial-of-service attempt.
"""

from __future__ import annotations

import random

BACKOFF_BASE_MS = 2_000
BACKOFF_CAP_MS = 30_000


def backoff_delay_ms(attempt: int, jitter: float = 0.0, rng: random.Random | None = None) -> int:
    """Delay before attempt `attempt` (0-based), in milliseconds.

    Sequence: 2s, 4s, 8s, 16s, 30s, 30s, … — 32s would exceed the cap, so it clamps there.
    Jitter is applied **downward only**, so the cap is never exceeded: many cameras reconnecting
    after the same gateway blip must not arrive in a synchronised herd.
    """
    raw = BACKOFF_BASE_MS * 2 ** max(0, attempt)
    capped = min(raw, BACKOFF_CAP_MS)
    if jitter <= 0:
        return capped
    source = rng or random
    return round(capped * (1 - jitter * source.random()))


def backoff_sequence_ms(count: int) -> list[int]:
    """The first `count` delays — for logging, and for the test that asserts the ladder."""
    return [backoff_delay_ms(i) for i in range(count)]
