/**
 * A small Markdown -> PDF renderer, built on `pdf.ts`.
 *
 * D4-05 needs `docs/HLD.md` to exist as a document a judge can read on GitHub **and** as the PDF
 * that goes into the submission, and those two must never disagree. The only way to guarantee that
 * is to render the PDF *from the markdown*, so this exists.
 *
 * It is deliberately a subset, not a CommonMark implementation: headings, paragraphs with inline
 * bold/italic/code, bullet and ordered lists, tables, fenced code, block quotes, rules, and images.
 * That is what the HLD uses. Anything outside the subset renders as its literal text rather than
 * being dropped, so a future edit that reaches for an unsupported construct is visible in the output
 * instead of silently vanishing.
 *
 * **Images are embedded as JPEG.** `pdf.ts` writes `/DCTDecode` streams, which is a JPEG-only path
 * — the same one D4-03's report uses for evidence crops. The diagrams are authored and committed as
 * PNG, so the caller converts; `renderMarkdownPdf` takes the JPEGs already converted rather than
 * reaching for an image library itself.
 */
import {
  PdfPage,
  renderPdf,
  textWidth,
  readJpegHeader,
  toPdfText,
  A4_PORTRAIT,
  type PdfFont,
  type PdfImage,
} from './pdf.js';

const PAGE = A4_PORTRAIT;
const MARGIN = 56;
const CONTENT_W = PAGE.width - MARGIN * 2;
const BOTTOM = 62;

export interface MarkdownPdfImage {
  /** The `src` exactly as it appears in the markdown, e.g. `architecture/01-system-context.png`. */
  src: string;
  jpeg: Buffer;
}

export interface MarkdownPdfOptions {
  title: string;
  subtitle?: string;
  author?: string;
  subject?: string;
  /** Printed on every page footer, left side. */
  footer: string;
  images?: readonly MarkdownPdfImage[];
}

/** An inline run after `**bold**`, `*italic*` and `` `code` `` have been resolved. */
interface Run {
  text: string;
  font: PdfFont;
}

/**
 * Split inline markup into runs.
 *
 * Link syntax is flattened to its label — a PDF of a document whose links are all internal anchors
 * gains nothing from blue underlines, and `docs:linkcheck` is what actually guarantees they resolve.
 */
export function inlineRuns(value: string, base: PdfFont = 'Helvetica'): Run[] {
  const flattened = value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const runs: Run[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  for (let m = re.exec(flattened); m !== null; m = re.exec(flattened)) {
    if (m.index > last) runs.push({ text: flattened.slice(last, m.index), font: base });
    const token = m[0];
    if (token.startsWith('**')) runs.push({ text: token.slice(2, -2), font: 'Helvetica-Bold' });
    else if (token.startsWith('`')) runs.push({ text: token.slice(1, -1), font: 'Courier' });
    else runs.push({ text: token.slice(1, -1), font: 'Helvetica-Oblique' });
    last = m.index + token.length;
  }
  if (last < flattened.length) runs.push({ text: flattened.slice(last), font: base });
  return runs.filter((r) => r.text !== '');
}

/** Greedy wrap of styled runs, preserving each word's font. */
function wrapRuns(runs: Run[], maxWidth: number, size: number): Run[][] {
  const lines: Run[][] = [];
  let line: Run[] = [];
  let width = 0;
  for (const run of runs) {
    // Keep the spaces: splitting on /(\s+)/ means a run boundary mid-sentence does not eat one.
    for (const word of run.text.split(/(\s+)/)) {
      if (word === '') continue;
      const w = textWidth(word, size, run.font);
      if (/^\s+$/.test(word)) {
        if (line.length > 0) {
          line.push({ text: word, font: run.font });
          width += w;
        }
        continue;
      }
      if (width + w > maxWidth && line.length > 0) {
        lines.push(line);
        line = [];
        width = 0;
      }
      line.push({ text: word, font: run.font });
      width += w;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

function drawRunLine(page: PdfPage, line: Run[], x: number, y: number, size: number): void {
  let cursor = x;
  for (const run of line) {
    if (run.text.trim() !== '') page.text(run.text, cursor, y, { size, font: run.font });
    cursor += textWidth(run.text, size, run.font);
  }
}

interface Block {
  kind: 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'ul' | 'ol' | 'table' | 'code' | 'quote' | 'hr' | 'img';
  lines: string[];
  src?: string;
  alt?: string;
}

/** Group the markdown into blocks. One pass, no AST — the subset does not need one. */
export function parseBlocks(markdown: string): Block[] {
  const src = markdown.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]): void => {
    if (buf.length > 0) blocks.push({ kind: 'p', lines: [buf.join(' ')] });
  };

  let paragraph: string[] = [];
  while (i < src.length) {
    const line = src[i] ?? '';

    if (line.trim() === '') {
      flushParagraph(paragraph);
      paragraph = [];
      i += 1;
      continue;
    }

    if (line.startsWith('```')) {
      flushParagraph(paragraph);
      paragraph = [];
      const body: string[] = [];
      i += 1;
      while (i < src.length && !(src[i] ?? '').startsWith('```')) {
        body.push(src[i] ?? '');
        i += 1;
      }
      i += 1;
      blocks.push({ kind: 'code', lines: body });
      continue;
    }

    const image = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line.trim());
    if (image !== null) {
      flushParagraph(paragraph);
      paragraph = [];
      blocks.push({ kind: 'img', lines: [], src: image[2] ?? '', alt: image[1] ?? '' });
      i += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph(paragraph);
      paragraph = [];
      const level = (heading[1] ?? '#').length;
      blocks.push({ kind: `h${String(level)}` as Block['kind'], lines: [heading[2] ?? ''] });
      i += 1;
      continue;
    }

    if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph(paragraph);
      paragraph = [];
      blocks.push({ kind: 'hr', lines: [] });
      i += 1;
      continue;
    }

    if (line.trimStart().startsWith('|') && line.includes('|', 1)) {
      flushParagraph(paragraph);
      paragraph = [];
      const rows: string[] = [];
      while (i < src.length && (src[i] ?? '').trimStart().startsWith('|')) {
        rows.push(src[i] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'table', lines: rows });
      continue;
    }

    if (line.startsWith('>')) {
      flushParagraph(paragraph);
      paragraph = [];
      const body: string[] = [];
      while (i < src.length && (src[i] ?? '').startsWith('>')) {
        body.push((src[i] ?? '').replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', lines: [body.join(' ')] });
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet !== null || ordered !== null) {
      flushParagraph(paragraph);
      paragraph = [];
      const kind: Block['kind'] = bullet !== null ? 'ul' : 'ol';
      const items: string[] = [];
      while (i < src.length) {
        const current = src[i] ?? '';
        const b = /^\s*[-*]\s+(.*)$/.exec(current);
        const o = /^\s*\d+[.)]\s+(.*)$/.exec(current);
        const match = kind === 'ul' ? b : o;
        if (match !== null) {
          items.push(match[1] ?? '');
          i += 1;
          continue;
        }
        // A wrapped continuation line belongs to the item above it.
        if (/^\s+\S/.test(current) && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1] ?? ''} ${current.trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ kind, lines: items });
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph(paragraph);
  return blocks;
}

function splitRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

const isDivider = (row: string): boolean => /^[\s|:-]+$/.test(row) && row.includes('-');

/** Render markdown to a complete PDF. */
export function renderMarkdownPdf(markdown: string, options: MarkdownPdfOptions): Buffer {
  // Fold typographic punctuation up front, so every width this function measures is the width of a
  // glyph that will actually be drawn. See `toPdfText`.
  const blocks = parseBlocks(toPdfText(markdown));
  const images: PdfImage[] = [];
  const bySrc = new Map<string, { name: string; jpeg: Buffer }>();
  (options.images ?? []).forEach((img, index) => {
    const name = `Im${String(index)}`;
    bySrc.set(img.src, { name, jpeg: img.jpeg });
    images.push({ name, jpeg: img.jpeg });
  });

  const pages: PdfPage[] = [];
  let page = new PdfPage(PAGE);
  let y = PAGE.height - MARGIN;

  const newPage = (): void => {
    pages.push(page);
    page = new PdfPage(PAGE);
    y = PAGE.height - MARGIN;
  };
  const need = (space: number): void => {
    if (y - space < BOTTOM) newPage();
  };

  // Cover.
  page.rect(0, PAGE.height - 6, PAGE.width, 6, { grey: 0.15 });
  y = PAGE.height - 230;
  page.text(options.title, MARGIN, y, { size: 30, font: 'Helvetica-Bold' });
  y -= 30;
  if (options.subtitle !== undefined) {
    y = page.paragraph(options.subtitle, MARGIN, y, CONTENT_W, { size: 13, grey: 0.35 });
  }
  newPage();

  for (const block of blocks) {
    switch (block.kind) {
      case 'h1': {
        need(46);
        y -= 10;
        y = page.paragraph(block.lines[0] ?? '', MARGIN, y, CONTENT_W, {
          size: 20,
          font: 'Helvetica-Bold',
          leading: 24,
        });
        y -= 8;
        break;
      }
      case 'h2': {
        // A **numbered** section always starts a page: the HLD is scored section by section, and a
        // scorer ticking down the requirement checklist should find each one at the top of a page.
        // Unnumbered headings only break when there is too little room to be worth starting under,
        // because forcing a page for every one of them leaves a document of half-empty pages.
        const numbered = /^\d+\.\s/.test(block.lines[0] ?? '');
        if (numbered && y < PAGE.height - MARGIN - 4) newPage();
        else need(150);
        page.rect(MARGIN, y - 4, CONTENT_W, 2, { grey: 0.15 });
        y -= 24;
        y = page.paragraph(block.lines[0] ?? '', MARGIN, y, CONTENT_W, {
          size: 16,
          font: 'Helvetica-Bold',
          leading: 20,
        });
        y -= 10;
        break;
      }
      case 'h3': {
        need(34);
        y -= 8;
        y = page.paragraph(block.lines[0] ?? '', MARGIN, y, CONTENT_W, {
          size: 12,
          font: 'Helvetica-Bold',
          leading: 16,
        });
        y -= 4;
        break;
      }
      case 'h4': {
        need(28);
        y -= 6;
        y = page.paragraph(block.lines[0] ?? '', MARGIN, y, CONTENT_W, {
          size: 10,
          font: 'Helvetica-Bold',
          leading: 14,
        });
        y -= 3;
        break;
      }
      case 'p': {
        const lines = wrapRuns(inlineRuns(block.lines[0] ?? ''), CONTENT_W, 9.5);
        for (const line of lines) {
          need(14);
          drawRunLine(page, line, MARGIN, y, 9.5);
          y -= 13;
        }
        y -= 6;
        break;
      }
      case 'ul':
      case 'ol': {
        block.lines.forEach((item, index) => {
          const marker = block.kind === 'ul' ? '•' : `${String(index + 1)}.`;
          const indent = 16;
          const lines = wrapRuns(inlineRuns(item), CONTENT_W - indent, 9.5);
          lines.forEach((line, li) => {
            need(14);
            if (li === 0) page.text(marker, MARGIN, y, { size: 9.5, grey: 0.35 });
            drawRunLine(page, line, MARGIN + indent, y, 9.5);
            y -= 13;
          });
          y -= 2;
        });
        y -= 5;
        break;
      }
      case 'quote': {
        const lines = wrapRuns(inlineRuns(block.lines[0] ?? ''), CONTENT_W - 18, 9.5);
        need(lines.length * 13 + 8);
        const top = y + 9;
        for (const line of lines) {
          need(14);
          drawRunLine(page, line, MARGIN + 14, y, 9.5);
          y -= 13;
        }
        page.rect(MARGIN, y + 4, 3, top - y - 4, { grey: 0.6 });
        y -= 7;
        break;
      }
      case 'code': {
        const lineHeight = 11;
        need(block.lines.length * lineHeight + 12);
        const top = y + 8;
        const height = block.lines.length * lineHeight + 10;
        page.rect(MARGIN, top - height, CONTENT_W, height, { grey: 0.955 });
        y -= 4;
        for (const line of block.lines) {
          need(lineHeight);
          page.text(line, MARGIN + 8, y, { size: 8, font: 'Courier', grey: 0.15 });
          y -= lineHeight;
        }
        y -= 10;
        break;
      }
      case 'hr': {
        need(16);
        page.line(MARGIN, y + 4, PAGE.width - MARGIN, y + 4, { grey: 0.85 });
        y -= 14;
        break;
      }
      case 'table': {
        const rows = block.lines.map(splitRow);
        const header = rows[0] ?? [];
        const body = rows.slice(1).filter((r, idx) => !(idx === 0 && isDivider(block.lines[1] ?? '')));
        const columns = header.length;
        if (columns === 0) break;

        // Column widths in proportion to the longest cell, so a table of short codes beside a long
        // sentence does not give both the same room.
        const weights = header.map((_, c) => {
          let widest = textWidth(header[c] ?? '', 8.5, 'Helvetica-Bold');
          for (const row of body) {
            widest = Math.max(widest, textWidth((row[c] ?? '').replace(/\*\*|`/g, ''), 8.5));
          }
          return Math.max(widest, 24);
        });
        const total = weights.reduce((a, b) => a + b, 0);
        const widths = weights.map((w) => Math.max((w / total) * CONTENT_W, 34));
        const scale = CONTENT_W / widths.reduce((a, b) => a + b, 0);
        const finalWidths = widths.map((w) => w * scale);

        // Lay every row out before drawing any of it, so the table's height is known. Without the
        // pre-pass a table that overruns the page by one row strands that row alone at the top of
        // the next one — which in a document a scorer reads row by row is worse than a page break.
        const laid = [header, ...body].map((cells, index) => {
          const bold = index === 0;
          const wrapped = cells.map((cell, c) =>
            wrapRuns(
              inlineRuns(cell, bold ? 'Helvetica-Bold' : 'Helvetica'),
              (finalWidths[c] ?? 0) - 10,
              8.5,
            ),
          );
          return { bold, wrapped, height: Math.max(...wrapped.map((wr) => wr.length), 1) * 11 + 6 };
        });

        const tableHeight = laid.reduce((a, r) => a + r.height, 0);
        const roomHere = y - BOTTOM;
        const roomOnAFreshPage = PAGE.height - MARGIN - BOTTOM;
        if (tableHeight > roomHere && tableHeight <= roomOnAFreshPage) newPage();

        for (const row of laid) {
          need(row.height + 4);
          // The header repeats after a break: a continued table whose columns are unlabelled is a
          // grid of numbers.
          if (!row.bold && y > PAGE.height - MARGIN - 2) {
            const head = laid[0];
            if (head !== undefined) {
              page.rect(MARGIN, y - head.height + 9, CONTENT_W, head.height, { grey: 0.93 });
              let hx = MARGIN;
              head.wrapped.forEach((cellLines, c) => {
                let cy = y;
                for (const line of cellLines) {
                  drawRunLine(page, line, hx + 5, cy, 8.5);
                  cy -= 11;
                }
                hx += finalWidths[c] ?? 0;
              });
              y -= head.height;
              page.line(MARGIN, y + 7, PAGE.width - MARGIN, y + 7, { grey: 0.88 });
            }
          }
          if (row.bold) page.rect(MARGIN, y - row.height + 9, CONTENT_W, row.height, { grey: 0.93 });
          let x = MARGIN;
          row.wrapped.forEach((cellLines, c) => {
            let cy = y;
            for (const line of cellLines) {
              drawRunLine(page, line, x + 5, cy, 8.5);
              cy -= 11;
            }
            x += finalWidths[c] ?? 0;
          });
          y -= row.height;
          page.line(MARGIN, y + 7, PAGE.width - MARGIN, y + 7, { grey: 0.88 });
        }
        y -= 8;
        break;
      }
      case 'img': {
        const entry = bySrc.get(block.src ?? '');
        if (entry === undefined) {
          // Not silently skipped: a missing diagram is a defect, and the PDF says so.
          need(16);
          page.text(`[diagram not embedded: ${block.src ?? ''}]`, MARGIN, y, {
            size: 8,
            font: 'Helvetica-Oblique',
            grey: 0.5,
          });
          y -= 16;
          break;
        }
        const header = readJpegHeader(entry.jpeg);
        if (header === null) break;
        const maxH = PAGE.height - MARGIN - BOTTOM - 30;
        let w = CONTENT_W;
        let h = (header.height / header.width) * w;
        if (h > maxH) {
          h = maxH;
          w = (header.width / header.height) * h;
        }
        if (y - h < BOTTOM) newPage();
        page.image(entry.name, MARGIN + (CONTENT_W - w) / 2, y - h, w, h);
        y -= h + 6;
        if (block.alt !== undefined && block.alt !== '') {
          need(14);
          page.text(block.alt, MARGIN, y, { size: 8, font: 'Helvetica-Oblique', grey: 0.45 });
          y -= 14;
        }
        y -= 8;
        break;
      }
    }
  }
  pages.push(page);

  // Footers last, so the page count is known.
  pages.forEach((p, index) => {
    if (index === 0) return;
    p.line(MARGIN, 48, PAGE.width - MARGIN, 48, { grey: 0.88 });
    p.text(options.footer, MARGIN, 36, { size: 7.5, grey: 0.5 });
    const label = `${String(index)} / ${String(pages.length - 1)}`;
    p.text(label, PAGE.width - MARGIN - textWidth(label, 7.5), 36, { size: 7.5, grey: 0.5 });
  });

  return renderPdf(
    pages,
    {
      title: options.title,
      ...(options.author === undefined ? {} : { author: options.author }),
      ...(options.subject === undefined ? {} : { subject: options.subject }),
    },
    images,
  );
}
