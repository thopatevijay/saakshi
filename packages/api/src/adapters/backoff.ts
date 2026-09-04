/**
 * Reconnect backoff: 2 s doubling to a 30 s cap.
 *
 * The cap is the point. A tight reconnect loop against a government gateway is indistinguishable
 * from a denial-of-service attempt, and it is the fastest way to get an integrator's IP blocked —
 * which would end the project, not just the stream. Feeds also loop and reconnect routinely, so
 * this path runs often and must stay quiet.
 */

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CAP_MS = 30_000;

/**
 * Delay before attempt `n` (0-based), in milliseconds.
 *
 * Sequence: 2s, 4s, 8s, 16s, 30s, 30s, … — 32s would exceed the cap, so it clamps there and stays.
 */
export function backoffDelayMs(attempt: number, jitter = 0): number {
  const raw = BACKOFF_BASE_MS * 2 ** Math.max(0, attempt);
  const capped = Math.min(raw, BACKOFF_CAP_MS);
  if (jitter === 0) return capped;
  // Full jitter, applied downward only so the cap is never exceeded: many workers reconnecting
  // after the same gateway blip must not arrive in a synchronised thundering herd.
  return Math.round(capped * (1 - jitter * Math.random()));
}

/** The first `count` delays, for logging and for the test that asserts the sequence. */
export function backoffSequenceMs(count: number): number[] {
  return Array.from({ length: count }, (_, i) => backoffDelayMs(i));
}

export interface RetryOptions {
  /** Give up after this many attempts. `Infinity` for a long-running ingest worker. */
  maxAttempts?: number;
  /** 0–1. Defaults to 0.2 in production; tests pass 0 for a deterministic sequence. */
  jitter?: number;
  /** Injected so tests do not actually wait 30 seconds. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  /** Return false to fail immediately — an `AuthError` will never fix itself by waiting. */
  shouldRetry?: (error: unknown) => boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `task`, retrying with the backoff above.
 *
 * `shouldRetry` matters as much as the delays: retrying an `AuthError` is pure noise against the
 * gateway, because a rejected cookie is still rejected thirty seconds later. Only transport
 * failures are worth waiting on.
 */
export async function withBackoff<T>(
  task: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 6,
    jitter = 0.2,
    sleep = defaultSleep,
    onRetry,
    shouldRetry = () => true,
  } = options;

  let attempt = 0;
  for (;;) {
    try {
      return await task(attempt);
    } catch (error) {
      attempt += 1;
      if (attempt >= maxAttempts || !shouldRetry(error)) throw error;

      const delayMs = backoffDelayMs(attempt - 1, jitter);
      onRetry?.(attempt, delayMs, error);
      await sleep(delayMs);
    }
  }
}
