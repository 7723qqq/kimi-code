#!/usr/bin/env bun

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const BASELINE_PATH = join(import.meta.dirname, 'deep-import-baseline.txt');

const ENGINE_PREFIX = '@moonshot-ai/agent-core-v2/';
const SCAN_ROOTS = ['packages', 'apps'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-web', 'coverage', '.git', '参考目录']);

const SERVICE_IDENTIFIER_RE = /\bI[A-Z][A-Za-z0-9]*(?:Service|Catalog|Index|Manager|Browser|Store|Registry)\b/;

const IMPORT_STATEMENT_RE = /^\s*(?:import|export)\b/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(abs, out);
    else if (abs.endsWith('.ts') || abs.endsWith('.tsx')) out.push(abs);
  }
  return out;
}

function rootReachableModules() {
  const index = readFileSync(join(REPO_ROOT, 'packages/agent-core-v2/src/index.ts'), 'utf8');
  const out = new Set();
  for (const m of index.matchAll(/from '#\/(?:human\/)?([^']+)'/g)) out.add(m[1].replace(/\.ts$/, ''));
  return out;
}

function loadBaseline() {
  let text;
  try {
    text = readFileSync(BASELINE_PATH, 'utf8');
  } catch {
    return new Set();
  }
  const out = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    out.add(line);
  }
  return out;
}

function statementOpener(lines, index) {
  for (let i = index; i >= 0 && index - i < 40; i--) {
    if (IMPORT_STATEMENT_RE.test(lines[i])) return lines[i];
    if (lines[i].trim() === '' && i !== index) return null;
  }
  return null;
}

export function findViolations({ rootReachable, baseline }) {
  const violations = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of walk(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, abs);
      let source;
      try {
        source = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const lines = source.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(new RegExp(`${ENGINE_PREFIX.replace(/[/\\]/g, '\\$&')}([a-zA-Z0-9/_-]+)`.replace('@', '@')));
        if (!m) continue;
        const sub = m[1];
        const key = `${rel} ${sub}`;
        if (baseline.has(key)) continue;

        const opener = statementOpener(lines, i);
        const typeOnly = opener !== null && /^\s*(?:import|export)\s+type\s/.test(opener);
        if (typeOnly) continue;

        if (rootReachable.has(sub)) {
          violations.push({
            file: rel,
            line: i + 1,
            message: `imports ${ENGINE_PREFIX}${sub}, which the engine's root entry already re-exports — import from '@moonshot-ai/agent-core-v2' instead`,
          });
          continue;
        }

        if (SERVICE_IDENTIFIER_RE.test(lines[i])) continue;
        if (/^\s*import\s*\(\s*$/.test(lines[i]) || /^\s*\)\s*;?\s*$/.test(lines[i])) continue;

        violations.push({
          file: rel,
          line: i + 1,
          message: `deep import into the engine (${ENGINE_PREFIX}${sub}) — use the public surface, or add it to ${relative(REPO_ROOT, BASELINE_PATH)} if it is a deliberate exception`,
        });
      }
    }
  }
  return violations;
}

function main() {
  const violations = findViolations({
    rootReachable: rootReachableModules(),
    baseline: loadBaseline(),
  });

  if (violations.length === 0) {
    console.log('check-deep-imports: OK');
    return 0;
  }
  for (const v of violations) console.error(`${v.file}:${v.line}: ${v.message}`);
  console.error(`\ncheck-deep-imports: ${violations.length} violation(s)`);
  return 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === import.meta.filename;
if (isMain) process.exit(main());
