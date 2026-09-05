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
