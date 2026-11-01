#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LEDGER = join(ROOT, '.upstream', 'ledger.tsv');
const COLUMNS = [
  'pr',
  'sha',
  'title',
  'cluster',
  'verdict',
  'probe',
  'evidence',
  'batch_done',
  'approved_by',
  'updated',
  'files',
];
const VERDICTS = new Set([
  'pending',
  'in_progress',
  'ported',
  'equivalent',
  'partial',
  'blocked',
  'not-applicable',
]);
const PROBE_KINDS = ['test:', 'grep:', 'absent:', 'manual:'];
const BATCHES = [
  'B1',
  'B2',
  'B3',
  'B4',
  'B5',
  'B6',
  'B7',
  'B8',
  'B9',
  'B10',
  'B11',
  'B12',
];

function fail(message) {
  process.stderr.write(`upstream-ledger: ${message}\n`);
  process.exit(1);
}

function git(args) {
  const result = Bun.spawnSync(['git', ...args], { cwd: ROOT });
  if (result.exitCode !== 0) {
    fail(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function emptyLedger() {
  return [];
}

function loadLedger() {
  if (!existsSync(LEDGER)) return emptyLedger();
  const text = readFileSync(LEDGER, 'utf8');
  const lines = text.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) return emptyLedger();
  const header = lines[0].split('\t');
  if (header.join('\t') !== COLUMNS.join('\t')) {
    fail(`ledger header does not match the ${COLUMNS.length} documented columns`);
  }
  return lines.slice(1).map((line, index) => {
    const fields = line.split('\t');
    if (fields.length !== COLUMNS.length) {
      fail(`ledger line ${index + 2} has ${fields.length} fields, expected ${COLUMNS.length}`);
    }
    const row = {};
    COLUMNS.forEach((column, position) => {
      row[column] = fields[position];
    });
    return row;
  });
}

function saveLedger(rows) {
  const lines = [COLUMNS.join('\t')];
  for (const row of rows) {
    const fields = COLUMNS.map((column) => {
      const value = String(row[column] ?? '');
      if (value.includes('\t') || value.includes('\n')) {
        fail(`field ${column} of ${row.sha} contains a tab or newline`);
      }
      return value;
    });
    lines.push(fields.join('\t'));
  }
  writeFileSync(LEDGER, `${lines.join('\n')}\n`, 'utf8');
}

function clusterIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    if (!index.has(row.sha)) index.set(row.sha, row.cluster);
  }
  return index;
}

function clusterOf(sha, hints) {
  return hints.get(sha) ?? 'unassigned';
}

function refresh() {
  git(['fetch', '--quiet', 'upstream']);
  const commitLines = git(['log', '--no-merges', '--reverse', '--format=%H%x1f%s', 'upstream/main', '^main'])
    .split('\n')
    .filter((line) => line.length > 0);
  const existing = loadLedger();
  const hints = clusterIndex(existing);
  const kept = new Map(existing.map((row) => [row.sha, row]));
  const added = [];
  for (const line of commitLines) {
    const [sha, subject] = line.split('\x1f');
    if (kept.has(sha)) continue;
    const match = /#(\d+)\)?\s*$/.exec(subject);
    const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--first-parent', sha])
      .split('\n')
      .filter((path) => path.length > 0).length;
    added.push({
      pr: match ? match[1] : '-',
      sha,
      title: subject.replace(/\s*\(#\d+\)$/, '').slice(0, 80),
      cluster: clusterOf(sha, hints),
      verdict: 'pending',
      probe: '-',
      evidence: '-',
      batch_done: 'no',
      approved_by: '-',
      updated: today(),
      files: String(files),
    });
  }
  const rows = [...existing, ...added].sort((a, b) => a.sha.localeCompare(b.sha));
  saveLedger(rows);
  process.stdout.write(`refresh: ${commitLines.length} open upstream commits, ${added.length} new rows\n`);
}

function resolveProbeTarget(target) {
  const absolute = resolve(ROOT, target);
  if (!absolute.startsWith(ROOT)) fail(`probe target escapes the repository: ${target}`);
  return absolute;
}

function runTestProbe(probe) {
  const body = probe.slice('test:'.length);
  const separator = body.indexOf('#');
  if (separator === -1) fail(`test probe needs <path>#<name>: ${probe}`);
  const path = body.slice(0, separator).trim();
  const name = body.slice(separator + 1).trim();
  if (!existsSync(join(ROOT, path))) return { ok: false, detail: `missing file ${path}` };
  const result = Bun.spawnSync(
    ['bun', 'test', '--isolate', '--test-name-pattern', name, path],
    { cwd: ROOT },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) return { ok: false, detail: `test exited ${result.exitCode}` };
  if (!output.includes(name)) return { ok: false, detail: `test name never ran: ${name}` };
  const passed = /(\d+)\s+pass/.exec(output);
  if (passed && Number(passed[1]) === 0) return { ok: false, detail: 'zero tests passed' };
  return { ok: true, detail: passed ? `${passed[1]} pass` : 'pass' };
}

function runRipgrep(pattern, target) {
  const result = Bun.spawnSync(['rg', '--no-config', '-n', '--no-messages', '-e', pattern, target], {
    cwd: ROOT,
  });
  if (result.exitCode === 0) return { found: true, detail: result.stdout.toString().trim().split('\n')[0] };
  if (result.exitCode === 1) return { found: false, detail: '' };
  return { found: false, detail: `rg exited ${result.exitCode}` };
}

function runPatternProbe(probe, shouldExist) {
  const kind = shouldExist ? 'grep:' : 'absent:';
  const body = probe.slice(kind.length);
  const separator = body.lastIndexOf('@');
  if (separator === -1) fail(`${kind} probe needs <pattern>@<path>: ${probe}`);
  const pattern = body.slice(0, separator).trim();
  const target = resolveProbeTarget(body.slice(separator + 1).trim());
  const hit = runRipgrep(pattern, target);
  if (!shouldExist) {
    return hit.found
      ? { ok: false, detail: `pattern still present at ${hit.detail}` }
      : { ok: true, detail: 'absent' };
  }
  return hit.found ? { ok: true, detail: hit.detail } : { ok: false, detail: 'pattern not found' };
}

function verify(rows, onlyBatch) {
  const selected = rows.filter((row) => {
    if (onlyBatch && row.cluster !== onlyBatch) return false;
    return PROBE_KINDS.slice(0, 3).some((kind) => row.probe.startsWith(kind));
  });
  if (selected.length === 0) {
    process.stdout.write('verify: no row carries an executable probe\n');
    return;
  }
  const failures = [];
  for (const row of selected) {
    let outcome;
    if (row.probe.startsWith('test:')) outcome = runTestProbe(row.probe);
    else if (row.probe.startsWith('grep:')) outcome = runPatternProbe(row.probe, true);
    else outcome = runPatternProbe(row.probe, false);
    const label = `#${row.pr} ${row.cluster}`;
    if (outcome.ok) {
      row.verdict = row.verdict === 'equivalent' ? 'equivalent' : 'ported';
      row.evidence = outcome.detail || '-';
      row.updated = today();
      process.stdout.write(`PASS ${label} ${outcome.detail}\n`);
    } else {
      failures.push({ label, detail: outcome.detail });
      process.stdout.write(`FAIL ${label} ${outcome.detail}\n`);
    }
  }
  saveLedger(rows);
  process.stdout.write(`verify: ${selected.length - failures.length} pass, ${failures.length} fail\n`);
  if (failures.length > 0) process.exit(1);
}

function report(rows) {
  const counts = new Map();
  const verdicts = new Set();
  for (const row of rows) {
    const key = row.cluster;
    if (!counts.has(key)) counts.set(key, new Map());
    const bucket = counts.get(key);
    bucket.set(row.verdict, (bucket.get(row.verdict) ?? 0) + 1);
    verdicts.add(row.verdict);
  }
  const ordered = [...verdicts];
  const header = ['batch', 'rows', ...ordered, 'closed', 'remaining'];
  process.stdout.write(`${header.join('\t')}\n`);
  let totalRemaining = 0;
  let totalRows = 0;
  for (const batch of [...counts.keys()].sort((a, b) => a.localeCompare(b))) {
    const bucket = counts.get(batch);
    const rowCount = [...bucket.values()].reduce((sum, value) => sum + value, 0);
    const cells = ordered.map((verdict) => String(bucket.get(verdict) ?? 0));
    const closed =
      (bucket.get('ported') ?? 0) +
      (bucket.get('equivalent') ?? 0) +
      (bucket.get('not-applicable') ?? 0);
    const remaining = rowCount - closed;
    totalRows += rowCount;
    totalRemaining += remaining;
    process.stdout.write([batch, String(rowCount), ...cells, String(closed), String(remaining)].join('\t'));
    process.stdout.write('\n');
  }
  process.stdout.write(`total\t${totalRows}\tclosed=${totalRows - totalRemaining}\tremaining=${totalRemaining}\n`);
  if (totalRemaining > 0) process.stdout.write('STATUS: open\n');
  else process.stdout.write('STATUS: clear\n');
}

function setRow(rows, sha, verdict, options) {
  if (!VERDICTS.has(verdict)) fail(`unknown verdict ${verdict}`);
  const row = rows.find((candidate) => candidate.sha === sha || candidate.sha.startsWith(sha));
  if (!row) fail(`no ledger row matches ${sha}`);
  const evidence = options.evidence;
  const approvedBy = options.approvedBy;
  if (verdict === 'pending' || verdict === 'in_progress') {
    if (row.probe !== '-' && PROBE_KINDS.slice(0, 3).some((kind) => row.probe.startsWith(kind))) {
      fail('an executable probe already exists; use --verify instead of --set');
    }
  } else if (row.probe === '-') {
    fail('refusing to close a row that has no probe; set probe first with --probe');
  }
  if (!evidence) fail('--evidence is required');
  if (verdict === 'partial' || verdict === 'blocked') {
    if (!approvedBy) fail(`${verdict} requires --approved-by`);
  }
  if (verdict === 'not-applicable' && !approvedBy) fail('not-applicable requires --approved-by');
  row.verdict = verdict;
  row.evidence = evidence;
  row.approved_by = approvedBy ?? row.approved_by;
  row.updated = today();
  if (verdict === 'not-applicable' || verdict === 'blocked') row.batch_done = 'yes';
  saveLedger(rows);
  process.stdout.write(`set ${row.pr} (${row.cluster}) -> ${verdict}\n`);
}

function setProbe(rows, sha, probe) {
  if (probe !== '-' && !PROBE_KINDS.some((kind) => probe.startsWith(kind))) {
    fail(`probe must start with one of ${PROBE_KINDS.join(' ')} or be -`);
  }
  const row = rows.find((candidate) => candidate.sha === sha || candidate.sha.startsWith(sha));
  if (!row) fail(`no ledger row matches ${sha}`);
  row.probe = probe;
  row.updated = today();
  saveLedger(rows);
  process.stdout.write(`probe ${row.pr} (${row.cluster}) -> ${probe}\n`);
}

function setBatch(rows, batch) {
  const affected = rows.filter((row) => row.cluster === batch);
  if (affected.length === 0) fail(`no rows in ${batch}`);
  const unfinished = affected.filter(
    (row) =>
      row.verdict === 'pending' ||
      row.verdict === 'in_progress' ||
      row.verdict === 'partial',
  );
  if (unfinished.length > 0) fail(`${batch} still has ${unfinished.length} unfinished rows`);
  for (const row of affected) {
    row.batch_done = 'yes';
    row.updated = today();
  }
  saveLedger(rows);
  process.stdout.write(`batch ${batch} marked done (${affected.length} rows)\n`);
}

function setCluster(rows, sha, cluster) {
  if (cluster !== 'unassigned' && !BATCHES.includes(cluster)) {
    fail(`cluster must be one of ${BATCHES.join(' ')} or unassigned`);
  }
  const row = rows.find((candidate) => candidate.sha === sha || candidate.sha.startsWith(sha));
  if (!row) fail(`no ledger row matches ${sha}`);
  row.cluster = cluster;
  row.updated = today();
  saveLedger(rows);
  process.stdout.write(`cluster ${row.pr} -> ${cluster}\n`);
}

function usage() {
  process.stdout.write(
    [
      'usage: bun scripts/upstream-ledger.mjs <command>',
      '',
      '  --refresh                  fetch upstream and add open commits as pending rows',
      '  --verify [--batch B4]      run every executable probe and advance verdicts',
      '  --report                   batch x verdict matrix, plus remaining count',
      '  --set <sha> <verdict> --evidence <text> [--approved-by <who>]',
      '  --probe <sha> <probe>     attach test:/grep:/absent:/manual:/  to a row',
      '  --cluster <sha> <batch>   move a row into B1..B12 or unassigned',
      '  --batch-done <B4>          mark a batch finished once nothing is open in it',
      '',
      `verdicts: ${[...VERDICTS].join(' ')}`,
      `batches: ${BATCHES.join(' ')}`,
    ].join('\n'),
  );
  process.stdout.write('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === '--help') {
    usage();
    return;
  }
  const rows = loadLedger();
  if (command === '--refresh') {
    refresh();
    return;
  }
  if (rows.length === 0 && command !== '--refresh') fail('ledger is empty; run --refresh first');
  if (command === '--report') {
    report(rows);
    return;
  }
  if (command === '--verify') {
    const index = argv.indexOf('--batch');
    verify(rows, index === -1 ? undefined : argv[index + 1]);
    return;
  }
  const readOption = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  if (command === '--set') {
    const sha = argv[1];
    const verdict = argv[2];
    if (!sha || !verdict) fail('--set needs <sha> <verdict>');
    setRow(rows, sha, verdict, {
      evidence: readOption('--evidence'),
      approvedBy: readOption('--approved-by'),
    });
    return;
  }
  if (command === '--probe') {
    const sha = argv[1];
    const probe = argv[2];
    if (!sha || !probe) fail('--probe needs <sha> <probe>');
    setProbe(rows, sha, probe);
    return;
  }
  if (command === '--batch-done') {
    const batch = argv[1];
    if (!batch) fail('--batch-done needs a batch id');
    setBatch(rows, batch);
    return;
  }
  if (command === '--cluster') {
    const sha = argv[1];
    const cluster = argv[2];
    if (!sha || !cluster) fail('--cluster needs <sha> <batch|unassigned>');
    setCluster(rows, sha, cluster);
    return;
  }
  fail(`unknown command ${command}`);
}

main();
