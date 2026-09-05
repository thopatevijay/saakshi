import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { AlertSeverity, WatchlistCategory } from '@saakshi/shared';
import { watchlistEntries } from '@saakshi/shared/db';
import { z } from 'zod';
import type { DbLike } from '../db/client.js';
import { parseCsv, type ParsedRow } from '../routes/bulk-import.js';
import {
  biometricKeysIn,
  normaliseForLookup,
  WatchlistEntityType,
  WatchlistSystem,
  type WatchlistMeta,
} from './provider.js';

/**
 * The CSV contract for `watchlist_entries`, and the loader behind `npm run seed:watchlist`.
 *
 * **Flat columns, one per real-system field — never a JSON blob in a cell.** D1-02 learned this the
 * hard way for cameras: a nested object in a CSV cell is not something a department can edit in
 * Excel and hand back, so the per-system detail (VAHAN's make/model/colour/RC status, SARTHI's DL
 * number and validity, eGujCop's FIR reference and wanted status, AFIS/NAFIS's subject reference)
 * gets a column each and is assembled into `meta` here. The column list *is* the field mapping in
 * `docs/watchlist-integration.md`, which is what makes that document checkable rather than
 * aspirational.
 *
 * **There is no biometric column and there never will be.** AFIS and NAFIS contribute a subject
 * *reference* and nothing else. Anything a caller smuggles in is refused by `biometricKeysIn`.
 */

const optional = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === undefined || v === '' ? null : v));

const bool = z
  .string()
  .trim()
  .optional()
  .transform((v) => v === undefined || v === '' || v.toLowerCase() === 'true');

const timestamp = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === undefined || v === '' ? null : v))
  .refine((v) => v === null || !Number.isNaN(Date.parse(v)), {
    message: 'not a parseable instant',
  });

/** The per-system detail columns, in the order `docs/watchlist-integration.md` documents them. */
const META_COLUMNS = [
  'make',
  'model',
  'colour',
  'owner_ref',
  'rc_status',
  'dl_no',
  'holder_ref',
  'dl_valid_to',
  'fir_ref',
  'police_station',
  'wanted_status',
  'subject_ref',
  'note',
  'provenance',
] as const;

export const WatchlistCsvRow = z
  .object({
    source_system: WatchlistSystem.default('manual'),
    source_ref: optional,
    category: WatchlistCategory,
    entity_type: WatchlistEntityType,
    plate: optional,
    person_ref: optional,
    severity: AlertSeverity.default('medium'),
    valid_from: timestamp,
    valid_to: timestamp,
    active: bool,
  })
  .catchall(z.string().optional())
  .superRefine((row, ctx) => {
    if (row.entity_type === 'vehicle' && row.plate === null) {
      ctx.addIssue({ code: 'custom', path: ['plate'], message: 'a vehicle entry needs a plate' });
    }
    if (row.entity_type === 'person' && row.person_ref === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['person_ref'],
        message: 'a person entry needs a person_ref',
      });
    }
    if (row.valid_to !== null && row.valid_from !== null && row.valid_to <= row.valid_from) {
      ctx.addIssue({
        code: 'custom',
        path: ['valid_to'],
        message: 'valid_to must be after valid_from',
      });
    }
  });
export type WatchlistCsvRow = z.infer<typeof WatchlistCsvRow>;

/** What actually goes into `watchlist_entries`, already normalised. */
export interface WatchlistEntryInput {
  category: WatchlistCategory;
  entityType: WatchlistEntityType;
  plateNormalized: string | null;
  personRef: string | null;
  sourceSystem: WatchlistSystem;
  sourceRef: string | null;
  severity: AlertSeverity;
  validFrom: string;
  validTo: string | null;
  active: boolean;
  meta: WatchlistMeta;
}

export interface RejectedRow {
  row: number;
  field: string;
  message: string;
}

export interface ParsedWatchlistBatch {
  received: number;
  valid: WatchlistEntryInput[];
  rejected: RejectedRow[];
}

function metaFrom(raw: Record<string, string | undefined>): WatchlistMeta {
  const meta: Record<string, unknown> = {};
  for (const column of META_COLUMNS) {
    const value = raw[column]?.trim();
    if (value !== undefined && value !== '') meta[column] = value;
  }
  return meta;
}

export function toEntry(
  row: WatchlistCsvRow,
  raw: Record<string, string | undefined>,
): WatchlistEntryInput {
  return {
    category: row.category,
    entityType: row.entity_type,
    // Stored normalised so an exact match is string equality and a fuzzy match compares
    // like-for-like — the property migration 0006's comment relies on.
    plateNormalized: row.plate === null ? null : normaliseForLookup(row.plate),
    personRef: row.person_ref,
    sourceSystem: row.source_system,
    sourceRef: row.source_ref,
    severity: row.severity,
    validFrom: row.valid_from ?? new Date(0).toISOString(),
    validTo: row.valid_to,
    active: row.active,
    meta: metaFrom(raw),
  };
}

/**
 * Validates every row and partitions the batch.
 *
 * All rows, not first-failure: an officer importing 235 entries needs the whole error list in one
 * pass, which is the same rule D1-02's camera importer follows.
 */
export function validateWatchlistRows(rows: ParsedRow[]): ParsedWatchlistBatch {
  const valid: WatchlistEntryInput[] = [];
  const rejected: RejectedRow[] = [];

  for (const { row, raw } of rows) {
    const parsed = WatchlistCsvRow.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        rejected.push({ row, field: issue.path.join('.') || '(row)', message: issue.message });
      }
      continue;
    }
    const biometric = biometricKeysIn(raw);
    if (biometric.length > 0) {
      rejected.push({
        row,
        field: biometric.join(', '),
        message:
          'biometric fields are refused: SAAKSHI processes no biometrics and performs no face recognition',
      });
      continue;
    }
    valid.push(toEntry(parsed.data, raw));
  }

  return { received: rows.length, valid, rejected };
}

export function parseWatchlistCsv(text: string): ParsedWatchlistBatch {
  return validateWatchlistRows(parseCsv(text));
}

export interface UpsertResult {
  inserted: number;
  updated: number;
}

/**
 * Upserts on `(source_system, source_ref)` — the natural key migration `0015` declares.
 *
 * Rows without a `source_ref` are plain inserts: a manually-entered entry from a radio call has no
 * upstream identifier, and inventing one to satisfy a key would be worse than letting it be keyed
 * by its id alone.
 *
 * `xmax = 0` distinguishes an insert from an update in the same statement. It is the one honest way
 * to get that count out of `ON CONFLICT` — anything else is a second round trip and a race.
 */
export async function upsertWatchlistEntries(
  db: DbLike,
  entries: WatchlistEntryInput[],
): Promise<UpsertResult> {
  if (entries.length === 0) return { inserted: 0, updated: 0 };

  const keyed = entries.filter((e) => e.sourceRef !== null);
  const unkeyed = entries.filter((e) => e.sourceRef === null);
  let inserted = 0;
  let updated = 0;

  if (keyed.length > 0) {
    const rows = await db
      .insert(watchlistEntries)
      .values(keyed)
      .onConflictDoUpdate({
        target: [watchlistEntries.sourceSystem, watchlistEntries.sourceRef],
        targetWhere: sql`source_ref is not null`,
        set: {
          category: sql`excluded.category`,
          entityType: sql`excluded.entity_type`,
          plateNormalized: sql`excluded.plate_normalized`,
          personRef: sql`excluded.person_ref`,
          severity: sql`excluded.severity`,
          validFrom: sql`excluded.valid_from`,
          validTo: sql`excluded.valid_to`,
          active: sql`excluded.active`,
          meta: sql`excluded.meta`,
        },
      })
      .returning({ isInsert: sql<boolean>`(xmax = 0)` });

    for (const row of rows) {
      if (row.isInsert) inserted += 1;
      else updated += 1;
    }
  }

  if (unkeyed.length > 0) {
    const rows = await db
      .insert(watchlistEntries)
      .values(unkeyed)
      .returning({ id: watchlistEntries.id });
    inserted += rows.length;
  }

  return { inserted, updated };
}

/** Reads the committed representative dataset. Its path is the mock providers' "upstream". */
export async function loadSeedCsv(path: string): Promise<ParsedWatchlistBatch> {
  return parseWatchlistCsv(await readFile(path, 'utf8'));
}
