#!/usr/bin/env bun
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const json = args.includes('--json');
const listLimit = Number(args.find((a) => a.startsWith('--list='))?.slice(7) ?? 10);
const only = args.find((a) => a.startsWith('--rule='))?.slice(7);

const TEST_FILE = /\.(test|spec|e2e|integration)\.(ts|tsx)$/;
const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-web', 'coverage', '.tmp']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('dist')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close === -1 ? src.length : close + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const RULES = [
  {
    id: 'vitest-import',
    severity: 'error',
    scope: 'all',
    why: 'vitest is gone from the dependency graph; any import is stale.',
    pattern: /from\s+'vitest'/,
    raw: true,
  },
  {
    id: 'vi-binding',
    severity: 'error',
    scope: 'all',
    why: 'bun:test exports a vitest-compatible `vi` object; binding it routes calls through the compat layer.',
    pattern: /import\s+(?:type\s+)?\{[^}]*\bvi\b[^}]*\}\s+from\s+'[^']+'/,
  },
  {
    id: 'vi-call',
    severity: 'error',
    scope: 'all',
    why: 'Call sites must use mock/spyOn/jest directly.',
    pattern:
      /(?<![.\w$])vi\s*\.\s*(?:fn|spyOn|mock|doMock|doUnmock|importActual|mocked|hoisted|stubEnv|unstubAllEnvs|stubGlobal|unstubAllGlobals|waitFor|waitUntil|useFakeTimers|useRealTimers|advanceTimersByTime|advanceTimersByTimeAsync|runAllTimers|runAllTimersAsync|runOnlyPendingTimers|setSystemTime|getTimerCount|restoreAllMocks|clearAllMocks|resetAllMocks|resetModules)/,
  },
  {
    id: 'node-test-import',
    severity: 'error',
    scope: 'test',
    why: 'Suites run on bun:test; node:test only worked through a shim.',
    pattern: /from\s+'node:test'/,
    raw: true,
  },
  {
    id: 'node-assert',
    severity: 'warn',
    scope: 'test',
    why: 'Node assertion style; Bun-native suites use expect.',
    pattern: /from\s+'node:assert/,
    raw: true,
  },
  {
    id: 'done-callback',
    severity: 'error',
    scope: 'test',
    why: 'bun:test has no done-callback form.',
    pattern: /\b(?:it|test)\([^;]{0,400}?\(\s*done\s*\)\s*=>/s,
  },
  {
    id: 'runif',
    severity: 'error',
    scope: 'test',
    why: '`runIf` is vitest-only; bun:test silently lacks it.',
    pattern: /\b(?:it|test|describe)\.runIf\(/,
  },
  {
    id: 'expect-poll',
    severity: 'error',
    scope: 'test',
    why: '`expect.poll` is vitest-only; bun:test throws "expect.poll is not a function". Use waitForAssertion/waitUntil.',
    pattern: /(?<![.\w$])expect\s*\.\s*poll\s*\(/,
  },
  {
    id: 'skip-option',
    severity: 'error',
    scope: 'test',
    why: 'bun:test ignores the `{ skip }` option object, so the test runs anyway.',
    pattern: /\b(?:it|test|describe)\([^)]{0,400}\{\s*skip\s*:/s,
  },
  {
    id: 'todo-option',
    severity: 'warn',
    scope: 'test',
    why: 'bun:test ignores the `{ todo }` option object.',
    pattern: /\b(?:it|test)\([^)]{0,400}\{\s*todo\s*:/s,
  },
  {
    id: 'node-test-context',
    severity: 'error',
    scope: 'test',
    why: 'node:test context helpers (t.after / t.diagnostic / t.mock) do not exist in bun:test.',
    pattern: /\bt\.(after|before|diagnostic)\s*\(|\bt\.mock\b/,
  },
  {
    id: 'vitest-only-matcher',
    severity: 'error',
    scope: 'test',
    why: 'bun:test implements these only as vitest aliases at runtime; types do not cover them.',
    pattern:
      /\.(toHaveBeenCalledOnce|toHaveBeenCalledExactlyOnceWith|toHaveBeenLastCalledOnce|toSatisfy|toBeOneOf|toBeTypeOf|toBeEmpty|toHaveResolved|toHaveLastResolvedWith|toHaveBeenCalledBefore|toHaveBeenCalledAfter)\s*\(/,
  },
  {
    id: 'handwritten-vitest-shim',
    severity: 'error',
    scope: 'all',
    why: 'A hand-written stand-in for a legacy runner API is never better than the Bun 1.4 original (spyOn + mock.restore + Bun.env); rewrite it against the native primitive.',
    pattern:
      /Bun has no|no equivalent of|runner-compatible|stand-in for (?:a )?(?:legacy )?runner|instead of the legacy/i,
  },
  {
    id: 'wallclock-threshold',
    severity: 'warn',
    scope: 'test',
    why: 'Real-millisecond thresholds flake under --isolate / load; assert order or inject a clock.',
    pattern: /Date\.now\(\)\s*-\s*[\w$]+\s*\)?\s*\.toBeLessThan\(/,
  },
  {
    id: 'fake-timer-date',
    severity: 'warn',
    scope: 'test',
    why: 'Bun fake timers also fake Date.now, so the assertion silently measures fake time.',
    pattern: /useFakeTimers\(/,
    needs: /Date\.now\(/,
  },
];

const files = walk(join(ROOT, 'packages')).concat(walk(join(ROOT, 'apps')), walk(join(ROOT, 'scripts')));
const SELF = 'scripts/scan-test-residue.mjs';
const results = [];
for (const rule of RULES) {
  if (only !== undefined && rule.id !== only) continue;
  const hits = [];
  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/');
    if (rel === SELF) continue;
    const isTest = TEST_FILE.test(file) || /\/test\//.test(rel);
    if (rule.scope === 'test' && !isTest) continue;
    if (rule.scope === 'source' && isTest) continue;
    if (!SOURCE_FILE.test(file) && !/\.(mjs|cjs)$/.test(file)) continue;
    const raw = readFileSync(file, 'utf8');
    const code = rule.raw ? raw : stripComments(raw);
    if (!rule.pattern.test(code)) continue;
    if (rule.needs && !rule.needs.test(code)) continue;
    hits.push(rel);
  }
  results.push({ ...rule, hits });
}

const configLeftovers = ['vitest.config.ts', 'vitest.projects.ts', 'vitest.bench.config.ts']
  .map((name) => ({ name, present: files.some((f) => f.endsWith(`/${name}`)) || existsSync(join(ROOT, name)) }))
  .filter((entry) => entry.present);

if (json) {
  console.log(JSON.stringify({ files: files.length, rules: results.map(({ pattern: _pattern, needs: _needs, ...rest }) => rest), configLeftovers }, null, 2));
} else {
  console.log(`scanned ${files.length} files under packages/ apps/ scripts/`);
  console.log(`stripped comments and string literals before matching; template literals kept\n`);
  console.log('severity  rule                       hits  why');
  console.log('--------  -------------------------  ----  ---');
  for (const rule of results) {
    const sev = rule.severity === 'error' ? 'error   ' : 'warn    ';
    console.log(`${sev}  ${rule.id.padEnd(25)}  ${String(rule.hits.length).padStart(4)}  ${rule.why}`);
    for (const file of rule.hits.slice(0, listLimit)) console.log(`                                 ${file}`);
    if (rule.hits.length > listLimit) console.log(`                                 … +${rule.hits.length - listLimit} more`);
  }
  console.log(`\nconfig leftovers: ${configLeftovers.length === 0 ? 'none' : configLeftovers.map((c) => c.name).join(', ')}`);
}

const errorCount = results.filter((r) => r.severity === 'error').reduce((sum, r) => sum + r.hits.length, 0);
process.exit(errorCount === 0 ? 0 : 1);
