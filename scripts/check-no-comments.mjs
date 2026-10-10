import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

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

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return new Map();
  const entries = new Map();
  for (const raw of fs.readFileSync(BASELINE_PATH, 'utf8').split('\n')) {
    const line = raw.trimEnd();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^(\S+)\s+(\d+)$/.exec(line);
    if (match === null) continue;
    entries.set(match[1], Number(match[2]));
  }
  return entries;
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
const matchedBaseline = new Set();
let rejected = 0;
let accepted = 0;

if (PRINT_COUNTS) {
  const counted = [];
  for (const f of files) {
    const count = checkFile(f).length;
    if (count > 0) counted.push([path.relative(ROOT, f), count]);
  }
  counted.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [rel, count] of counted) console.log(`${rel}  ${count}`);
  process.exit(0);
}

for (const f of files) {
  const violations = checkFile(f);
  if (violations.length === 0) continue;

  const rel = path.relative(ROOT, f);
  const tolerated = baseline.get(rel) ?? 0;
  if (tolerated > 0) matchedBaseline.add(rel);

  if (violations.length <= tolerated) {
    accepted += violations.length;
    continue;
  }

  accepted += tolerated;
  for (const v of violations.slice(tolerated)) {
    rejected++;
    console.error(describe(rel, v));
  }
}

// A ledger that cannot rot: an entry whose file now carries fewer (or no)
// violations is reported so the number can be lowered or the entry removed.
const stale = [];
for (const [rel, tolerated] of baseline) {
  if (!matchedBaseline.has(rel)) stale.push(`${rel}  ${tolerated}`);
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

for (const [rel, tolerated] of baseline) {
  if (!matchedBaseline.has(rel)) continue;
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
