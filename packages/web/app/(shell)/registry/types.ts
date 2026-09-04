/**
 * Shared types for the registry screen.
 *
 * They cannot live in `actions.ts`: a `'use server'` module may export **only async functions**, so
 * an exported `interface` or `const` there fails the build. Splitting them out keeps the action
 * module a pure boundary and gives the client components something to import that carries no
 * runtime.
 */
import type { CameraListResponse } from '@/src/lib/api/client';

export type Camera = CameraListResponse['data'][number];

export interface CameraPage {
  cameras: Camera[];
  /** True when `MAX_MAP_FEATURES` stopped the paging before the server ran out of rows. */
  capped: boolean;
  /** Wall-clock milliseconds the API spent, for the benchmark and the footer. */
  elapsedMs: number;
  error: string | null;
}

/** Per-row failure from a bulk import. `row` is 1-based over data rows, matching a spreadsheet. */
export interface BulkRowError {
  row: number;
  externalId: string | null;
  errors: { field: string; message: string }[];
}

export interface ImportState {
  report: {
    received: number;
    imported: number;
    created: number;
    updated: number;
    format: string;
    committed: boolean;
    rejected: BulkRowError[];
  } | null;
  error: string | null;
}

export interface ManualAddState {
  created: { externalId: string; id: string } | null;
  error: string | null;
}

export interface SyncState {
  report: {
    added: number;
    updated: number;
    unchanged: number;
    wentAbsent: number;
    returned: number;
    fetched: number;
  } | null;
  error: string | null;
}
