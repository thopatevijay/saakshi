'use client';

/**
 * One alert, in one row, verifiable without a click.
 *
 * ## The brief, and what it actually means on this estate
 *
 * The ticket's design brief is one sentence: *an officer must be able to confirm or dismiss an alert
 * in three seconds without leaving the row.* Taken naively that is a plea for bigger badges. It is
 * the opposite. On this estate the identification underneath is very weak —
 *
 *   - D2-01 measured **0 exact plate reads** across 120 hand-labelled instances; 3 were legible.
 *   - D2-03 rejected all 15 strings the live run produced, `757508300` — a hoarding's phone number
 *     and the run's best read at 0.888 — included.
 *   - D2-08 opened every evidence crop by hand and confirmed **none** of them as the vehicle.
 *
 * — so a row that renders a confident badge makes the officer *slower*, because they then have to
 * dig to find out the badge was worthless. The fastest correct verdict here is usually **"this is
 * not identifiable"**, and this row's first column is the one that says so. Severity comes second.
 * The score comes last, labelled, never bare.
 *
 * ## The five facts, and the sixth
 *
 * The AC names five things that must be legible with no click — plate, camera, time, category,
 * confidence — and each carries a `data-testid` that `scripts/verify-alerts.mjs` stopwatches. The
 * sixth is the verdict headline (`present.ts` `readability()`), which is deliberately first in
 * reading order and first in the DOM.
 *
 * ## Fixed height
 *
 * `ROW_HEIGHT` is a constant the virtualiser depends on. The dismiss-reason field therefore
 * *replaces* the action buttons in place rather than growing the row: growing it would shift every
 * row below, which is the exact failure AC 1 forbids, arriving from inside instead of from the
 * stream.
 */
import { useState } from 'react';
import {
  canTransition,
  type AlertWithRetention as AlertRecord,
  type AlertStatus,
} from '@saakshi/shared';
import {
  CATEGORY_LABEL,
  MATCH_STYLE,
  SEVERITY_STYLE,
  STATUS_LABEL,
  STATUS_STYLE,
  STRENGTH_COPY,
  cropState,
  formatAge,
  formatClock,
  formatDistance,
  formatScore,
  readability,
} from '@/src/lib/alerts/present';

/** Must match the row's rendered height exactly — `queue.ts` `windowFor` does the arithmetic. */
export const ROW_HEIGHT = 104;

/**
 * 11 px is a floor, not a style choice.
 *
 * Category and match type are two of the five facts AC 3 requires to be *legible* without a click,
 * and `verify-alerts.mjs` refuses anything under 11 px for exactly that reason. The first draft of
 * this row set them at 10 px and the stopwatch check failed on it — which is the check working.
 */
const CHIP =
  'inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] leading-tight font-semibold tracking-wide uppercase';
const ACTION =
  'rounded-md border px-2 py-1 text-[11px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-30 disabled:cursor-not-allowed';

export interface AlertRowProps {
  alert: AlertRecord;
  focused: boolean;
  expanded: boolean;
  mayAct: boolean;
  busy: boolean;
  onFocusRow: () => void;
  onToggleExpand: () => void;
  onTransition: (to: AlertStatus, note?: string) => void;
  /** Opens the reason field. Held by the screen so `d` from the keyboard opens the same field. */
  dismissing: boolean;
  onDismissOpen: (open: boolean) => void;
}

export function AlertRow({
  alert,
  focused,
  expanded,
  mayAct,
  busy,
  onFocusRow,
  onToggleExpand,
  onTransition,
  dismissing,
  onDismissOpen,
}: AlertRowProps) {
  const [note, setNote] = useState('');

  const identification = alert.reason.identification;
  const verdict = readability({
    validity: identification.validity,
    grammarValid: identification.grammarValid,
    observedPlate: identification.observedPlate,
    watchlistValue: identification.watchlistValue,
    missingChars: identification.missingChars,
    rejectionCodes: identification.rejectionCodes,
  });
  const severity = SEVERITY_STYLE[alert.severity];
  const match = MATCH_STYLE[alert.matchType];
  const strength = STRENGTH_COPY[identification.strength];
  const crop = cropState(alert.reason.evidence);
  const terminal = alert.status === 'dismissed';

  const allow = (to: AlertStatus): boolean => mayAct && !busy && canTransition(alert.status, to);

  return (
    <div
      data-testid="alert-row"
      data-alert-id={alert.id}
      data-match-type={alert.matchType}
      data-severity={alert.severity}
      data-status={alert.status}
      role="listitem"
      tabIndex={focused ? 0 : -1}
      aria-current={focused ? 'true' : undefined}
      aria-expanded={expanded}
      aria-label={`${severity.label} ${CATEGORY_LABEL[alert.category]} alert, read ${identification.observedPlate}, ${verdict.headline}, ${alert.reason.camera.name}, ${formatClock(alert.lastSeenAt)}`}
      onFocus={onFocusRow}
      style={{ height: `${String(ROW_HEIGHT)}px` }}
      className={`grid grid-cols-[4px_5rem_minmax(11rem,1.4fr)_minmax(9rem,1fr)_6.5rem_9rem_7rem_auto] items-center gap-3 border-b border-slate-800 pr-3 outline-none transition-colors ${
        focused ? 'bg-slate-800/70 ring-2 ring-inset ring-sky-400' : 'hover:bg-slate-900/70'
      } ${terminal ? 'opacity-55' : ''}`}
    >
      {/* Severity rail — colour, plus the word in the chip below. Never colour alone. */}
      <span aria-hidden="true" className={`h-full w-1 ${severity.rail}`} />

      {/* ── the crop ──────────────────────────────────────────────────────────────────────── */}
      <div
        data-testid="alert-crop"
        className="flex h-[72px] w-20 items-center justify-center overflow-hidden rounded border border-slate-700 bg-slate-950 text-center"
      >
        {crop.kind === 'image' ? (
          // A plain <img>: the crop is a presigned URL with a 900 s life, and next/image would
          // proxy and cache a URL that expires.
          <img
            src={crop.url}
            alt={`Plate crop from ${alert.reason.camera.name} at ${formatClock(alert.ts)}`}
            className="max-h-[72px] w-auto"
            onError={(event) => {
              // Degrade in place. An <img> that 403s renders as a broken-image glyph, which reads
              // as a bug rather than as an expired link.
              event.currentTarget.dataset['broken'] = 'true';
              event.currentTarget.style.display = 'none';
            }}
          />
        ) : null}
        {crop.kind === 'image' ? null : (
          /* 10 px slate-300, not 9 px slate-500. On this estate `crop_uri` is null on all 28,438
             sightings, so this placeholder is what an operator reads on *every* row — the
             most-read text on the screen. Lighthouse measured the first draft at 4.23:1. */
          <span
            data-testid="alert-crop-placeholder"
            className="px-1 text-[10px] leading-tight text-slate-300"
          >
            {crop.kind === 'none'
              ? 'no crop stored'
              : crop.kind === 'unconfigured'
                ? 'no object store'
                : 'link expired'}
          </span>
        )}
      </div>

      {/* ── the verdict, then the read ────────────────────────────────────────────────────── */}
      <div className="min-w-0">
        <p
          data-testid="alert-verdict"
          className={`truncate text-[11px] font-semibold tracking-wide uppercase ${verdict.tone}`}
        >
          {verdict.headline}
        </p>
        <p className="flex items-baseline gap-2">
          <span
            data-testid="alert-plate"
            className="truncate font-mono text-base font-semibold tracking-wider text-slate-100"
          >
            {identification.observedPlate}
          </span>
          {alert.matchType === 'fuzzy' ? (
            <span className="truncate font-mono text-xs text-amber-300">
              ≠ {identification.watchlistValue}
            </span>
          ) : null}
        </p>
        <p className="truncate text-[11px] text-slate-400" title={alert.reason.explanation}>
          {alert.reason.explanation}
        </p>
      </div>

      {/* ── camera ───────────────────────────────────────────────────────────────────────── */}
      <div className="min-w-0">
        <p data-testid="alert-camera" className="truncate text-sm text-slate-200">
          {alert.reason.camera.name}
        </p>
        <p className="truncate text-[11px] text-slate-400">
          {alert.reason.camera.externalId}
          {' · '}
          {/* An unmeasured trust score is never a zero and never a grey bar (D1-06, D2-06). */}
          {alert.reason.camera.trustScore === null
            ? 'trust never probed'
            : `trust ${String(Math.round(alert.reason.camera.trustScore))}`}
        </p>
        <p className="truncate text-[11px] text-slate-400">
          {alert.reason.camera.location === null
            ? 'no location on file'
            : (alert.reason.camera.district ?? 'located')}
        </p>
      </div>

      {/* ── time ─────────────────────────────────────────────────────────────────────────── */}
      <div className="min-w-0">
        <p data-testid="alert-time" className="text-sm text-slate-200 tabular-nums">
          {formatClock(alert.lastSeenAt)}
        </p>
        <p className="text-[11px] text-slate-400 tabular-nums">{formatAge(alert.lastSeenAt)} ago</p>
        {alert.sightingCount > 1 ? (
          <p className="text-[11px] font-semibold text-amber-300 tabular-nums">
            ×{alert.sightingCount} sightings
          </p>
        ) : null}
      </div>

      {/* ── category and severity ────────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-col items-start gap-1">
        <span
          data-testid="alert-category"
          className={`${CHIP} ${severity.chip} max-w-full truncate`}
        >
          {CATEGORY_LABEL[alert.category]}
        </span>
        <span className={`${CHIP} ${severity.chip}`}>{severity.label}</span>
        <span className={`${CHIP} ${STATUS_STYLE[alert.status]}`}>
          {STATUS_LABEL[alert.status]}
        </span>
      </div>

      {/* ── the match, and the numbers, always labelled ──────────────────────────────────── */}
      <div className="min-w-0">
        <span data-testid="alert-match" className={`${CHIP} ${match.chip}`}>
          {match.short}
          {' · d '}
          {formatDistance(alert.matchDistance)}
        </span>
        <p data-testid="alert-confidence" className="mt-1 text-[11px] text-slate-300 tabular-nums">
          combined{' '}
          <span className="font-semibold text-slate-100">{formatScore(alert.confidence)}</span>
        </p>
        <p className={`text-[11px] font-semibold ${strength.tone}`}>
          {strength.label} identification
        </p>
      </div>

      {/* ── actions — one key or one click, in the row ───────────────────────────────────── */}
      <div className="flex flex-col items-stretch gap-1">
        {dismissing ? (
          <div className="flex items-center gap-1">
            <label className="sr-only" htmlFor={`dismiss-${alert.id}`}>
              Reason for dismissing
            </label>
            <input
              id={`dismiss-${alert.id}`}
              data-testid="alert-dismiss-note"
              autoFocus
              value={note}
              placeholder="Reason (required)"
              onChange={(event) => {
                setNote(event.target.value);
              }}
              onKeyDown={(event) => {
                // The field owns its own keys: `d` typed into a reason must not dismiss the row.
                event.stopPropagation();
                if (event.key === 'Escape') onDismissOpen(false);
                if (event.key === 'Enter' && note.trim() !== '') {
                  onTransition('dismissed', note);
                  setNote('');
                }
              }}
              className="w-40 rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-[11px] text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-400"
            />
            <button
              type="button"
              data-testid="alert-dismiss-confirm"
              disabled={note.trim() === '' || busy}
              onClick={() => {
                onTransition('dismissed', note);
                setNote('');
              }}
              className={`${ACTION} border-rose-700 text-rose-200 hover:bg-rose-950/50 focus-visible:outline-rose-400`}
            >
              Dismiss
            </button>
          </div>
        ) : (
          <div className="flex gap-1">
            <button
              type="button"
              data-testid="alert-ack"
              disabled={!allow('ack')}
              onClick={() => {
                onTransition('ack');
              }}
              title="Acknowledge (a)"
              className={`${ACTION} border-sky-800 text-sky-200 hover:bg-sky-950/50 focus-visible:outline-sky-400`}
            >
              Ack <kbd className="text-slate-400">a</kbd>
            </button>
            <button
              type="button"
              data-testid="alert-dismiss"
              disabled={!allow('dismissed')}
              onClick={() => {
                onDismissOpen(true);
              }}
              title="Dismiss — needs a reason (d)"
              className={`${ACTION} border-rose-800 text-rose-200 hover:bg-rose-950/50 focus-visible:outline-rose-400`}
            >
              Dismiss <kbd className="text-slate-400">d</kbd>
            </button>
            <button
              type="button"
              data-testid="alert-escalate"
              disabled={!allow('escalated')}
              onClick={() => {
                onTransition('escalated');
              }}
              title="Escalate (e)"
              className={`${ACTION} border-violet-800 text-violet-200 hover:bg-violet-950/50 focus-visible:outline-violet-400`}
            >
              Escalate <kbd className="text-slate-400">e</kbd>
            </button>
          </div>
        )}
        <button
          type="button"
          data-testid="alert-expand"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          className="rounded-md border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          {expanded ? 'Hide evidence' : 'Evidence'} <kbd className="text-slate-400">↵</kbd>
        </button>
      </div>
    </div>
  );
}
