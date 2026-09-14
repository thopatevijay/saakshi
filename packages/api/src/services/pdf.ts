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
 * **What it does not.** No unicode beyond Latin-1, no compression. A trace report is a few kilobytes
 * of text; deflating it would add a dependency to save nothing.
 *
 * **Images, added in D4-03.** JPEG only, and embedded **as-is**: a JPEG is already DCT-compressed,
 * and PDF's `/DCTDecode` filter takes exactly that byte stream, so the crop stored in MinIO is
 * copied into the document without a decode or a re-encode. That is the one image case worth
 * supporting by hand — anything else (PNG, alpha, colour management) is where an image pipeline
 * starts, and where this file would stop being worth hand-rolling.
 *
 * D4-03's output report is a mandatory submission item and its acceptance criterion is explicit that
 * the PDF carries the plate crops; a report that described crops it could not show would be the
 * weaker artefact.
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

  text(
    value: string,
    x: number,
    y: number,
    options: { size?: number; font?: PdfFont; grey?: number } = {},
  ): this {
    const size = options.size ?? 10;
    const font = FONT_KEYS[options.font ?? 'Helvetica'];
    const grey = options.grey ?? 0;
    this.ops.push(
      `q ${fmt(grey)} g BT /${font} ${fmt(size)} Tf 1 0 0 1 ${fmt(x)} ${fmt(y)} Tm (${escapeText(value)}) Tj ET Q`,
    );
    return this;
  }

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    options: { width?: number; grey?: number } = {},
  ): this {
    this.ops.push(
      `q ${fmt(options.grey ?? 0.75)} G ${fmt(options.width ?? 0.5)} w ${fmt(x1)} ${fmt(y1)} m ${fmt(x2)} ${fmt(y2)} l S Q`,
    );
    return this;
  }

  rect(x: number, y: number, w: number, h: number, options: { grey?: number } = {}): this {
    this.ops.push(
      `q ${fmt(options.grey ?? 0.93)} g ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re f Q`,
    );
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

  /**
   * Draw a registered JPEG, scaled into a `w` x `h` box at (x, y).
   *
   * `name` must match a `PdfImage.name` handed to `renderPdf`. PDF draws an image by concatenating a
   * matrix that maps the unit square to the target rectangle, so the `cm` operator carries the size
   * and there is no scaling parameter anywhere else.
   */
  image(name: string, x: number, y: number, w: number, h: number): this {
    this.ops.push(`q ${fmt(w)} 0 0 ${fmt(h)} ${fmt(x)} ${fmt(y)} cm /${name} Do Q`);
    this.used.add(name);
    return this;
  }

  /** Image names this page actually draws, so a page only declares the XObjects it uses. */
  readonly used = new Set<string>();

  content(): string {
    return this.ops.join('\n');
  }
}

/** A JPEG to embed. The bytes are written verbatim as a `/DCTDecode` stream. */
export interface PdfImage {
  name: string;
  jpeg: Buffer;
}

/**
 * Width, height and component count from a JPEG's SOF marker.
 *
 * PDF needs all three up front — the dimensions for `/Width` and `/Height`, the component count to
 * choose `/DeviceGray`, `/DeviceRGB` or `/DeviceCMYK` — and they are only discoverable by walking
 * the marker segments. Returns `null` for anything that is not a JPEG we can describe, so a corrupt
 * or unexpected crop is **omitted with a reason** rather than producing a PDF no reader will open.
 */
export function readJpegHeader(
  jpeg: Buffer,
): { width: number; height: number; components: number } | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = jpeg[i + 1] ?? 0;
    // SOF0/1/2/3, 5-7, 9-11, 13-15 all carry the frame header. DHT (c4), JPG (c8) and DAC (cc) sit
    // in the same numeric range and do not, which is why they are excluded rather than the range
    // being taken wholesale.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return {
        height: jpeg.readUInt16BE(i + 5),
        width: jpeg.readUInt16BE(i + 7),
        components: jpeg[i + 9] ?? 3,
      };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const length = jpeg.readUInt16BE(i + 2);
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

export interface PdfMeta {
  title: string;
  author?: string;
  subject?: string;
}

/** Serialise pages to a complete PDF 1.4 document. */
export function renderPdf(pages: PdfPage[], meta: PdfMeta, images: readonly PdfImage[] = []): Buffer {
  if (pages.length === 0) throw new Error('a PDF needs at least one page');

  // Object numbering: 1 catalog, 2 pages, 3..6 fonts, then one object per image, then (page,
  // contents) pairs. Images sit before the pages because a page's /Resources has to reference them
  // by object id, and numbering them first means that id is known without a second pass.
  const fontIds: Record<string, number> = { F1: 3, F2: 4, F3: 5, F4: 6 };
  const usable = images
    .map((img) => ({ ...img, header: readJpegHeader(img.jpeg) }))
    .filter((img): img is PdfImage & { header: NonNullable<ReturnType<typeof readJpegHeader>> } =>
      img.header !== null,
    );
  const imageIds = new Map<string, number>(usable.map((img, i) => [img.name, 7 + i]));
  const firstPageObj = 7 + usable.length;
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

  for (const img of usable) {
    const colourSpace =
      img.header.components === 1
        ? '/DeviceGray'
        : img.header.components === 4
          ? '/DeviceCMYK'
          : '/DeviceRGB';
    // `latin1` round-trips every byte 0-255 to exactly one character, which is why the whole
    // document can stay a string and still carry binary. Any other encoding mangles the stream.
    objects.push(
      `${String(imageIds.get(img.name) ?? 0)} 0 obj\n` +
        `<< /Type /XObject /Subtype /Image /Width ${String(img.header.width)} ` +
        `/Height ${String(img.header.height)} /ColorSpace ${colourSpace} ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${String(img.jpeg.length)} >>\n` +
        `stream\n${img.jpeg.toString('latin1')}\nendstream\nendobj\n`,
    );
  }

  for (const [i, page] of pages.entries()) {
    const pageId = firstPageObj + i * 2;
    const contentId = pageId + 1;
    const stream = page.content();
    const drawn = [...page.used].filter((name) => imageIds.has(name));
    const xobjects =
      drawn.length === 0
        ? ''
        : ` /XObject << ${drawn
            .map((name) => `/${name} ${String(imageIds.get(name) ?? 0)} 0 R`)
            .join(' ')} >>`;
    objects.push(
      `${String(pageId)} 0 obj\n<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 ${fmt(page.size.width)} ${fmt(page.size.height)}] ` +
        `/Resources << /Font << ${Object.entries(fontIds)
          .map(([n, id]) => `/${n} ${String(id)} 0 R`)
          .join(' ')} >>${xobjects} >> ` +
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
const HELVETICA_WIDTHS: Readonly<Record<string, number>> = buildWidths(
  '278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 ' + // space .. /
    '556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 ' + // 0..?
    '1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 ' + // @..O
    '667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 ' + // P.._
    '333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 ' + // `..o
    '556 556 333 500 278 556 500 722 500 500 500 334 260 334 584', // p..~
);

/**
 * Helvetica-Bold advance widths — the real Adobe metrics, not a scale factor.
 *
 * This used to be `HELVETICA_WIDTHS[char] * 1.06`, and the approximation was fine for wrapping a
 * whole paragraph in one font. It broke the moment D4-04 laid out **mixed-weight** lines: the deck
 * positions each same-font segment itself, so a bold segment measured 6% off puts the *next*
 * segment in the wrong place, and the slide rendered `disagree. /problems` with the full stop drawn
 * underneath the previous word.
 *
 * The error is invisible inside a single run and obvious across a boundary, which is exactly the
 * kind of bug that survives review. A second table is 6 lines; guessing is not worth it.
 */
const HELVETICA_BOLD_WIDTHS: Readonly<Record<string, number>> = buildWidths(
  '278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 ' + // space .. /
    '556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 ' + // 0..?
    '975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 ' + // @..O
    '667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 ' + // P.._
    '333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 ' + // `..o
    '611 611 389 556 333 611 556 778 556 556 500 389 280 389 584', // p..~
);

function buildWidths(table: string): Record<string, number> {
  const widths: Record<string, number> = {};
  const values = table.split(/\s+/).map(Number);
  for (let code = 32; code <= 126; code += 1) {
    widths[String.fromCharCode(code)] = values[code - 32] ?? 556;
  }
  return widths;
}

export function textWidth(value: string, size: number, font: PdfFont = 'Helvetica'): number {
  if (font === 'Courier') return (value.length * 600 * size) / 1000;
  const table = font === 'Helvetica-Bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let total = 0;
  for (const char of value) total += table[char] ?? 556;
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
export function ellipsise(
  value: string,
  maxWidth: number,
  size: number,
  font: PdfFont = 'Helvetica',
): string {
  if (textWidth(value, size, font) <= maxWidth) return value;
  let out = value;
  while (out.length > 1 && textWidth(`${out}...`, size, font) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

/**
 * Typographic characters that have no Latin-1 code point, mapped to something a reader recognises.
 *
 * Without this the em dashes in the claims box print as `?`, which in a document whose whole job is
 * to be careful about what it asserts reads as a defect. Anything not listed still degrades to `?`
 * rather than to mojibake — a visible gap beats a wrong glyph. Note the middle dot, the degree sign
 * and the accented letters *are* in Latin-1 and pass through untouched.
 */
const TRANSLITERATE: Readonly<Record<string, string>> = {
  '—': '-', // em dash
  '–': '-', // en dash
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '…': '...',
  '→': '->',
  '≥': '>=',
  '≤': '<=',
  '≠': '!=',
  '×': 'x',
  '•': '·', // bullet -> middle dot, which Latin-1 has
};

function escapeText(value: string): string {
  // Latin-1 only: anything outside it has no glyph under WinAnsiEncoding and would render as
  // mojibake rather than failing loudly, which is worse.
  return [...value]
    .map((char) => TRANSLITERATE[char] ?? ((char.codePointAt(0) ?? 63) > 255 ? '?' : char))
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
