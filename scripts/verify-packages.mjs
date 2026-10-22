#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const LOG_DIR = join(ROOT, '.tmp', 'verify');
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const json = args.includes('--json');
const skipTypecheck = args.includes('--no-typecheck');
const concurrency = Number(args.find((a) => a.startsWith('--parallel='))?.slice(11) ?? '4');
const stepTimeoutMs = Number(args.find((a) => a.startsWith('--timeout='))?.slice(10) ?? '1800') * 1000;
const budgetSeconds = Number(args.find((a) => a.startsWith('--budget='))?.slice(9) ?? '120');
const changedOnly = args.includes('--changed');

mkdirSync(LOG_DIR, { recursive: true });

function collectPackages() {
  const packages = [];
  for (const group of ['packages', 'apps', 'apps/vis']) {
    const groupDir = join(ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir)) {
      if (name === 'node_modules') continue;
      const dir = join(groupDir, name);
      const manifestPath = join(dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (!manifest.scripts?.test && !manifest.scripts?.typecheck) continue;
      packages.push({
        dir,
        label: relative(ROOT, dir).split(sep).join('/'),
        name: manifest.name,
        hasTest: Boolean(manifest.scripts?.test),
        hasTypecheck: Boolean(manifest.scripts?.typecheck),
      });
    }
  }
  return packages.sort((a, b) => a.label.localeCompare(b.label));
}

function runStep(pkg, script) {
  const logName = `${pkg.label.replaceAll('/', '_')}-${script}.log`;
  const logPath = join(LOG_DIR, logName);
  const started = Date.now();
  process.stdout.write(`  ▶ ${script.padEnd(9)} ${pkg.label}\n`);
  return new Promise((resolve) => {
    const child = spawn('bun', ['run', script], {
      cwd: pkg.dir,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
    }, stepTimeoutMs);
    child.on('close', (code) => {
      clearTimeout(killer);
      writeFileSync(logPath, output);
      resolve({
        output,
        seconds: (Date.now() - started) / 1000,
        timedOut: code === null || code === 137 || code === 143,
      });
    });
  });
}

function parseTypecheck(output) {
  return (output.match(/error TS\d+/g) ?? []).length;
}

function parseTest(output) {
  const num = (pattern) => {
    const match = output.match(pattern);
    return match ? Number(match[1]) : 0;
  };
  const ran = output.match(/Ran (\d+) tests across (\d+) files\. \[([\d.]+)(m?s)\]/);
  return {
    pass: num(/^\s*(\d+) pass$/m),
    fail: num(/^\s*(\d+) fail$/m),
    errors: num(/^\s*(\d+) errors?$/m),
    skip: num(/^\s*(\d+) skip$/m),
    seconds: ran ? (ran[4] === 'ms' ? Number(ran[3]) / 1000 : Number(ran[3])) : undefined,
  };
}

function changedPackages() {
  const out = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const paths = `${out.stdout ?? ''}`.split(/\r?\n/).filter(Boolean);
  const labels = new Set();
  for (const path of paths) {
    const parts = path.split('/');
    if (parts.length < 2) continue;
    const scope = parts[0] === 'apps' && parts[1] === 'vis' ? parts.slice(0, 3).join('/') : parts.slice(0, 2).join('/');
    labels.add(scope);
  }
  return labels;
}

const changed = changedOnly ? changedPackages() : undefined;
const packages = collectPackages().filter((pkg) => {
  if (only !== undefined) return pkg.name === only || pkg.label.endsWith(only);
  if (changed !== undefined) return changed.has(pkg.label);
  return true;
});
if (packages.length === 0) {
  console.error(`no package matched --only=${String(only)}`);
  process.exit(1);
}

const rows = new Map(packages.map((pkg) => [pkg.label, { ...pkg }]));
let cursor = 0;

async function worker() {
  for (;;) {
    const index = cursor;
    cursor += 1;
    if (index >= packages.length) return;
    const pkg = packages[index];
    const row = rows.get(pkg.label);

    if (!skipTypecheck && pkg.hasTypecheck) {
      row.typecheckStarted = Date.now();
      const step = await runStep(pkg, 'typecheck');
      row.typecheckErrors = parseTypecheck(step.output);
      row.typecheckTimedOut = step.timedOut;
      row.typecheckSeconds = step.seconds;
      process.stdout.write(
        `${step.timedOut ? 'TIMEOUT' : row.typecheckErrors === 0 ? 'ok     ' : 'FAIL   '} typecheck ${pkg.label}${row.typecheckErrors ? ` (${row.typecheckErrors} errors)` : ''}\n`,
      );
    }

    if (pkg.hasTest) {
      const step = await runStep(pkg, 'test');
      row.test = parseTest(step.output);
      row.testTimedOut = step.timedOut;
      row.testSeconds = step.seconds;
      process.stdout.write(
        `${step.timedOut ? 'TIMEOUT' : row.test.fail === 0 && row.test.errors === 0 ? 'ok     ' : 'FAIL   '} test      ${pkg.label}  pass=${row.test.pass} fail=${row.test.fail} errors=${row.test.errors} skip=${row.test.skip} ${row.test.seconds !== undefined ? `${row.test.seconds.toFixed(1)}s` : ''}\n`,
      );
    }
  }
}

process.stdout.write(`verifying ${packages.length} packages, ${concurrency}-way parallel\n`);
await Promise.all(Array.from({ length: concurrency }, () => worker()));

const list = [...rows.values()];
const failing = list.filter(
  (r) =>
    r.typecheckTimedOut ||
    r.testTimedOut ||
    (r.typecheckErrors ?? 0) > 0 ||
    (r.test?.fail ?? 0) > 0 ||
    (r.test?.errors ?? 0) > 0,
);
const overBudget = list.filter((r) => r.testOverBudget === true);
const total = (pick) => list.reduce((sum, r) => sum + (pick(r) ?? 0), 0);
const totalPass = total((r) => r.test?.pass);
const totalFail = total((r) => r.test?.fail);
const totalErrors = total((r) => r.test?.errors);
const totalSkip = total((r) => r.test?.skip);
const totalTypecheck = total((r) => r.typecheckErrors);
const slowest = list
  .filter((r) => r.testSeconds !== undefined)
  .sort((a, b) => b.testSeconds - a.testSeconds)
  .slice(0, 6);

if (json) {
  console.log(JSON.stringify(list, null, 2));
} else {
  console.log('');
  console.log(`packages: ${list.length}`);
  console.log(`tests:    pass=${totalPass} fail=${totalFail} errors=${totalErrors} skip=${totalSkip}`);
  console.log(`typecheck errors: ${totalTypecheck}`);
  console.log(`failing packages: ${failing.length === 0 ? 'none' : failing.map((r) => r.label).join(', ')}`);
  console.log(
    `over ${budgetSeconds}s budget: ${overBudget.length === 0 ? 'none' : overBudget.map((r) => `${r.label} (${r.testSeconds.toFixed(0)}s)`).join(', ')}`,
  );
  if (slowest.length > 0) {
    console.log('slowest packages (test step):');
    for (const r of slowest) console.log(`  ${r.testSeconds.toFixed(0)}s  ${r.label}`);
  }
  console.log(`logs: ${relative(ROOT, LOG_DIR).split(sep).join('/')}/`);
}
process.exit(failing.length === 0 && overBudget.length === 0 ? 0 : 1);
