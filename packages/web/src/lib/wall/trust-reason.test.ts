import { describe, expect, it } from 'vitest';
import { presentTrust, type TrustFacts } from './trust-reason';

const facts = (over: Partial<TrustFacts> = {}): TrustFacts => ({
  band: null,
  score: null,
  checkedAt: null,
  connectable: null,
  decodable: null,
  error: null,
  measuredFps: null,
  actualResolution: null,
  failingSignals: [],
  ...over,
});

describe('presentTrust', () => {
  it('stops a dead tile from opening a connection, and says why instead of spinning', () => {
    const shown = presentTrust(
      facts({
        band: 'dead',
        score: 88,
        connectable: false,
        error: 'connection refused after 3 attempts',
        checkedAt: '2026-09-05T08:52:00.000Z',
      }),
    );
    expect(shown.playable).toBe(false);
    expect(shown.headline).toContain('could not connect');
    expect(shown.detail).toBe('connection refused after 3 attempts');
  });

  it('does not present a dead camera’s stale score as a statement about now', () => {
    const shown = presentTrust(facts({ band: 'dead', score: 88, connectable: false }));
    expect(shown.detail).toContain('it is not a statement about now');
    // The 88 must not appear as a headline claim about a camera that is dark.
    expect(shown.headline).not.toContain('88');
  });

  it('still plays an untrusted camera — the footage exists — but names the worst signal', () => {
    const shown = presentTrust(
      facts({
        band: 'untrusted',
        score: 35,
        failingSignals: [{ signal: 'blur', note: 'blur 6.8', points: 0, maxPoints: 25 }],
      }),
    );
    expect(shown.playable).toBe(true);
    expect(shown.detail).toContain('35/100');
    expect(shown.detail).toContain('too soft to read a plate');
  });

  it('describes a degraded camera as playing with a caveat, not as broken', () => {
    const shown = presentTrust(
      facts({
        band: 'degraded',
        score: 55,
        failingSignals: [{ signal: 'tamper', note: 'obstructed', points: 2, maxPoints: 15 }],
      }),
    );
    expect(shown.playable).toBe(true);
    expect(shown.headline).toContain('out of tolerance');
    expect(shown.detail).toContain('obstructed or moved');
  });

  it('renders never-probed as an absence of evidence, never as a low score', () => {
    const shown = presentTrust(facts({ band: null }));
    expect(shown.key).toBe('unscored');
    expect(shown.playable).toBe(true);
    expect(shown.detail).toContain('absence of evidence');
    expect(shown.headline).not.toMatch(/bad|poor|fail/i);
  });

  it('reports a trusted camera’s measured numbers, which is the whole claim', () => {
    const shown = presentTrust(
      facts({ band: 'trusted', score: 100, measuredFps: 25, actualResolution: '854x480' }),
    );
    expect(shown.playable).toBe(true);
    expect(shown.detail).toContain('25.0 fps');
    expect(shown.detail).toContain('854x480');
  });

  it('falls back to the band’s own meaning when no signal is named', () => {
    const shown = presentTrust(facts({ band: 'untrusted', score: 30 }));
    expect(shown.detail).toContain('questioned');
  });

  it('never returns an empty headline for any band, which is what a spinner would be', () => {
    for (const band of ['trusted', 'degraded', 'untrusted', 'dead', null] as const) {
      expect(presentTrust(facts({ band })).headline.length).toBeGreaterThan(20);
    }
  });
});
