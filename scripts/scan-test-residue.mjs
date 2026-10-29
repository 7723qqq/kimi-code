#!/usr/bin/env bun
/**
 * Runner-semantics residue scanner.
 *
 * Two test runners' semantics must never mix in this repository. This script is
 * the single mechanical entry point that proves which side a file is on: every
 * rule below names one Bun 1.4.4 behaviour that is missing, silently ignored, or
 * only emulated by a compatibility alias, so a hit is residue rather than style.
 *
 * Sources of truth for the rules:
 *   - `node_modules/bun-types/test.d.ts` — the runner's real surface (`vi` is a
 *     `typeof jest.*` alias; no `advanceTimersByTimeAsync`, no `runAllTimersAsync`).
 *   - `CONVENTIONS.md` § Testing Rules — `bun:test` only; no vitest dependency.
 *
 * Usage:
 *   bun scripts/scan-test-residue.mjs                 # table, capped per rule
 *   bun scripts/scan-test-residue.mjs --list=100      # raise the cap
 *   bun scripts/scan-test-residue.mjs --json          # full machine-readable list
 *   bun scripts/scan-test-residue.mjs --rule=node-assert
 *   bun scripts/scan-test-residue.mjs --baseline=path # accepted exceptions, see below
 *
 * `--baseline` names a JSON file of `{ "<rule>": { "<path>": "<reason>" } }`. A
 * hit listed there is reported as "accepted" with its reason instead of failing
 * the run, which is how a constraint Bun genuinely cannot satisfy stays visible
 * instead of being demoted. A reason is mandatory: an empty string is rejected,
 * so an exception cannot be added silently.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const json = args.includes('--json');
const listLimit = Number(args.find((a) => a.startsWith('--list='))?.slice(7) ?? 10);
const only = args.find((a) => a.startsWith('--rule='))?.slice(7);
const baselineArg = args.find((a) => a.startsWith('--baseline='))?.slice(11);
// Defaults to the repository this script lives in. `--root` exists so the
// regression suite can point the scanner at a fixture tree; without it the
// scanner always walked the real repo and could only be tested by mutating it.
const rootArg = args.find((a) => a.startsWith('--root='))?.slice(7);

const ROOT = rootArg !== undefined ? resolve(process.cwd(), rootArg) : join(import.meta.dirname, '..');

const TEST_FILE = /\.(test|spec|e2e|integration)\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-web', 'coverage', '.tmp']);

// Every top-level directory that can hold code. `tools/` and `plugins/` were
// previously unscanned, which let a `#!/usr/bin/env node` entry point and two
// `tools/review/*.mjs` scripts pass as clean.
const SCAN_ROOT = ['packages', 'apps', 'scripts', 'tools', 'plugins'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('dist')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/**
 * Blanks out string literals (so a full-text rule does not match prose or a
 * path) and, unless `keepComments` is set, comments as well.
 *
 * Two rule families need an escape hatch, and both used to be silently broken:
 *
 *  - `keepComments` — the `handwritten-vitest-shim` rule keys on the explanatory
 *    comment a shim author leaves behind ("Bun has no `expect.poll`"). Stripping
 *    comments first made that rule unreachable, so it always reported zero hits.
 *  - `keepStrings` — an import rule has to see the module specifier, which *is* a
 *    string literal. Blanking strings made every `from '...'` rule match nothing.
 *
 * The default (strip both) stays the safe choice for full-text rules.
 */
function strip(src, { keepComments = false, keepStrings = false } = {}) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    // A string is consumed first, on purpose. Checking `//` and `/*` first meant
    // a URL (`"https://..."`) or a glob inside a string opened a comment that
    // swallowed the rest of the file — `package.json` scripts after
    // `KIMI_CODE_DEV_MARKETPLACE_URL=https://...` were never scanned at all.
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let end = i + 1;
      while (end < src.length) {
        if (src[end] === '\\') {
          end += 2;
          continue;
        }
        if (src[end] === quote) {
          end += 1;
          break;
        }
        end += 1;
      }
      out += keepStrings ? src.slice(i, end) : ' ';
      i = end;
      continue;
    }
    if (!keepComments && ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (!keepComments && ch === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close === -1 ? src.length : close + 2;
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
    pattern: /from\s*['"]vitest['"]/,
    keepStrings: true,
  },
  {
    id: 'vi-binding',
    severity: 'error',
    scope: 'all',
    why: 'bun:test exports a vitest-compatible `vi` object; binding it routes calls through the compat layer.',
    pattern: /import\s+(?:type\s+)?\{[^}]*\bvi\b[^}]*\}\s+from\s+['"][^'"]+['"]/,
    keepStrings: true,
  },
  {
    id: 'vi-call',
    severity: 'error',
    scope: 'all',
    why: 'Call sites must use mock/spyOn/jest directly.',
    pattern:
      /(?<![.\w$])vi\s*\.\s*(?:fn|spyOn|mock|doMock|doUnmock|importActual|mocked|hoisted|stubEnv|unstubAllEnvs|stubGlobal|unstubAllGlobals|waitFor|waitUntil|useFakeTimers|useRealTimers|advanceTimersByTime|advanceTimersByTimeAsync|runAllTimers|runAllTimersAsync|runOnlyPendingTimers|setSystemTime|getTimerCount|restoreAllMocks|clearAllMocks|resetAllMocks|resetModules)/,
  },
  {
    id: 'node-test-import',
    severity: 'error',
    scope: 'all',
    why: 'Suites run on bun:test; node:test only worked through a shim.',
    pattern: /(?:from\s+|require\(\s*)['"]node:test['"]/,
    keepStrings: true,
  },
  {
    id: 'node-assert',
    severity: 'warn',
    scope: 'all',
    why: 'Node assertion style; Bun-native suites use expect.',
    pattern: /(?:from\s+|require\(\s*)['"]node:assert(?:\/strict)?['"]/,
    keepStrings: true,
  },
  {
    id: 'node-shebang',
    severity: 'warn',
    scope: 'all',
    why: 'A `#!/usr/bin/env node` entry point enters the file through Node semantics; Bun is the repository runtime.',
    pattern: /^#!.*\bnode\b/m,
    keepComments: true,
  },  {
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
    id: 'captured-promise-matcher',
    severity: 'error',
    scope: 'test',
    why: 'Bun settles `.rejects`/`.resolves` eagerly: capturing `expect(p).rejects.toThrow()` in a variable blocks the event loop until p settles, so timers — the per-test timeout included — stop firing and the file never finishes. Await the matcher once the rejection is known to have happened.',
    pattern: /(?<!\bawait\s)expect\s*\([^()]*\)\s*\.\s*(?:rejects|resolves)\b/,
  },
  {
    id: 'handwritten-vitest-shim',
    severity: 'error',
    scope: 'all',
    why: 'A hand-written stand-in for a legacy runner API is never better than the Bun 1.4 original (spyOn + mock.restore + Bun.env); rewrite it against the native primitive, or list it in the baseline with the reason Bun cannot.',
    pattern:
      /Bun has no|Bun lacks|no equivalent of|runner-compatible|stand-in for (?:a )?(?:legacy )?runner|instead of the legacy/i,
    keepComments: true,
  },
  {
    id: 'node-launched-script',
    severity: 'warn',
    scope: 'all',
    why: 'A real command that starts a file with `node` keeps Node in the loop where Bun is the runtime. Usage text in an error message is not a hit.',
    pattern: /"[^"]*\bnode\s+(?:scripts|tools|apps)\/[\w./-]+[^"]*"/,
    keepComments: true,
  },
  {
    id: 'node-package-script',
    severity: 'warn',
    scope: 'all',
    why: 'A package.json script that launches a file with `node` runs that file on Node, not on the repository runtime.',
    pattern: /"(?:[^"]*)":\s*"[^"]*\bnode\s+[\w./-]+\.(?:c|m)?js\b[^"]*"/,
    files: /package\.json$/,
    keepStrings: true,
  },
  {
    id: 'vitest-import-require',
    severity: 'error',
    scope: 'all',
    why: 'vitest is gone from the dependency graph; a `require` reaches the same stale resolution as an import.',
    pattern: /require\(\s*['"]vitest['"]\s*\)/,
    keepStrings: true,
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

const files = SCAN_ROOT.flatMap((dir) => (existsSync(join(ROOT, dir)) ? walk(join(ROOT, dir)) : []));
// The repository root's own manifests were never walked: `SCAN_ROOT` only holds
// subdirectories, so a root `package.json` script could launch Node unnoticed.
for (const name of ['package.json']) {
  const rootManifest = join(ROOT, name);
  if (existsSync(rootManifest)) files.push(rootManifest);
}
const SELF = 'scripts/scan-test-residue.mjs';

const baseline = baselineArg !== undefined && existsSync(join(ROOT, baselineArg))
  ? JSON.parse(readFileSync(join(ROOT, baselineArg), 'utf8'))
  : {};

// A reasonless exception would hide residue instead of documenting it, so a
// baseline entry without one fails the run as loudly as the raw hit did.
const missingReasons = [];
for (const [ruleId, entries] of Object.entries(baseline)) {
  const shape = entries !== null && typeof entries === 'object' && !Array.isArray(entries);
  if (!shape) {
    missingReasons.push(`${ruleId}: must be an object mapping path -> reason`);
    continue;
  }
  for (const [path, reason] of Object.entries(entries)) {
    if (typeof reason !== 'string' || reason.trim() === '') missingReasons.push(`${ruleId}: ${path}`);
  }
}

const results = [];
for (const rule of RULES) {
  if (only !== undefined && rule.id !== only) continue;
  const accepted = baseline[rule.id] ?? {};
  const hits = [];
  const acceptedHits = [];
  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/');
    if (rel === SELF) continue;
    const isTest = TEST_FILE.test(file) || /\/test\//.test(rel);
    if (rule.scope === 'test' && !isTest) continue;
    if (rule.scope === 'source' && isTest) continue;
    if (!SOURCE_FILE.test(file) && !(rule.files?.test(rel) ?? false)) continue;
    const raw = readFileSync(file, 'utf8');
    const code = strip(raw, {
      keepComments: rule.keepComments === true,
      keepStrings: rule.keepStrings === true,
    });
    if (!rule.pattern.test(code)) continue;
    if (rule.needs && !rule.needs.test(strip(raw))) continue;
    if (accepted[rel] !== undefined) acceptedHits.push({ path: rel, reason: accepted[rel] });
    else hits.push(rel);
  }
  results.push({ ...rule, hits, accepted: acceptedHits });
}

const configLeftovers = ['vitest.config.ts', 'vitest.projects.ts', 'vitest.bench.config.ts']
  .map((name) => ({ name, present: files.some((f) => f.endsWith(`/${name}`)) || existsSync(join(ROOT, name)) }))
  .filter((entry) => entry.present);

const errorCount = results.filter((r) => r.severity === 'error').reduce((sum, r) => sum + r.hits.length, 0);

if (json) {
  console.log(
    JSON.stringify(
      {
        files: files.length,
        scannedRoots: SCAN_ROOT.filter((dir) => existsSync(join(ROOT, dir))),
        baseline: baselineArg ?? null,
        rules: results.map(({ pattern: _pattern, needs: _needs, ...rest }) => rest),
        configLeftovers,
        missingBaselineReasons: missingReasons,
        exitCode: errorCount === 0 && missingReasons.length === 0 ? 0 : 1,
      },
      null,
      2,
    ),
  );
} else {
  const roots = SCAN_ROOT.filter((dir) => existsSync(join(ROOT, dir)));
  console.log(`scanned ${files.length} files under ${roots.join('/ ')}/`);
  console.log('string literals blanked before matching; comments kept only for the rules that key on them\n');
  console.log('severity  rule                       hits  accepted  why');
  console.log('--------  -------------------------  ----  --------  ---');
  for (const rule of results) {
    const sev = rule.severity === 'error' ? 'error   ' : 'warn    ';
    const acceptedCount = String(rule.accepted.length).padStart(8);
    console.log(`${sev}  ${rule.id.padEnd(25)}  ${String(rule.hits.length).padStart(4)}  ${acceptedCount}  ${rule.why}`);
    for (const file of rule.hits.slice(0, listLimit)) console.log(`                                 ${file}`);
    if (listLimit > 0 && rule.hits.length > listLimit) {
      console.log(`                                 … +${rule.hits.length - listLimit} more (--list=${rule.hits.length})`);
    }
    for (const entry of rule.accepted) {
      console.log(`                                 accepted ${entry.path}`);
      console.log(`                                   reason: ${entry.reason}`);
    }
  }
  const assertRule = results.find((rule) => rule.id === 'node-assert');
  if (assertRule !== undefined && assertRule.hits.length > 0) {
    const byPackage = new Map();
    for (const file of assertRule.hits) {
      const pkg = file.split('/').slice(0, file.startsWith('apps/') ? 2 : 2).join('/');
      byPackage.set(pkg, (byPackage.get(pkg) ?? 0) + 1);
    }
    console.log(`\nnode-assert breakdown by package (${assertRule.hits.length} files):`);
    for (const [pkg, count] of [...byPackage.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}  ${pkg}`);
    }
  }
  const acceptedTotal = results.reduce((sum, rule) => sum + rule.accepted.length, 0);
  console.log(`\nconfig leftovers: ${configLeftovers.length === 0 ? 'none' : configLeftovers.map((c) => c.name).join(', ')}`);
  console.log(`accepted by baseline: ${acceptedTotal}`);
  if (missingReasons.length > 0) {
    console.log('\nbaseline entries missing a reason (rejected):');
    for (const entry of missingReasons) console.log(`  ${entry}`);
  }
}

process.exit(errorCount === 0 && missingReasons.length === 0 ? 0 : 1);
