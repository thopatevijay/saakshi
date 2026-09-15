/**
 * `npm run docs:render` — the D4-05 documentation build: mermaid -> PNG, markdown -> PDF.
 *
 * Three steps, in this order because each depends on the last:
 *
 *   1. every `docs/architecture/*.mmd` renders to a sibling PNG;
 *   2. `docs/HLD.md` is generated from `packages/api/src/jobs/hld.ts`, which reads its sizing and
 *      accuracy figures from the same constants the solution deck reads;
 *   3. the markdown renders to `submission/saakshi-hld.pdf`, with those PNGs embedded.
 *
 * **Diagrams are converted to JPEG for the PDF.** `pdf.ts` writes `/DCTDecode` streams — the
 * JPEG-only path D4-03's evidence report already proved — so `sharp` transcodes. The committed
 * artefact stays PNG, because that is what renders on GitHub and what stays lossless when edited.
 *
 * `--skip-diagrams` renders the document from the already-committed PNGs, for a machine with no
 * browser. It is not the default: a silent skip would let a stale diagram survive a regeneration.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMermaidDir } from './mermaid-render.ts';
import { writeHldMarkdown, readHldMarkdown, DIAGRAMS } from '../packages/api/src/jobs/hld.ts';
import {
  renderMarkdownPdf,
  type MarkdownPdfImage,
} from '../packages/api/src/services/markdown-pdf.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCH_DIR = path.join(REPO_ROOT, 'docs', 'architecture');
const PDF_PATH = path.join(REPO_ROOT, 'submission', 'saakshi-hld.pdf');

const skipDiagrams = process.argv.includes('--skip-diagrams');

const rel = (p: string): string => path.relative(REPO_ROOT, p);

if (skipDiagrams) {
  process.stdout.write('diagrams       skipped (--skip-diagrams); using the committed PNGs\n');
} else {
  const rendered = await renderMermaidDir(ARCH_DIR);
  for (const d of rendered) {
    process.stdout.write(
      `diagram        ${d.source} -> ${d.png}  ${String(d.width)}x${String(d.height)}  ${String(d.bytes)} B\n`,
    );
  }
  if (rendered.length === 0) throw new Error(`no .mmd sources found in ${rel(ARCH_DIR)}`);
}

const mdPath = writeHldMarkdown(REPO_ROOT);
const markdown = readHldMarkdown(REPO_ROOT);
process.stdout.write(`markdown       ${rel(mdPath)}  ${String(markdown.length)} chars\n`);

// PNG -> JPEG for embedding. A missing diagram is fatal: the PDF would otherwise ship with a
// "[diagram not embedded]" line, which is exactly the silent degradation this build exists to stop.
const sharp = (await import('sharp')).default;
const images: MarkdownPdfImage[] = [];
for (const d of DIAGRAMS) {
  const png = path.join(ARCH_DIR, d.file);
  if (!existsSync(png)) throw new Error(`diagram missing: ${rel(png)} — run without --skip-diagrams`);
  const jpeg = await sharp(readFileSync(png))
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
    .toBuffer();
  images.push({ src: `architecture/${d.file}`, jpeg });
}
process.stdout.write(`diagrams       ${String(images.length)} embedded as JPEG\n`);

const pdf = renderMarkdownPdf(markdown, {
  title: 'SAAKSHI — High-Level Design',
  subtitle:
    'Technical proposal · Gujarat Police Innovation Challenge 2026 · Model 1 (compulsory) + Hybrid',
  author: 'SAAKSHI',
  subject: 'High-Level Design / technical proposal',
  footer: 'SAAKSHI · High-Level Design · Gujarat Police Innovation Challenge 2026',
  images,
});

mkdirSync(path.dirname(PDF_PATH), { recursive: true });
writeFileSync(PDF_PATH, pdf);
process.stdout.write(
  `pdf            ${rel(PDF_PATH)}  ${String(pdf.length)} B  (${(pdf.length / 1024).toFixed(1)} KB)\n`,
);
