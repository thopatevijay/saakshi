/**
 * `npm run docs:linkcheck` — every internal link in the documentation resolves.
 *
 * D4-05's AC 8 is *"exported to PDF; internal links resolve"*, and the gate asks for **zero broken
 * internal links**. A judge who clicks a reference in the HLD and lands on a 404 has learned
 * something about the whole submission, so this is checked mechanically rather than by eye.
 *
 * **Internal only, deliberately.** Relative paths and same-document anchors are things this repo
 * controls and can therefore guarantee; an external URL's availability is somebody else's uptime and
 * failing a build on it would make the gate flaky. `scripts/check-links.ts` is the separate,
 * deployment-time sweep for the running console's own URLs (D4-02).
 *
 * Anchors are resolved the way GitHub generates them: lowercase, punctuation dropped, **each**
 * space to a hyphen, with a `-1` suffix for each repeat.
 *
 * The "each" matters and is easy to get wrong. GitHub does not collapse whitespace runs, so this
 * repo's `## 3 · One crop per track session` style of heading — where stripping the `·` leaves two
 * adjacent spaces — anchors as `#3--one-crop-per-track-session`, with two hyphens. A checker that
 * collapsed the run would pass a link GitHub serves as a 404, which is worse than no checker.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Documents that are checked. Generated reports are included — a stale link in one still misleads. */
const ROOTS = ['docs', 'submission', '.'];

function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`|\*|_/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s/g, '-');
}

function anchorsOf(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const line of markdown.split('\n')) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m === null) continue;
    const base = slug(m[2] ?? '');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${String(n)}`);
  }
  return out;
}

function markdownFiles(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    const dir = path.join(REPO_ROOT, root);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (!statSync(full).isFile() || !entry.endsWith('.md')) continue;
      out.push(full);
    }
  }
  return out.sort();
}

interface Broken {
  file: string;
  link: string;
  reason: string;
}

const broken: Broken[] = [];
let checked = 0;
const files = markdownFiles();

for (const file of files) {
  const markdown = readFileSync(file, 'utf8');
  const anchors = anchorsOf(markdown);
  // Strip fenced code so an example URL in a shell block is not treated as a link.
  const prose = markdown.replace(/```[\s\S]*?```/g, '');
  const re = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

  for (let m = re.exec(prose); m !== null; m = re.exec(prose)) {
    const target = m[1] ?? '';
    if (/^(https?:|mailto:|tel:|data:)/.test(target)) continue;
    checked += 1;

    const [pathPart = '', anchor] = target.split('#');

    if (pathPart === '') {
      if (anchor !== undefined && anchor !== '' && !anchors.has(anchor)) {
        broken.push({ file, link: target, reason: `no heading in this file matches #${anchor}` });
      }
      continue;
    }

    const resolved = path.resolve(path.dirname(file), pathPart);
    if (!existsSync(resolved)) {
      broken.push({ file, link: target, reason: 'file does not exist' });
      continue;
    }
    if (anchor !== undefined && anchor !== '' && resolved.endsWith('.md')) {
      if (!anchorsOf(readFileSync(resolved, 'utf8')).has(anchor)) {
        broken.push({ file, link: target, reason: `no heading in ${path.basename(resolved)} matches #${anchor}` });
      }
    }
  }
}

const rel = (p: string): string => path.relative(REPO_ROOT, p);
process.stdout.write(`scanned        ${String(files.length)} markdown files\n`);
process.stdout.write(`internal links ${String(checked)} checked\n`);

if (broken.length > 0) {
  process.stdout.write(`broken         ${String(broken.length)}\n\n`);
  for (const b of broken) process.stdout.write(`  ${rel(b.file)}  ->  ${b.link}   (${b.reason})\n`);
  process.exit(1);
}
process.stdout.write('broken         0\n');
