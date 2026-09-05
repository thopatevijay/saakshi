/**
 * Alert queue types, in their own module because `actions.ts` is `'use server'` and such a module
 * may export only async functions. Same reason `trace/types.ts` and `registry/types.ts` exist.
 *
 * The record itself comes from `@saakshi/shared` rather than from the generated OpenAPI types: it
 * is the same zod object the API validates its response against, `AlertRecord`, and using it here
 * means the discriminated `reason` payload keeps its literal types (`live: false`, the four
 * `IdentificationStrength` members) instead of widening to `boolean` and `string` through JSON
 * Schema. The *request* shapes still come from the generated client.
 */
import { AlertWithRetention } from '@saakshi/shared';
import type { AlertDigest } from '@saakshi/shared';

export type { AlertDigest };

/**
 * What the queue renders.
 *
 * `AlertWithRetention`, not the bare `AlertRecord`: `GET /api/v1/alerts` carries the retention clock
 * on the footage behind each alert (D3-05), and `z.object` **strips** unknown keys — re-parsing
 * against the unextended record would silently drop `retention` and the detail panel would lose the
 * "this evidence expires in N days" line without anything failing. Exported as a value as well as a
 * type because `actions.ts` parses with it.
 */
export const AlertRecord = AlertWithRetention;
export type AlertRecord = AlertWithRetention;

/** One page of the queue, plus the disclaimer D2-06 repeats on every response. */
export interface AlertPage {
  alerts: AlertRecord[];
  nextCursor: string | null;
  disclaimer: string;
  error: string | null;
  elapsedMs: number;
}

export interface AlertOption {
  id: string;
  label: string;
}

/** What the filter row needs to render names instead of uuids. */
export interface FilterOptions {
  cameras: AlertOption[];
  departments: AlertOption[];
}

/** The outcome of a lifecycle transition, as the screen needs to branch on it. */
export type TransitionResult =
  | { ok: true; alert: AlertRecord }
  | { ok: false; kind: 'conflict' | 'forbidden' | 'gone' | 'error'; message: string };
