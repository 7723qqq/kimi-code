import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
// TS7 ships no JS compiler API; pin TS6 for AST access.
import ts from 'typescript-legacy';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGES = ['packages/agent-core-v2', 'packages/kap-server', 'packages/transcript'];
const DIRS = ['src', 'test', 'scripts'];

function collectLeaves(node, leaves, jsdocNodes) {
  if (ts.isJSDoc(node)) {
    jsdocNodes.push(node);
    return;
  }
  const children = node.getChildren();
  if (children.length === 0) {
    if (node.getWidth() > 0) leaves.push(node);
    return;
  }
  for (const c of children) collectLeaves(c, leaves, jsdocNodes);
}

function extractGapComments(gap, offset, out) {
  let i = 0;
  while (i < gap.length) {
    const ch = gap[i];
    if (' \t\n\r\f\v'.includes(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && gap[i + 1] === '/') {
      let j = gap.indexOf('\n', i);
      if (j === -1) j = gap.length;
      out.push({ pos: offset + i, end: offset + j, jsdoc: false });
      i = j;
      continue;
    }
    if (ch === '/' && gap[i + 1] === '*') {
      const close = gap.indexOf('*/', i + 2);
      const j = close === -1 ? gap.length : close + 2;
      out.push({ pos: offset + i, end: offset + j, jsdoc: gap.startsWith('/**', i) });
      i = j;
      continue;
    }
    break;
  }
}

function checkFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

  const leaves = [];
  const jsdocNodes = [];
  collectLeaves(sf, leaves, jsdocNodes);
  leaves.sort((a, b) => a.getStart(sf) - b.getStart(sf));

  const comments = [];
  let cursor = 0;
  if (text.startsWith('#!')) {
    const nl = text.indexOf('\n');
    cursor = nl === -1 ? text.length : nl + 1;
  }
  for (const leaf of leaves) {
    const s = leaf.getStart(sf);
    if (s > cursor) extractGapComments(text.slice(cursor, s), cursor, comments);
    cursor = Math.max(cursor, leaf.getEnd());
  }
  if (cursor < text.length) extractGapComments(text.slice(cursor), cursor, comments);
  for (const d of jsdocNodes) {
    comments.push({ pos: d.getStart(sf), end: d.getEnd(), jsdoc: true });
  }

  const seen = new Set();
  const violations = [];
  for (const c of comments) {
    const key = `${c.pos}:${c.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = text.slice(0, c.pos).split('\n').length;
    const snippet = text.slice(c.pos, Math.min(c.end, c.pos + 60)).replaceAll(/\s+/g, ' ');
    if (/(?:oxlint|eslint)-disable/.test(snippet)) continue;
    const isDirective = /@ts-(expect-error|ignore|nocheck)|prettier-ignore|istanbul|c8 ignore/.test(
      snippet,
    );
    violations.push({ line, snippet, isDirective, jsdoc: c.jsdoc });
  }
  return violations;
}

const files = [];
for (const pkg of PACKAGES) {
  for (const dir of DIRS) {
    const root = path.join(ROOT, pkg, dir);
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') stack.push(p);
        } else if (/\.(ts|tsx|mts|mjs)$/.test(e.name)) {
          files.push(p);
        }
      }
    }
  }
}

// `--print-counts` reports every file's raw violation count in ledger format,
// ignoring the baseline. It is how the ledger below is regenerated.
const PRINT_COUNTS = process.argv.includes('--print-counts');

const BASELINE_PATH = path.join(ROOT, 'scripts', 'no-comments-baseline.txt');

function repoRel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return new Map();
  const entries = new Map();
  for (const raw of fs.readFileSync(BASELINE_PATH, 'utf8').split('\n')) {
    const line = raw.trimEnd();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^(\S+)\s+(\d+)(?:\s+(\S+))?$/.exec(line);
    if (match === null) continue;
    entries.set(match[1], { count: Number(match[2]), digest: match[3] });
  }
  return entries;
}

/**
 * A digest over the accepted comments themselves, so the ledger pins *which*
 * comments were reviewed and not merely how many. The count alone had a hole:
 * a file could drop one accepted comment and add a different one, keep its
 * count, and pass — the same hole `check-no-hardcoded-prose.mjs` closed with a
 * digest. Order-insensitive per file, so moving a comment is not news.
 */
function digestOf(violations) {
  const texts = violations.map((v) => v.snippet.trim()).sort();
  return createHash('sha256').update(texts.join('\n')).digest('hex').slice(0, 12);
}

function describe(rel, v) {
  if (v.isDirective) {
    return `${rel}:${v.line}: tooling directives are not allowed — fix the underlying lint/type problem instead: ${v.snippet}`;
  }
  if (v.jsdoc) {
    return `${rel}:${v.line}: JSDoc is not allowed in this package: ${v.snippet}`;
  }
  return `${rel}:${v.line}: comments are not allowed in this package: ${v.snippet}`;
}

const baseline = loadBaseline();
const swapped = [];
const matchedBaseline = new Set();
let rejected = 0;
let accepted = 0;

if (PRINT_COUNTS) {
  const counted = [];
  for (const f of files) {
    const violations = checkFile(f);
    if (violations.length > 0) {
      counted.push([repoRel(f), violations.length, digestOf(violations)]);
    }
  }
  counted.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [rel, count, digest] of counted) console.log(`${rel}  ${count}  ${digest}`);
  process.exit(0);
}

for (const f of files) {
  const violations = checkFile(f);
  if (violations.length === 0) continue;

  const rel = repoRel(f);
  const allowed = baseline.get(rel);
  const tolerated = allowed?.count ?? 0;
  if (tolerated > 0) matchedBaseline.add(rel);

  if (violations.length <= tolerated) {
    accepted += violations.length;
    if (violations.length === tolerated && allowed?.digest !== undefined) {
      const digest = digestOf(violations);
      if (digest !== allowed.digest) swapped.push(`${rel}  ${digest}`);
    }
    continue;
  }

  accepted += tolerated;
  for (const v of violations.slice(tolerated)) {
    rejected++;
    console.error(describe(rel, v));
  }
}

if (swapped.length > 0) {
  console.error(
    `check-no-comments: ${swapped.length} file(s) replaced an accepted comment with a different one.`,
  );
  for (const entry of swapped) console.error(`  ${entry}`);
  console.error(
    'A reviewed comment may not be swapped for another. Run `--print-counts` if the replacement really is the reviewed state.',
  );
  process.exit(1);
}

// A ledger that cannot rot: an entry whose file now carries fewer (or no)
// violations is reported so the number can be lowered or the entry removed.
const stale = [];
for (const [rel, allowed] of baseline) {
  if (!matchedBaseline.has(rel)) stale.push(`${rel}  ${allowed.count}`);
}

if (rejected > 0) {
  console.error(`check-no-comments: ${rejected} violation(s) in ${PACKAGES.join(', ')}`);
  if (accepted > 0) {
    console.error(
      `check-no-comments: ${accepted} more accepted by scripts/no-comments-baseline.txt`,
    );
  }
  if (stale.length > 0) {
    console.error('check-no-comments: baseline entries no longer matching anything, remove them:');
    for (const s of stale) console.error(`  ${s}`);
  }
  process.exit(1);
}

for (const [rel, allowed] of baseline) {
  if (!matchedBaseline.has(rel)) continue;
  const tolerated = allowed.count;
  const current = checkFile(path.join(ROOT, rel)).length;
  if (current < tolerated) {
    console.error(
      `info: ${rel} now has ${current} violation(s), baseline allows ${tolerated} — lower it`,
    );
  }
}

if (stale.length > 0) {
  console.error('check-no-comments: baseline entries no longer matching anything, remove them:');
  for (const s of stale) console.error(`  ${s}`);
}

console.log(
  `check-no-comments: OK (${files.length} files, ${accepted} accepted by scripts/no-comments-baseline.txt)`,
);
