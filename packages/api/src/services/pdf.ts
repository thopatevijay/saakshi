/**
 * A minimal PDF 1.4 writer — enough for a one-page-per-N-rows evidence report, and no more.
 *
 * **Why not a library.** The challenge's About page says solutions *should* use open-source
 * technologies, and the repo's rule is that nothing proprietary is load-bearing; a PDF dependency
 * would satisfy both. The reason to hand-roll is narrower: every PDF library in the ecosystem
 * carries font subsetting, an image pipeline and a layout engine, and D2-08 needs a title, some
 * key/value lines, a ruled table and a footer. That is roughly 200 lines of the PDF spec's simplest
 * corner, it has no attack surface, and it means a judge's export cannot fail because a transitive
 * dependency changed. `package.json` is a hot file — six of six D1 tickets touched it — and not
 * touching it at all is worth something on its own.
 *
 * **What it supports.** The 14 standard Type 1 fonts (no embedding needed — every reader has
 * Helvetica), WinAnsi text, straight lines, filled rectangles, and multiple pages. Everything is
 * measured in PostScript points with the origin bottom-left, which is what the format uses.
 *
 * **What it does not.** No images, no unicode beyond Latin-1, no compression. A trace report is a
 * few kilobytes of text; deflating it would add a dependency to save nothing.
 */

export const A4_PORTRAIT = { width: 595.28, height: 841.89 } as const;
export const A4_LANDSCAPE = { width: 841.89, height: 595.28 } as const;

export type PdfFont = 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Courier';

const FONT_KEYS: Record<PdfFont, string> = {
  Helvetica: 'F1',
  'Helvetica-Bold': 'F2',
  'Helvetica-Oblique': 'F3',
  Courier: 'F4',
};

export interface PdfPageSize {
  width: number;
  height: number;
}

/**
 * One page's content stream, built up by the caller in points from the bottom-left origin.
 *
 * Deliberately imperative: a trace report is laid out top-down by a loop that knows how much room
 * is left, and a declarative box model would be a great deal more machinery for the same output.
 */
export class PdfPage {
  readonly size: PdfPageSize;
  private readonly ops: string[] = [];

  constructor(size: PdfPageSize = A4_PORTRAIT) {
    this.size = size;
  }

  text(value: string, x: number, y: number, options: { size?: number; font?: PdfFont; grey?: number } = {}): this {
    const size = options.size ?? 10;
    const font = FONT_KEYS[options.font ?? 'Helvetica'];
    const grey = options.grey ?? 0;
    this.ops.push(
      `q ${fmt(grey)} g BT /${font} ${fmt(size)} Tf 1 0 0 1 ${fmt(x)} ${fmt(y)} Tm (${escapeText(value)}) Tj ET Q`,
    );
    return this;
  }

  line(x1: number, y1: number, x2: number, y2: number, options: { width?: number; grey?: number } = {}): this {
    this.ops.push(
      `q ${fmt(options.grey ?? 0.75)} G ${fmt(options.width ?? 0.5)} w ${fmt(x1)} ${fmt(y1)} m ${fmt(x2)} ${fmt(y2)} l S Q`,
    );
    return this;
  }

  rect(x: number, y: number, w: number, h: number, options: { grey?: number } = {}): this {
    this.ops.push(`q ${fmt(options.grey ?? 0.93)} g ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re f Q`);
    return this;
  }

  /** Greedy wrap at `maxWidth` points, returning the y the caller should continue from. */
  paragraph(
    value: string,
    x: number,
    y: number,
    maxWidth: number,
    options: { size?: number; font?: PdfFont; leading?: number; grey?: number } = {},
  ): number {
    const size = options.size ?? 9;
    const leading = options.leading ?? size + 3;
    let cursor = y;
    for (const line of wrap(value, maxWidth, size, options.font ?? 'Helvetica')) {
      this.text(line, x, cursor, {
        size,
        ...(options.font === undefined ? {} : { font: options.font }),
        ...(options.grey === undefined ? {} : { grey: options.grey }),
      });
      cursor -= leading;
    }
    return cursor;
  }

  content(): string {
    return this.ops.join('\n');
  }
}

export interface PdfMeta {
  title: string;
  author?: string;
  subject?: string;
}

/** Serialise pages to a complete PDF 1.4 document. */
export function renderPdf(pages: PdfPage[], meta: PdfMeta): Buffer {
  if (pages.length === 0) throw new Error('a PDF needs at least one page');

  // Object numbering: 1 catalog, 2 pages, 3..6 fonts, then (page, contents) pairs.
  const fontIds: Record<string, number> = { F1: 3, F2: 4, F3: 5, F4: 6 };
  const firstPageObj = 7;
  const objects: string[] = [];

  const pageObjIds = pages.map((_, i) => firstPageObj + i * 2);

  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(
    `2 0 obj\n<< /Type /Pages /Count ${String(pages.length)} /Kids [${pageObjIds
      .map((id) => `${String(id)} 0 R`)
      .join(' ')}] >>\nendobj\n`,
  );
  for (const [name, id] of Object.entries(fontIds)) {
    const base = Object.entries(FONT_KEYS).find(([, key]) => key === name)?.[0] ?? 'Helvetica';
    objects.push(
      `${String(id)} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>\nendobj\n`,
    );
  }

  for (const [i, page] of pages.entries()) {
    const pageId = firstPageObj + i * 2;
    const contentId = pageId + 1;
    const stream = page.content();
    objects.push(
      `${String(pageId)} 0 obj\n<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 ${fmt(page.size.width)} ${fmt(page.size.height)}] ` +
        `/Resources << /Font << ${Object.entries(fontIds)
          .map(([n, id]) => `/${n} ${String(id)} 0 R`)
          .join(' ')} >> >> ` +
        `/Contents ${String(contentId)} 0 R >>\nendobj\n`,
    );
    objects.push(
      `${String(contentId)} 0 obj\n<< /Length ${String(Buffer.byteLength(stream, 'latin1'))} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  }

  const infoId = firstPageObj + pages.length * 2;
  objects.push(
    `${String(infoId)} 0 obj\n<< /Title (${escapeText(meta.title)}) ` +
      `/Author (${escapeText(meta.author ?? 'SAAKSHI')}) ` +
      `/Subject (${escapeText(meta.subject ?? meta.title)}) ` +
      `/Producer (SAAKSHI) /CreationDate (${pdfDate(new Date())}) >>\nendobj\n`,
  );

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += object;
  }

  const xrefStart = Buffer.byteLength(body, 'latin1');
  let xref = `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  const trailer =
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R /Info ${String(infoId)} 0 R >>\n` +
    `startxref\n${String(xrefStart)}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer, 'latin1');
}

/**
 * Helvetica advance widths, in 1/1000 em, for the printable ASCII range.
 *
 * Hard-coded rather than parsed from an AFM file so wrapping works with no assets on disk. Courier
 * is monospaced at 600 and needs no table. The values are the standard Adobe metrics; a wrap that
 * is a point or two conservative is invisible, and the alternative — assuming every glyph is the
 * same width — visibly overflows the page on a column of capital letters.
 */
const HELVETICA_WIDTHS: Readonly<Record<string, number>> = buildWidths();

function buildWidths(): Record<string, number> {
  const widths: Record<string, number> = {};
  const groups: [string, number][] = [
    [' !"#$%&\'()*+,-./0123456789:;<=>?@', 0],
    ['', 0],
  ];
  void groups;
  const table =
    '278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 ' + // space .. /
    '556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 ' + // 0..?
    '1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 ' + // @..O
    '667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 ' + // P.._
    '333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 ' + // `..o
    '556 556 333 500 278 556 500 722 500 500 500 334 260 334 584'; // p..~
  const values = table.split(/\s+/).map(Number);
  for (let code = 32; code <= 126; code += 1) {
    widths[String.fromCharCode(code)] = values[code - 32] ?? 556;
  }
  return widths;
}

export function textWidth(value: string, size: number, font: PdfFont = 'Helvetica'): number {
  if (font === 'Courier') return (value.length * 600 * size) / 1000;
  const bold = font === 'Helvetica-Bold';
  let total = 0;
  for (const char of value) {
    const base = HELVETICA_WIDTHS[char] ?? 556;
    // Helvetica-Bold is wider than Helvetica by roughly 6% across the ASCII range. Approximating it
    // keeps one table instead of two, and errs towards wrapping early rather than overflowing.
    total += bold ? base * 1.06 : base;
  }
  return (total * size) / 1000;
}

function wrap(value: string, maxWidth: number, size: number, font: PdfFont): string[] {
  const words = value.split(/\s+/).filter((w) => w !== '');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current === '' ? word : `${current} ${word}`;
    if (textWidth(next, size, font) <= maxWidth) {
      current = next;
      continue;
    }
    if (current !== '') lines.push(current);
    current = word;
  }
  if (current !== '') lines.push(current);
  return lines.length === 0 ? [''] : lines;
}

/** Truncate to fit, with an ellipsis, so a long camera name cannot run into the next column. */
export function ellipsise(value: string, maxWidth: number, size: number, font: PdfFont = 'Helvetica'): string {
  if (textWidth(value, size, font) <= maxWidth) return value;
  let out = value;
  while (out.length > 1 && textWidth(`${out}...`, size, font) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

function escapeText(value: string): string {
  // Latin-1 only: anything outside it has no glyph under WinAnsiEncoding and would render as
  // mojibake rather than failing loudly, which is worse.
  return [...value]
    .map((char) => (char.codePointAt(0) ?? 63) > 255 ? '?' : char)
    .join('')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[\r\n]+/g, ' ');
}

function fmt(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

function pdfDate(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `D:${String(date.getUTCFullYear())}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}
