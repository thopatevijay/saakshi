/**
 * What a tile says instead of spinning.
 *
 * *"A dead camera shows its trust reason, not a spinner forever"* is the acceptance criterion, and
 * the reason it is an acceptance criterion is P2 in PROJECT.md: **a dead camera is worse than no
 * camera, because it creates false assurance.** A black rectangle with a spinner over it says "wait
 * a moment". A black rectangle that says *"the last probe could not connect, 14:22 today"* says
 * "send a technician". The wall is where an officer decides which of those is true.
 *
 * Every sentence here is assembled from values the API resolved — `band` from the latest health
 * check, the failing signals from the stored breakdown — and **nothing is recomputed**. D1-08's
 * handoff: *"Never re-derive it. `dead` is resolved from the latest health check's `connectable`;
 * an unreachable camera keeps its last good score."* A wall that applied `trustScore >= 70` itself
 * would paint a camera that went dark yesterday green, which is exactly the assurance we exist to
 * remove.
 *
 * Colours come from `src/lib/registry/trust.ts` — the single source, shared with the map so a
 * camera cannot be amber on one screen and red on another.
 */
import { BAND_STYLE, bandKeyOf, type BandKey, type TrustBand } from '@/src/lib/registry/trust';

export interface TrustFacts {
  readonly band: TrustBand | null;
  readonly score: number | null;
  readonly checkedAt: string | null;
  readonly connectable: boolean | null;
  readonly decodable: boolean | null;
  readonly error: string | null;
  readonly measuredFps: number | null;
  readonly actualResolution: string | null;
  readonly failingSignals: readonly {
    signal: string;
    note: string;
    points: number;
    maxPoints: number;
  }[];
}

export interface TrustPresentation {
  readonly key: BandKey;
  readonly label: string;
  /** One line, always. This is what the tile shows in place of video when `playable` is false. */
  readonly headline: string;
  /** The specific measurement behind the headline, when there is one. */
  readonly detail: string | null;
  /**
   * Whether to open a connection at all.
   *
   * `dead` is the only band that stops a tile: the last probe could not connect, so opening a
   * socket costs the gateway a connection to learn what we already know. `untrusted` and `degraded`
   * still play — the footage exists and an officer may need it; what they get is a warning, not a
   * blank tile. That distinction is the difference between honest and unhelpful.
   */
  readonly playable: boolean;
}

const humanSignal: Record<string, string> = {
  blur: 'the image is too soft to read a plate from',
  night_usable: 'the night image is unusable',
  tamper: 'the frame looks obstructed or moved',
  fps: 'it delivers fewer frames than it claims',
  pts_drift: 'its timestamps drift',
  resolution: 'it delivers less resolution than declared',
  reachable: 'the probe could not reach it',
  decodable: 'the bytes it returned were not decodable video',
};

function whenChecked(checkedAt: string | null): string {
  if (checkedAt === null) return '';
  const when = new Date(checkedAt);
  return Number.isNaN(when.getTime()) ? '' : ` (last probed ${when.toLocaleString()})`;
}

export function presentTrust(trust: TrustFacts): TrustPresentation {
  const key = bandKeyOf(trust.band);
  const style = BAND_STYLE[key];
  const worst = trust.failingSignals[0] ?? null;
  const named =
    worst === null ? null : (humanSignal[worst.signal] ?? `signal “${worst.signal}” scored low`);

  switch (key) {
    case 'dead':
      return {
        key,
        label: style.label,
        headline: `No signal. The last probe could not connect${whenChecked(trust.checkedAt)}.`,
        // The prober's own sentence, verbatim. D1-03's error taxonomy exists so "the cookie
        // expired" and "the camera is down" are never reported as the same thing, and passing its
        // words straight through is how that distinction survives to the screen.
        detail:
          trust.error ??
          'The score beside this camera is whatever it was when it last answered — it is not a ' +
            'statement about now.',
        playable: false,
      };

    case 'untrusted':
      return {
        key,
        label: style.label,
        headline:
          `Reachable, but measured badly enough that evidence from it should be questioned` +
          `${whenChecked(trust.checkedAt)}.`,
        detail:
          named === null
            ? style.meaning
            : `Scored ${trust.score?.toFixed(0) ?? '—'}/100 — worst signal: ${named}.`,
        playable: true,
      };

    case 'degraded':
      return {
        key,
        label: style.label,
        headline: `Playing, but a measured signal is out of tolerance${whenChecked(trust.checkedAt)}.`,
        detail:
          named === null
            ? style.meaning
            : `Scored ${trust.score?.toFixed(0) ?? '—'}/100 — worst signal: ${named}.`,
        playable: true,
      };

    case 'unscored':
      return {
        key,
        label: style.label,
        headline: 'Never probed. Nothing is known about this stream’s quality.',
        // The distinction the registry exists to keep: absence of evidence is not evidence of a
        // fault, and it must not be drawn as a bad score.
        detail:
          'This is an absence of evidence, not a bad result. The tile plays; no claim is made ' +
          'about what it shows.',
        playable: true,
      };

    case 'trusted':
      return {
        key,
        label: style.label,
        headline: `Trusted — every measured signal is within tolerance${whenChecked(trust.checkedAt)}.`,
        detail:
          trust.measuredFps === null
            ? null
            : `Measured ${trust.measuredFps.toFixed(1)} fps${
                trust.actualResolution === null ? '' : ` at ${trust.actualResolution}`
              }.`,
        playable: true,
      };
  }
}
