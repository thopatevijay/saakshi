/**
 * How fast the stream is actually arriving, and what a tile should say about it.
 *
 * ## Why a tile needs this at all
 *
 * D1-03's handoff is emphatic: *"a slow gateway silently produces `measured fps (unknown)` and it
 * looks like a defect … do not diagnose a gateway symptom as a player bug."* The video wall is
 * where that mistake is most likely, because a stalling tile is indistinguishable from a broken
 * player by looking at it.
 *
 * The gateway was measured on 2026-09-05 delivering a **6.0 s** segment in **21.8–48.7 s** — a
 * *delivery rate of 0.12×–0.28× real time* on one connection. A player cannot fix that, and neither
 * can a bigger buffer: below 1.0× the stream can never catch up, by arithmetic. So the tile reports
 * the number rather than spinning, and an operator learns something true about their estate instead
 * of concluding the console is broken.
 *
 * The rate is computed from `hls.js`'s own `FRAG_LOADED` stats — the segment's playback duration
 * over the wall time it took to arrive — so it measures the whole path (relay included, cache
 * included) exactly as the player experiences it.
 */

export interface FragmentTiming {
  /** Playback seconds this fragment contains. */
  readonly durationS: number;
  /** Wall-clock milliseconds it took to arrive. */
  readonly loadMs: number;
}

/** Playback seconds delivered per second of wall clock. 1.0 is exactly real time. */
export function deliveryRate(timing: FragmentTiming): number | null {
  if (timing.durationS <= 0 || timing.loadMs <= 0) return null;
  return timing.durationS / (timing.loadMs / 1000);
}

/**
 * A rolling rate over the recent fragments.
 *
 * Deliberately not a mean of ratios: one cached fragment arriving in 3 ms would score 2000× and
 * drag the average into nonsense. Total seconds over total milliseconds is what the player actually
 * experienced.
 */
export function rollingDeliveryRate(timings: readonly FragmentTiming[]): number | null {
  const usable = timings.filter((t) => t.durationS > 0 && t.loadMs > 0);
  if (usable.length === 0) return null;
  const seconds = usable.reduce((sum, t) => sum + t.durationS, 0);
  const millis = usable.reduce((sum, t) => sum + t.loadMs, 0);
  return millis === 0 ? null : seconds / (millis / 1000);
}

export type DeliveryVerdict = 'realtime' | 'marginal' | 'throttled' | 'unknown';

/**
 * The verdict a tile badge shows.
 *
 * `marginal` exists because 1.0× exactly is not a safe place to be: any jitter at all and the
 * buffer drains. Below 0.9× a stall is not a possibility but a certainty, and saying so is more
 * useful than a spinner.
 */
export function deliveryVerdict(rate: number | null): DeliveryVerdict {
  if (rate === null || !Number.isFinite(rate)) return 'unknown';
  if (rate >= 1.5) return 'realtime';
  if (rate >= 0.9) return 'marginal';
  return 'throttled';
}

/** The sentence. Written for an officer, not for a developer. */
export function deliveryReason(rate: number | null, verdict: DeliveryVerdict): string {
  const shown = rate === null ? '—' : `${rate.toFixed(2)}×`;
  switch (verdict) {
    case 'realtime':
      return `Upstream is delivering ${shown} real time. This tile is keeping up.`;
    case 'marginal':
      return `Upstream is delivering ${shown} real time — barely enough. Expect occasional pauses.`;
    case 'throttled':
      return (
        `Upstream is delivering ${shown} real time. Below 1.00× the stream cannot keep up no ` +
        'matter how long it buffers: the department gateway is throttling, not this console.'
      );
    case 'unknown':
      return 'Waiting for the first segment to measure the delivery rate.';
  }
}
