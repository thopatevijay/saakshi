import { z } from 'zod';
import { CameraCreate, type BulkImportReport } from './camera-contracts.js';

/**
 * Bulk import parsing and row-level validation.
 *
 * Model 1 names bulk import as one of three mandatory onboarding paths, and the scored requirement
 * is not "it works" but "a file with bad rows tells you which rows and why". So parsing and
 * validation are separated from the database write entirely: this module turns bytes into
 * `{ valid, rejected }` and never touches a connection.
 */

export type BulkFormat = 'csv' | 'json';

export interface ParsedRow {
  /** 1-based over data rows, so it matches what a spreadsheet shows the operator. */
  row: number;
  raw: Record<string, string | undefined>;
}

export interface ValidatedBatch {
  received: number;
  valid: { row: number; camera: CameraCreate }[];
  rejected: BulkImportReport['rejected'];
}

/**
 * RFC 4180-ish CSV reader: quoted fields, embedded commas, doubled quotes, CRLF or LF.
 *
 * Hand-rolled rather than pulling a dependency, because the input is a flat metadata export from a
 * department — no embedded newlines to speak of — and a 40-line reader we can read beats another
 * package in the tree.
 */
export function parseCsv(text: string): ParsedRow[] {
  const rows: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      field = '';
      rows.push(record);
      record = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    rows.push(record);
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  const header = nonEmpty.shift();
  if (header === undefined) return [];

  const keys = header.map((h) => h.trim());
  return nonEmpty.map((cells, idx) => {
    const raw: Record<string, string | undefined> = {};
    keys.forEach((key, col) => {
      const value = cells[col]?.trim();
      raw[key] = value === '' ? undefined : value;
    });
    return { row: idx + 1, raw };
  });
}

export function parseJsonRows(text: string): ParsedRow[] {
  const parsed: unknown = JSON.parse(text);
  // Both shapes are accepted: a bare array, or `{ cameras: [...] }` as an export wrapper.
  const list = Array.isArray(parsed)
    ? parsed
    : z.object({ cameras: z.array(z.unknown()) }).parse(parsed).cameras;

  return list.map((item, idx) => ({
    row: idx + 1,
    raw: item as Record<string, string | undefined>,
  }));
}

/**
 * Validates every row and partitions the batch.
 *
 * Note that it validates *all* rows rather than stopping at the first failure: an operator
 * importing 500 cameras needs the whole error list in one pass, not one error per re-upload.
 */
export function validateBatch(rows: ParsedRow[]): ValidatedBatch {
  const valid: { row: number; camera: CameraCreate }[] = [];
  const rejected: BulkImportReport['rejected'] = [];
  const seen = new Map<string, number>();

  for (const { row, raw } of rows) {
    const parsed = CameraCreate.safeParse(raw);

    if (!parsed.success) {
      rejected.push({
        row,
        externalId: typeof raw['externalId'] === 'string' ? raw['externalId'] : null,
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      });
      continue;
    }

    // A file that lists the same camera twice would make the batch's own upsert fight itself
    // ("ON CONFLICT DO UPDATE command cannot affect row a second time"), so it is a row error, not
    // a 500.
    const key = `${parsed.data.departmentId ?? '-'}::${parsed.data.externalId}`;
    const firstSeenAt = seen.get(key);
    if (firstSeenAt !== undefined) {
      rejected.push({
        row,
        externalId: parsed.data.externalId,
        errors: [
          {
            field: 'externalId',
            message: `duplicate of row ${firstSeenAt} within this file (same department)`,
          },
        ],
      });
      continue;
    }

    seen.set(key, row);
    valid.push({ row, camera: parsed.data });
  }

  return { received: rows.length, valid, rejected };
}

export function detectFormat(
  filename: string | undefined,
  contentType: string | undefined,
): BulkFormat {
  if (filename?.toLowerCase().endsWith('.json') === true) return 'json';
  if (filename?.toLowerCase().endsWith('.csv') === true) return 'csv';
  if (contentType?.includes('json') === true) return 'json';
  return 'csv';
}
