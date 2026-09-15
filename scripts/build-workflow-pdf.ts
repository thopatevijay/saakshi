/**
 * `npm run docs:workflow` — `submission/saakshi-workflow-integration.pdf`.
 *
 * The submission portal asks for a **Workflow / Integration Diagram** as its own document, separate
 * from the deck and the HLD. The six architecture diagrams already exist as committed mermaid
 * sources rendered to PNG (D4-05); this assembles the four that answer that specific question into
 * one file, so the portal gets a document rather than a link to a folder of images.
 *
 * Nothing here is drawn by hand: every diagram is generated from `docs/architecture/*.mmd` by
 * `npm run docs:render`, so this PDF cannot drift from the HLD's figures.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdownPdf, type MarkdownPdfImage } from '../packages/api/src/services/markdown-pdf.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCH = path.join(ROOT, 'docs', 'architecture');

/** The four that answer "workflow" and "integration". Trust-score and audit-chain stay in the HLD. */
const FIGURES: ReadonlyArray<{ file: string; title: string; blurb: string }> = [
  {
    file: '01-system-context.png',
    title: '1 · Integration — what SAAKSHI connects to, and what it leaves alone',
    blurb:
      'Department-owned sources stay where they are and are not modified. Every source type reaches the platform through one adapter interface, whatever its vendor or protocol. Government databases are shown dashed because the connectors are **specified with a mock provider, not connected** — there is no live VAHAN, SARTHI, eGujCop, AFIS or NAFIS link in this submission.',
  },
  {
    file: '02-edge-district-node.png',
    title: '2 · Integration — inside one district node',
    blurb:
      'Decode, detect, track, read plates and probe health, all at the edge. Only events cross the WAN — roughly 2 KB per second per camera. Video never leaves the district, which is what makes the backhaul arithmetic work and what makes 26 departments willing to participate.',
  },
  {
    file: '03-data-flow.png',
    title: '3 · Workflow — frame to sighting to alert to evidence',
    blurb:
      'The operational loop end to end. Timing is taken from the presentation timestamp, never frame arrival. A watchlist hit is correlated as the read lands — exact first, then a confusion-weighted fuzzy match. The operator\'s verdict is written to a hash-chained audit log, and the evidence crop is streamed through the API behind a session and a role check, never a public URL.',
  },
  {
    file: '04-deployment-topology.png',
    title: '4 · Integration — statewide deployment',
    blurb:
      'Approximately 33 district nodes feeding a state data centre over mTLS, with a replicated secondary site. The figure that decides this shape: 1.28 Gbps of metadata in place of 160.00 Gbps of video.',
  },
];

const missing = FIGURES.filter((f) => !existsSync(path.join(ARCH, f.file)));
if (missing.length > 0) {
  console.error(`missing diagrams: ${missing.map((m) => m.file).join(', ')} — run npm run docs:render`);
  process.exit(1);
}

const md: string[] = [
  '# SAAKSHI — Workflow and Integration',
  '',
  '**Gujarat Police Innovation Challenge 2026** · submitted under **Model 1 (compulsory) + Hybrid**',
  '',
  '> Every diagram below is generated from a committed mermaid source under `docs/architecture/`,',
  '> rendered by `npm run docs:render`. They are the same figures used in the High-Level Design, so',
  '> the two documents cannot disagree. Sources: https://github.com/thopatevijay/saakshi',
  '',
  '---',
  '',
];
for (const f of FIGURES) {
  md.push(`## ${f.title}`, '', f.blurb, '', `![](architecture/${f.file})`, '', '---', '');
}

const sharp = (await import('sharp')).default;
const images: MarkdownPdfImage[] = [];
for (const f of FIGURES) {
  const jpeg = await sharp(readFileSync(path.join(ARCH, f.file)))
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
    .toBuffer();
  images.push({ src: `architecture/${f.file}`, jpeg });
}

const pdf = renderMarkdownPdf(md.join('\n'), {
  title: 'SAAKSHI — Workflow and Integration',
  subtitle: 'Gujarat Police Innovation Challenge 2026 · Model 1 (compulsory) + Hybrid',
  author: 'SAAKSHI',
  subject: 'Workflow and integration diagrams',
  footer: 'SAAKSHI · Workflow and Integration · Gujarat Police Innovation Challenge 2026',
  images,
});

const out = path.join(ROOT, 'submission', 'saakshi-workflow-integration.pdf');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, pdf);
process.stdout.write(`wrote  ${path.relative(ROOT, out)}  ${String(pdf.length)} B\n`);
