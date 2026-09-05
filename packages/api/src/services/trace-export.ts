/**
 * Trace exports (D2-08) — CSV for a spreadsheet, PDF for a judge.
 *
 * Both feed D4-03's government-feed output report, and both carry the same honesty the API payload
 * does: the link method and confidence sit **next to** every row, not in a footnote, because a
 * column of timestamps and camera names with no confidence beside it reads as a confirmed route.
 * On this estate that would be a false claim — D2-01 measured 0 exact plate reads over a
 * 120-instance sample, so almost every link in a real trace is fuzzy.
 *
 * The CSV's first eight columns are fixed by the ticket's acceptance criterion, in its order:
 * `plate, camera_id, camera_name, lat, lon, timestamp, confidence, link_method`. Anything else is
 * appended after them, so a consumer that reads the first eight positionally keeps working.
 */
import {
  A4_LANDSCAPE,
  PdfPage,
  ellipsise,
  renderPdf,
  textWidth,
  type PdfFont,
} from './pdf.js';
import type { TraceResult, TraceSighting } from './trace.js';

/* ── CSV ─────────────────────────────────────────────────────────────────────────────────────── */

/** The eight columns the acceptance criterion names, in its order, then the extras. */
export const TRACE_CSV_COLUMNS = [
  'plate',
  'camera_id',
  'camera_name',
  'lat',
  'lon',
  'timestamp',
  'confidence',
  'link_method',
  'seq',
  'camera_external_id',
  'district',
  'located',
  'sighting_id',
  'frame_pts_ms',
  'track_id',
  'tracking_session',
  'raw_tracker_id',
  'vehicle_class',
  'det_confidence',
  'vehicle_color',
  'vehicle_color_confidence',
  'raw_plate_text',
  'ocr_confidence',
  'vote_count',
  'match_distance',
  'match_strength',
  'basis',
  'crop_uri',
  'explanation',
] as const;

export function traceCsv(result: TraceResult): string {
  const rows = [TRACE_CSV_COLUMNS.join(',')];
  for (const s of result.sightings) {
    rows.push(
      [
        s.plateNormalized,
        s.cameraId,
        s.cameraName,
        s.lat,
        s.lon,
        s.ts,
        s.linkConfidence,
        s.linkMethod,
        s.seq,
        s.cameraExternalId,
        s.district,
        s.located,
        s.sightingId,
        s.framePtsMs,
        s.trackId,
        s.trackingSession,
        s.rawTrackerId,
        s.class,
        s.detConfidence,
        s.vehicleColor,
        s.vehicleColorConfidence,
        s.plateRawText,
        s.ocrConfidence,
        s.voteCount,
        s.matchDistance,
        s.matchStrength,
        s.basis,
        s.cropUri,
        s.explanation,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${rows.join('\n')}\n`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // A leading =, +, - or @ makes a spreadsheet evaluate the cell. Camera names come from an
  // external catalogue, so the guard belongs here rather than in a code review.
  const risky = /^[=+\-@\t\r]/.test(text);
  const body = risky ? `'${text}` : text;
  // Neutralised cells are quoted as well as prefixed, so the guard is visible in the file rather
  // than depending on a reader noticing a leading apostrophe.
  return risky || /[",\n\r]/.test(body) ? `"${body.replaceAll('"', '""')}"` : body;
}

/* ── PDF ─────────────────────────────────────────────────────────────────────────────────────── */

const MARGIN = 36;
const PAGE = A4_LANDSCAPE;
const ROW_HEIGHT = 14;
const HEADER_SIZE = 8;
const ROW_SIZE = 8;

interface Column {
  key: string;
  label: string;
  width: number;
  value: (s: TraceSighting) => string;
  align?: 'right';
}

const COLUMNS: Column[] = [
  { key: 'seq', label: '#', width: 20, value: (s) => String(s.seq) },
  { key: 'ts', label: 'Timestamp (UTC, from PTS)', width: 132, value: (s) => s.ts.replace('T', ' ').replace('Z', '') },
  { key: 'camera', label: 'Camera', width: 150, value: (s) => `${s.cameraExternalId} · ${s.cameraName}` },
  { key: 'loc', label: 'Lat, Lon', width: 100, value: (s) => (s.located ? `${fixed(s.lat, 5)}, ${fixed(s.lon, 5)}` : 'not placed') },
  { key: 'plate', label: 'Plate read', width: 88, value: (s) => s.plateNormalized },
  { key: 'raw', label: 'Raw OCR', width: 76, value: (s) => s.plateRawText },
  { key: 'method', label: 'Link method', width: 74, value: (s) => s.linkMethod },
  { key: 'conf', label: 'Link conf.', width: 52, value: (s) => s.linkConfidence.toFixed(2), align: 'right' },
  { key: 'ocr', label: 'OCR conf.', width: 52, value: (s) => s.ocrConfidence.toFixed(2), align: 'right' },
  { key: 'track', label: 'Session/track', width: 66, value: (s) => `${String(s.trackingSession)}/${String(s.rawTrackerId)}` },
  { key: 'basis', label: 'Basis', width: 50, value: (s) => s.basis },
];

/**
 * A trace report a judge can be handed.
 *
 * Page 1 carries the query, the window, the coverage counts and an explicit **observed vs
 * inferred** box; the sighting table then runs across as many pages as it needs, each with a
 * repeated header and a page number. Everything a reader needs to discount the result — how many
 * links were fuzzy, how many cameras had no coordinates, how many sightings had no crop — is on
 * the first page rather than discoverable only by reading every row.
 */
export function tracePdf(result: TraceResult, generatedAt: Date = new Date()): Buffer {
  const pages: PdfPage[] = [];
  let page = new PdfPage(PAGE);
  pages.push(page);

  const right = PAGE.width - MARGIN;
  let y = PAGE.height - MARGIN;

  page.text('SAAKSHI · Vehicle trace report', MARGIN, y, { size: 16, font: 'Helvetica-Bold' });
  y -= 18;
  page.text(
    'Gujarat Police Innovation Challenge 2026 — Pillar 3, vehicle movement history',
    MARGIN,
    y,
    { size: 9, grey: 0.4 },
  );
  y -= 8;
  page.line(MARGIN, y, right, y, { grey: 0.6, width: 1 });
  y -= 20;

  const queried = result.normalized === '' ? result.query : result.normalized;
  page.text(`Registration queried: ${queried}`, MARGIN, y, { size: 13, font: 'Helvetica-Bold' });
  y -= 16;

  for (const [label, value] of summaryRows(result, generatedAt)) {
    page.text(label, MARGIN, y, { size: 9, grey: 0.45 });
    page.text(value, MARGIN + 150, y, { size: 9 });
    y -= 12;
  }

  y -= 8;
  y = claimsBox(page, y, right, result);
  y -= 10;

  if (result.sightings.length === 0) {
    page.text('No sightings for this registration in the window.', MARGIN, y, {
      size: 11,
      font: 'Helvetica-Bold',
    });
    y -= 14;
    page.paragraph(emptyExplanation(result), MARGIN, y, right - MARGIN, { size: 9, grey: 0.35 });
    footer(pages, generatedAt);
    return renderPdf(pages, { title: `SAAKSHI vehicle trace — ${queried}`, subject: TITLE_SUBJECT });
  }

  y = tableHeader(page, y, right);

  for (const sighting of result.sightings) {
    if (y < MARGIN + 40) {
      page = new PdfPage(PAGE);
      pages.push(page);
      y = PAGE.height - MARGIN;
      page.text(`Vehicle trace · ${queried} (continued)`, MARGIN, y, {
        size: 11,
        font: 'Helvetica-Bold',
      });
      y -= 16;
      y = tableHeader(page, y, right);
    }
    // Fuzzy rows get a tinted band. A reader scanning the table can see at a glance how much of
    // this route rests on a possibility rather than a confirmed read.
    if (sighting.linkMethod !== 'plate_exact') {
      page.rect(MARGIN - 3, y - 3.5, right - MARGIN + 6, ROW_HEIGHT - 2, { grey: 0.94 });
    }
    let x = MARGIN;
    for (const column of COLUMNS) {
      const text = ellipsise(column.value(sighting), column.width - 6, ROW_SIZE);
      const offset = column.align === 'right' ? column.width - 6 - textWidth(text, ROW_SIZE) : 0;
      page.text(text, x + offset, y, { size: ROW_SIZE });
      x += column.width;
    }
    y -= ROW_HEIGHT;
  }

  footer(pages, generatedAt);
  return renderPdf(pages, { title: `SAAKSHI vehicle trace — ${queried}`, subject: TITLE_SUBJECT });
}

const TITLE_SUBJECT =
  'Vehicle movement history. Sightings are observed; identity links and the path between ' +
  'sightings are inferred.';

function summaryRows(result: TraceResult, generatedAt: Date): [string, string][] {
  const c = result.coverage;
  const window =
    result.window.from === null && result.window.to === null
      ? 'all time'
      : `${result.window.from ?? 'earliest'} → ${result.window.to ?? 'now'}`;
  return [
    ['Time window', window],
    ['Generated', generatedAt.toISOString()],
    ['Matcher', `${result.matcher} · max weighted distance ${result.maxDistance.toFixed(2)}`],
    ['Minimum confidence', result.minConfidence.toFixed(2)],
    [
      'Sightings',
      `${String(c.sightings)} across ${String(c.cameras)} camera(s) — ${String(c.exactLinks)} exact link(s), ` +
        `${String(c.fuzzyLinks)} fuzzy, ${String(c.otherLinks)} other`,
    ],
    [
      'Mappable',
      `${String(c.sightingsMappable)} of ${String(c.sightings)} sighting(s); ${String(c.camerasPlaced)} of ` +
        `${String(c.cameras)} camera(s) have coordinates`,
    ],
    ['Evidence crops held', `${String(c.sightingsWithCrop)} of ${String(c.sightings)}`],
    [
      'Dropped below confidence',
      `${String(c.droppedBelowConfidence)}${c.truncated ? ' · result truncated at the row cap' : ''}`,
    ],
  ];
}

function claimsBox(page: PdfPage, top: number, right: number, result: TraceResult): number {
  const width = right - MARGIN;
  let y = top;
  page.text('What this report claims', MARGIN, y, { size: 10, font: 'Helvetica-Bold' });
  y -= 13;
  y = page.paragraph(`OBSERVED — ${result.claims.observed}`, MARGIN, y, width, { size: 9 });
  y -= 3;
  y = page.paragraph(`INFERRED — ${result.claims.inferred}`, MARGIN, y, width, { size: 9 });
  y -= 3;
  y = page.paragraph(result.disclaimer, MARGIN, y, width, { size: 8, grey: 0.4 });
  return y;
}

function emptyExplanation(result: TraceResult): string {
  switch (result.emptyReason) {
    case 'query_not_searchable':
      return (
        'The plate grammar could not read the query as an Indian registration, so it was not ' +
        'searched against the estate. Refusing to fuzz a phone number or a hoarding against every ' +
        'plate in the corpus is deliberate — see docs/plate-grammar.md.'
      );
    case 'no_matching_plate':
      return (
        'No plate read in the window is within the weighted distance limit of this registration. ' +
        'Raising max_distance widens the search, at a measured cost to precision ' +
        '(docs/fuzzy-matching.md §6).'
      );
    case 'below_min_confidence':
      return 'Candidates were found but every one fell below the minimum confidence requested.';
    default:
      return 'No sightings in this window.';
  }
}

function tableHeader(page: PdfPage, top: number, right: number): number {
  let x = MARGIN;
  for (const column of COLUMNS) {
    const text = ellipsise(column.label, column.width - 6, HEADER_SIZE, 'Helvetica-Bold');
    const offset =
      column.align === 'right'
        ? column.width - 6 - textWidth(text, HEADER_SIZE, 'Helvetica-Bold' as PdfFont)
        : 0;
    page.text(text, x + offset, top, { size: HEADER_SIZE, font: 'Helvetica-Bold' });
    x += column.width;
  }
  page.line(MARGIN, top - 4, right, top - 4, { grey: 0.6 });
  return top - 16;
}

function footer(pages: PdfPage[], generatedAt: Date): void {
  for (const [i, page] of pages.entries()) {
    page.text(
      `SAAKSHI · generated ${generatedAt.toISOString()} · page ${String(i + 1)} of ${String(pages.length)}`,
      MARGIN,
      MARGIN - 14,
      { size: 7, grey: 0.5 },
    );
    page.text(
      'Fuzzy links are ranked possibilities, not identifications.',
      PAGE.width - MARGIN - 180,
      MARGIN - 14,
      { size: 7, grey: 0.5 },
    );
  }
}

function fixed(value: number | null, dp: number): string {
  return value === null ? '' : value.toFixed(dp);
}
