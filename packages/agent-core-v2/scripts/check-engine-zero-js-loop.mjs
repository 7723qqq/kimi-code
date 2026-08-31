import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const packageRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const sourceFile = path.join(packageRoot, 'src', 'agent', 'loop', 'loopService.ts');
const testFile = 'packages/agent-core-v2/test/agent/loop/rustEngineZeroJsLoop.test.ts';
const coverageTarget = 'packages/agent-core-v2/src/agent/loop/loopService.ts';

/**
 * The JS step loop of agent-core-v2 — the code the Rust engine replaces
 * (ROADMAP P34: executeLoopStep and everything only it calls). When a
 * TurnEngine override drives the turn, none of these functions may run.
 * Renaming or moving one of them must come with an update to this list —
 * a stale name fails the check by design.
 */
const JS_ONLY_FUNCTIONS = [
  'executeLoopStep',
  'beginStep',
  'appendResponseContent',
  'appendInterruptedStreamContent',
  'executeStepTools',
  'finishStep',
  'emitStepCompleted',
  'createStreamPartHandler',
];

/**
 * Shared-shell functions on the engine path. They must show call hits in
 * the vehicle run — otherwise the run proved nothing (vacuous pass).
 */
const ENGINE_PATH_FUNCTIONS = ['executeTurnViaEngine', 'buildEngineInput', 'runAfterStep'];

function declarationLine(source, name) {
  const pattern = new RegExp(`^  (?:private |public |override |static |async )*(?:async )?${name}\\(`);
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return;
}

function fail(message) {
  console.error(`check-engine-zero-js-loop: FAIL\n${message}`);
  process.exit(1);
}

const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-engine-cov-'));
try {
  const result = spawnSync(
    'bun',
    [
      'x',
      '--bun',
      'vitest',
      'run',
      testFile,
      '--coverage',
      `--coverage.include=${coverageTarget}`,
      '--coverage.reporter=json',
      `--coverage.reportsDirectory=${reportsDir}`,
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.status !== 0) {
    const tail = (result.stdout ?? '').split('\n').slice(-25).join('\n');
    fail(`the engine-path vehicle test run failed (exit ${result.status}):\n${tail}`);
  }

  const reportPath = path.join(reportsDir, 'coverage-final.json');
  if (!fs.existsSync(reportPath)) {
    fail('coverage-final.json was not produced — the vitest coverage invocation changed');
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const entry = Object.entries(report).find(([file]) =>
    file.replaceAll('\\', '/').endsWith(coverageTarget),
  );
  if (entry === undefined) {
    fail(`loopService.ts was not instrumented — expected a report key ending with ${coverageTarget}`);
  }

  const source = fs.readFileSync(sourceFile, 'utf8');
  const violations = [];
  for (const name of [...JS_ONLY_FUNCTIONS, ...ENGINE_PATH_FUNCTIONS]) {
    const declLine = declarationLine(source, name);
    if (declLine === undefined) {
      violations.push(`${name}(): declaration not found in loopService.ts — contract drift`);
      continue;
    }
    const matches = Object.entries(entry[1].fnMap).filter(
      ([, fn]) => fn.decl?.start?.line === declLine,
    );
    if (matches.length !== 1) {
      violations.push(
        `${name}(): ${matches.length} fnMap entries at line ${declLine} — contract drift, update check-engine-zero-js-loop.mjs`,
      );
    }
  }
  if (violations.length === 0) {
    const hitsOf = (name) => {
      const declLine = declarationLine(source, name);
      const [id] = Object.entries(entry[1].fnMap).find(([, fn]) => fn.decl?.start?.line === declLine);
      return { declLine, hits: entry[1].f[id] };
    };
    for (const name of JS_ONLY_FUNCTIONS) {
      const { declLine, hits } = hitsOf(name);
      if (hits !== 0) {
        violations.push(`${name}() (loopService.ts:${declLine}) ran ${hits} time(s) under the engine override`);
      }
    }
    for (const name of ENGINE_PATH_FUNCTIONS) {
      const { declLine, hits } = hitsOf(name);
      if (hits === 0) {
        violations.push(
          `${name}() (loopService.ts:${declLine}) shows zero call hits — the engine path never ran, the proof is vacuous`,
        );
      }
    }
  }

  if (violations.length > 0) {
    fail(
      `v2 loop code executed under a TurnEngine override:\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    );
  }
  console.log(
    `check-engine-zero-js-loop: OK — ${JS_ONLY_FUNCTIONS.length} JS-loop functions never invoked, ` +
      `${ENGINE_PATH_FUNCTIONS.length} engine-path functions invoked (loopService.ts)`,
  );
} finally {
  fs.rmSync(reportsDir, { recursive: true, force: true });
}