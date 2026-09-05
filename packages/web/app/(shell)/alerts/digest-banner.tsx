'use client';

/**
 * The digest row — what the rate limiter did **not** show the operator, and why.
 *
 * D2-06 caps *delivery*, never persistence: when a camera storms, the alerts beyond the cap are
 * still written and still auditable, but they do not reach the stream. A queue that silently
 * dropped them would be the worst possible failure of this screen — an operator would have no way
 * to know the queue was incomplete, and would reasonably assume a quiet minute was a quiet minute.
 *
 * So the digest is rendered as a row *in the queue*, not as a toast that disappears. It names the
 * window, the count, and the breakdown by severity and camera, and it carries the ids of a sample
 * so the suppression is clickable rather than merely a number.
 */
import { CATEGORY_LABEL, SEVERITY_STYLE, formatClock } from '@/src/lib/alerts/present';
import type { AlertDigest, WatchlistCategory } from '@saakshi/shared';

function Counts({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (entries.length === 0) return <span className="text-slate-500">none</span>;
  return (
    <>
      {entries.map(([key, n], index) => (
        <span key={key}>
          {index === 0 ? '' : ' · '}
          <span className="text-slate-200">{String(n)}</span> {label(key)}
        </span>
      ))}
    </>
  );
}

function label(key: string): string {
  if (key in SEVERITY_STYLE) return SEVERITY_STYLE[key as keyof typeof SEVERITY_STYLE].label;
  if (key in CATEGORY_LABEL) return CATEGORY_LABEL[key as WatchlistCategory];
  return key;
}

export function DigestBanner({ digest }: { digest: AlertDigest }) {
  return (
    <div
      data-testid="alert-digest"
      role="status"
      className="border-b border-amber-900/60 bg-amber-950/25 px-6 py-3"
    >
      <p className="text-[11px] font-semibold tracking-wide text-amber-300 uppercase">
        Delivery cap reached — {digest.suppressedCount} alert
        {digest.suppressedCount === 1 ? '' : 's'} not shown live
      </p>
      <p className="mt-1 text-xs text-amber-100/80">
        {formatClock(digest.windowStart)}–{formatClock(digest.windowEnd)} · delivered{' '}
        {digest.deliveredCount} · suppressed {digest.suppressedCount}. They are stored and
        auditable, and clearing a filter or reloading the queue shows them.
      </p>
      <p className="mt-1 text-[11px] text-amber-100/70">
        by severity: <Counts counts={digest.bySeverity} /> · by category:{' '}
        <Counts counts={digest.byCategory} /> · cameras involved:{' '}
        {Object.keys(digest.byCamera).length}
      </p>
    </div>
  );
}
