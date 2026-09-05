/**
 * Trace types, in their own module because `actions.ts` is `'use server'` and such a module may
 * export only async functions. Same reason `registry/types.ts` exists.
 */
import type { ApiPaths } from '@/src/lib/api/client';

export type TracePayload =
  ApiPaths['/api/v1/trace']['get']['responses'][200]['content']['application/json'];

export type TraceSighting = TracePayload['sightings'][number];
export type TraceSegment = TracePayload['segments'][number];
export type TraceCamera = TracePayload['cameras'][number];

export interface TraceState {
  trace: TracePayload | null;
  error: string | null;
  elapsedMs: number;
}

/** D3-09's natural-language query console, which shares this screen. */
export type QueryCompilePayload =
  ApiPaths['/api/v1/query/compile']['post']['responses'][200]['content']['application/json'];

export type QueryRunPayload =
  ApiPaths['/api/v1/query/run']['post']['responses'][200]['content']['application/json'];

export interface QueryCompileState {
  outcome: QueryCompilePayload | null;
  error: string | null;
}

export interface QueryRunState {
  result: QueryRunPayload | null;
  error: string | null;
}
