#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ZERO = '0'.repeat(40);
const DEFAULT_BASELINE = '.upstream/drift-baseline.json';
const DEFAULT_PATHS = '.upstream/drift-paths.json';

export type PathKind = 'source' | 'platform' | 'test' | 'fork-only' | 'empty';
export type CommitStatus =
  | 'equivalent'
  | 'present'
  | 'missing'
  | 'partial'
  | 'adapted'
  | 'platform-present'
  | 'platform-missing'
  | 'platform-adapted'
  | 'test-present'
  | 'test-missing'
  | 'test-adapted'
  | 'empty';

export interface RawChange {
  readonly status: string;
  readonly oldSha: string;
  readonly newSha: string;
  readonly oldPath: string;
  readonly newPath: string;
}

export interface PathConfig {
  readonly platform: readonly string[];
  readonly tests: readonly string[];
  readonly forkOnly: readonly string[];
}

export interface LedgerRow {
  readonly pr: string;
  readonly sha: string;
  readonly title: string;
  readonly cluster: string;
  readonly verdict: string;
  readonly probe: string;
  readonly evidence: string;
  readonly batch_done: string;
  readonly approved_by: string;
  readonly updated: string;
  readonly files: string;
}

export interface CommitAnalysis {
  readonly sha: string;
  readonly subject: string;
  readonly kind: PathKind;
  readonly status: string;
  readonly evidence: string;
  readonly files: number;
  readonly changes: readonly RawChange[];
  readonly ledger?: LedgerRow;
  readonly staleLedger: boolean;
  readonly readyToClose: boolean;
}

export interface AnalysisOptions {
  readonly cwd: string;
  readonly upstream: string;
  readonly base: string;
  readonly pathsPath?: string;
  readonly ledgerPath?: string;
  readonly fast?: boolean;
}

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function git(cwd: string, args: readonly string[], stdin?: Uint8Array, env?: Record<string, string | undefined>): GitResult {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdin,
    env: env === undefined ? undefined : { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function mustGit(cwd: string, args: readonly string[], stdin?: Uint8Array, env?: Record<string, string | undefined>): string {
  const result = git(cwd, args, stdin, env);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function normalizePath(path: string): string {
  return path.split('\\').join('/');
}

function subjectKey(subject: string): string {
  return subject.replace(/\s*\(#\d+\)\s*$/, '').trim();
}

function parseRawDiff(output: string): RawChange[] {
  const changes: RawChange[] = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith(':')) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const meta = line.slice(1, tab).split(' ');
    const status = meta[4] ?? '';
    const oldSha = meta[2] ?? ZERO;
    const newSha = meta[3] ?? ZERO;
    const paths = line.slice(tab + 1).split('\t');
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = paths[0];
      const newPath = paths[1];
      if (oldPath === undefined || newPath === undefined) continue;
      changes.push({ status, oldSha, newSha, oldPath: normalizePath(oldPath), newPath: normalizePath(newPath) });
    } else {
      const path = paths[0];
      if (path === undefined) continue;
      changes.push({ status, oldSha, newSha, oldPath: normalizePath(path), newPath: normalizePath(path) });
    }
  }
  return changes;
}

export function loadPathConfig(cwd: string, path = DEFAULT_PATHS): PathConfig {
  const absolute = resolve(cwd, path);
  if (!existsSync(absolute)) {
    return {
      platform: [],
      tests: [],
      forkOnly: [],
    };
  }
  const parsed = JSON.parse(readFileSync(absolute, 'utf8')) as Partial<PathConfig>;
  return {
    platform: parsed.platform ?? [],
    tests: parsed.tests ?? [],
    forkOnly: parsed.forkOnly ?? [],
  };
}

function compile(patterns: readonly string[]): (path: string) => boolean {
  const globs = patterns.map((pattern) => new Bun.Glob(pattern));
  return (path) => globs.some((glob) => glob.match(path));
}

export function classifyPaths(changes: readonly RawChange[], config: PathConfig): PathKind {
  const paths: string[] = [];
  for (const change of changes) {
    if (change.newSha !== ZERO) paths.push(change.newPath);
    else if (change.oldSha !== ZERO) paths.push(change.oldPath);
    if (change.oldPath !== change.newPath) paths.push(change.oldPath);
  }
  if (paths.length === 0) return 'empty';
  const platform = compile(config.platform);
  const tests = compile(config.tests);
  const forkOnly = compile(config.forkOnly);
  if (paths.every((path) => platform(path))) return 'platform';
  if (paths.every((path) => tests(path))) return 'test';
  if (paths.every((path) => forkOnly(path))) return 'fork-only';
  return 'source';
}

export function loadLedger(cwd: string, path = '.upstream/ledger.tsv'): Map<string, LedgerRow> {
  const absolute = resolve(cwd, path);
  const rows = new Map<string, LedgerRow>();
  if (!existsSync(absolute)) return rows;
  const lines = readFileSync(absolute, 'utf8').split('\n').filter((line) => line.length > 0);
  if (lines.length < 2) return rows;
  const header = lines[0].split('\t');
  for (const line of lines.slice(1)) {
    const fields = line.split('\t');
    if (fields.length !== header.length) continue;
    const row = Object.fromEntries(header.map((column, index) => [column, fields[index]])) as unknown as LedgerRow;
    rows.set(row.sha, row);
  }
  return rows;
}

function listCommits(cwd: string, range: string): Array<{ sha: string; subject: string }> {
  const output = mustGit(cwd, ['log', '--no-merges', '--reverse', '--format=%H%x1f%s', range]);
  return output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, subject] = line.split('\u001F');
      return { sha: sha ?? '', subject: subject ?? '' };
    });
}

function diffFor(cwd: string, sha: string): string {
  return mustGit(cwd, ['diff-tree', '-p', '--no-commit-id', '--binary', '--root', '-M', sha]);
}

function rawChanges(cwd: string, sha: string): RawChange[] {
  return parseRawDiff(mustGit(cwd, ['diff-tree', '-r', '--no-commit-id', '--raw', '--root', '-M', sha]));
}

function diffBundle(cwd: string, sha: string): { patch: string; changes: RawChange[] } {
  const output = mustGit(cwd, ['diff-tree', '-p', '--raw', '--no-commit-id', '--binary', '--root', '-M', sha]);
  const lines = output.split('\n');
  const raw: string[] = [];
  let patchStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith('diff --git ')) {
      patchStart = index;
      break;
    }
    raw.push(lines[index]);
  }
  return {
    patch: patchStart === -1 ? '' : lines.slice(patchStart).join('\n'),
    changes: parseRawDiff(raw.join('\n')),
  };
}

function patchIdFromDiff(cwd: string, diff: string): string {
  if (diff.trim().length === 0) return '';
  const result = git(cwd, ['patch-id', '--stable'], new TextEncoder().encode(diff));
  if (result.code !== 0) return '';
  return result.stdout.trim().split(/\s+/)[0] ?? '';
}

function patchIdOf(cwd: string, sha: string): string {
  return patchIdFromDiff(cwd, diffFor(cwd, sha));
}



function subjectIndex(cwd: string, base: string): Map<string, Array<{ sha: string; patchId?: string }>> {
  const index = new Map<string, Array<{ sha: string; patchId?: string }>>();
  for (const commit of listCommits(cwd, `${base}..HEAD`)) {
    const key = subjectKey(commit.subject);
    const bucket = index.get(key) ?? [];
    bucket.push({ sha: commit.sha });
    index.set(key, bucket);
  }
  return index;
}

function forkTree(cwd: string): Map<string, string> {
  const output = mustGit(cwd, ['ls-tree', '-r', 'HEAD']);
  const tree = new Map<string, string>();
  for (const line of output.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const meta = line.slice(0, tab).split(' ');
    if (meta[1] === 'blob' && meta[2] !== undefined) tree.set(normalizePath(line.slice(tab + 1)), meta[2]);
  }
  return tree;
}

function blobSet(tree: ReadonlyMap<string, string>): Set<string> {
  return new Set(tree.values());
}

function applyCheck(
  cwd: string,
  patch: string,
  reverse: boolean,
  indexPath: string,
  patchPath: string,
): number {
  writeFileSync(patchPath, patch, 'utf8');
  const args = ['apply', '--check', '--cached', '--whitespace=nowarn'];
  if (reverse) args.push('--reverse');
  args.push(patchPath);
  const result = git(cwd, args, undefined, { GIT_INDEX_FILE: indexPath });
  return result.code;
}

function blobEvidence(
  changes: readonly RawChange[],
  tree: ReadonlyMap<string, string>,
  blobs: ReadonlySet<string>,
): { present: number; missing: number; adapted: number } {
  let present = 0;
  let missing = 0;
  let adapted = 0;
  for (const change of changes) {
    if (change.status.startsWith('A')) {
      if (blobs.has(change.newSha)) present += 1;
      else if (tree.has(change.newPath)) adapted += 1;
      else missing += 1;
      continue;
    }
    if (change.status.startsWith('D')) {
      if (!tree.has(change.oldPath)) present += 1;
      else if (blobs.has(change.oldSha)) missing += 1;
      else adapted += 1;
      continue;
    }
    if (change.status.startsWith('R')) {
      if (tree.get(change.newPath) === change.newSha) present += 1;
      else if (tree.get(change.oldPath) === change.oldSha && !tree.has(change.newPath)) missing += 1;
      else adapted += 1;
      continue;
    }
    if (blobs.has(change.newSha)) present += 1;
    else if (tree.has(change.newPath) && tree.get(change.newPath) !== change.oldSha) adapted += 1;
    else if (blobs.has(change.oldSha)) missing += 1;
    else adapted += 1;
  }
  return { present, missing, adapted };
}

function statusFromBlobs(
  counts: { present: number; missing: number; adapted: number },
  kind: PathKind,
): CommitStatus {
  const prefix =
    kind === 'platform' ? 'platform-' : kind === 'test' ? 'test-' : '';
  if (counts.adapted > 0 && counts.present === 0 && counts.missing === 0) {
    return `${prefix}adapted` as CommitStatus;
  }
  if (counts.present > 0 && counts.missing === 0 && counts.adapted === 0) {
    return `${prefix}present` as CommitStatus;
  }
  if (counts.missing > 0 && counts.present === 0 && counts.adapted === 0) {
    return `${prefix}missing` as CommitStatus;
  }
  if (counts.missing > 0 && counts.present > 0) return 'partial';
  if (counts.adapted > 0) return `${prefix}adapted` as CommitStatus;
  return `${prefix}present` as CommitStatus;
}

export function analyzeCommit(
  options: AnalysisOptions,
  commit: { sha: string; subject: string },
  context: {
    readonly indexPath: string;
    readonly patchPath: string;
    readonly tree: ReadonlyMap<string, string>;
    readonly blobs: ReadonlySet<string>;
    readonly subjects: Map<string, Array<{ sha: string; patchId?: string }>>;
    readonly config: PathConfig;
    readonly ledger: Map<string, LedgerRow>;
  },
): CommitAnalysis {
  const { cwd } = options;
  const candidates = context.subjects.get(subjectKey(commit.subject)) ?? [];
  const bundle = options.fast === true && candidates.length === 0
    ? { patch: '', changes: rawChanges(cwd, commit.sha) }
    : diffBundle(cwd, commit.sha);
  const { patch, changes } = bundle;
  const kind = classifyPaths(changes, context.config);
  if (kind === 'empty') {
    return {
      sha: commit.sha,
      subject: commit.subject,
      kind,
      status: 'empty',
      evidence: 'no changes',
      files: 0,
      changes,
      staleLedger: false,
      readyToClose: false,
    };
  }

  const ledger = context.ledger.get(commit.sha);
  if (candidates.length > 0) {
    const patchId = patchIdFromDiff(cwd, patch === '' ? diffFor(cwd, commit.sha) : patch);
    if (patchId !== '') {
      for (const candidate of candidates) {
        const candidateId = candidate.patchId ?? patchIdOf(cwd, candidate.sha);
        candidate.patchId = candidateId;
        if (candidateId !== '' && candidateId === patchId) {
          return {
            sha: commit.sha,
            subject: commit.subject,
            kind,
            status: kind === 'source' ? 'equivalent' : `${kind}-present`,
            evidence: `patch-id ${candidate.sha}`,
            files: changes.length,
            changes,
            ledger,
            staleLedger: false,
            readyToClose: ledger?.verdict === 'pending' || ledger?.verdict === 'in_progress',
          };
        }
      }
    }
  }
  const blobCounts = blobEvidence(changes, context.tree, context.blobs);
  let status: string;
  let evidence: string;
  if (options.fast === true) {
    status = statusFromBlobs(blobCounts, kind);
    evidence = `fast blob present=${blobCounts.present} missing=${blobCounts.missing} adapted=${blobCounts.adapted}`;
  } else {
    const reverse = applyCheck(cwd, patch, true, context.indexPath, context.patchPath);
    const forward = applyCheck(cwd, patch, false, context.indexPath, context.patchPath);
    if (reverse === 0) {
      status = kind === 'source' ? 'present' : `${kind}-present`;
      evidence = 'reverse apply';
    } else if (forward === 0) {
      status = kind === 'source' ? 'missing' : `${kind}-missing`;
      evidence = 'forward apply';
    } else {
      status = statusFromBlobs(blobCounts, kind);
      evidence = `blob present=${blobCounts.present} missing=${blobCounts.missing} adapted=${blobCounts.adapted}`;
      if (reverse > 1 || forward > 1) {
        evidence += ` apply-error reverse=${reverse} forward=${forward}`;
      }
    }
  }
  const staleLedger =
    (ledger?.verdict === 'ported' || ledger?.verdict === 'equivalent') && status === 'missing';
  const readyToClose =
    (ledger?.verdict === 'pending' || ledger?.verdict === 'in_progress') &&
    (status === 'present' || status === 'equivalent');
  return {
    sha: commit.sha,
    subject: commit.subject,
    kind,
    status,
    evidence,
    files: changes.length,
    changes,
    ledger,
    staleLedger,
    readyToClose,
  };
}

export function analyzeUpstream(options: AnalysisOptions): {
  readonly upstream: string;
  readonly base: string;
  readonly fork: string;
  readonly fast: boolean;
  readonly analyses: CommitAnalysis[];
} {
  const { cwd } = options;
  const upstream = options.upstream;
  const base = options.base;
  const tempDir = mkdtempSync(join(tmpdir(), 'upstream-drift-index-'));
  const indexPath = join(tempDir, 'index');
  try {
    mustGit(cwd, ['read-tree', 'HEAD'], undefined, { GIT_INDEX_FILE: indexPath });
    const config = loadPathConfig(cwd, options.pathsPath);
    const ledger = loadLedger(cwd, options.ledgerPath);
    const tree = forkTree(cwd);
    const blobs = blobSet(tree);
    const subjects = subjectIndex(cwd, base);
    const commits = listCommits(cwd, `${base}..${upstream}`);
    const patchPath = join(tempDir, 'change.patch');
    const analyses = commits.map((commit) =>
      analyzeCommit(options, commit, { indexPath, patchPath, tree, blobs, subjects, config, ledger }),
    );
    return {
      upstream,
      base,
      fork: mustGit(cwd, ['rev-parse', '--short=10', 'HEAD']).trim(),
      fast: options.fast === true,
      analyses,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function isSourceMissing(analysis: CommitAnalysis): boolean {
  return analysis.kind === 'source' && analysis.status === 'missing';
}



export function summarize(analyses: readonly CommitAnalysis[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const analysis of analyses) {
    counts[analysis.status] = (counts[analysis.status] ?? 0) + 1;
  }
  return counts;
}

export function formatReport(result: {
  upstream: string;
  base: string;
  fork: string;
  fast: boolean;
  analyses: readonly CommitAnalysis[];
}): string {
  const lines: string[] = [];
  const counts = summarize(result.analyses);
  lines.push(`upstream ${result.upstream}  base ${result.base}  fork ${result.fork}  mode ${result.fast ? 'fast' : 'full'}`);
  lines.push(`commits ${result.analyses.length}`);
  lines.push(
    Object.entries(counts)
      .toSorted((a, b) => b[1] - a[1])
      .map(([status, count]) => `${status}=${count}`)
      .join(' '),
  );
  const missing = result.analyses.filter(isSourceMissing);
  const partial = result.analyses.filter(
    (analysis) => analysis.kind === 'source' && analysis.status === 'partial',
  );
  const adapted = result.analyses.filter(
    (analysis) => analysis.kind === 'source' && analysis.status === 'adapted',
  );
  lines.push(
    `source-missing ${missing.length}  source-partial ${partial.length}  source-adapted ${adapted.length}`,
  );
  for (const analysis of missing.slice(0, 40)) {
    lines.push(`  missing  ${analysis.sha.slice(0, 12)}  ${analysis.subject}`);
  }
  for (const analysis of partial.slice(0, 20)) {
    lines.push(`  partial  ${analysis.sha.slice(0, 12)}  ${analysis.subject}`);
  }
  for (const analysis of adapted.slice(0, 20)) {
    lines.push(`  adapted  ${analysis.sha.slice(0, 12)}  ${analysis.subject}`);
  }
  const stale = result.analyses.filter((analysis) => analysis.staleLedger);
  if (stale.length > 0) {
    lines.push(`stale-ledger ${stale.length}`);
    for (const analysis of stale.slice(0, 20)) {
      lines.push(`  ${analysis.sha.slice(0, 12)}  ${analysis.ledger?.verdict} -> ${analysis.status}  ${analysis.subject}`);
    }
  }
  const ready = result.analyses.filter((analysis) => analysis.readyToClose);
  if (ready.length > 0) lines.push(`ready-to-close ${ready.length}`);
  return lines.join('\n');
}

export interface Baseline {
  readonly version: 1;
  readonly createdAt: string;
  readonly upstream: string;
  readonly base: string;
  readonly fork: string;
  readonly mode: 'fast' | 'full';
  readonly counts: Record<string, number>;
  readonly commits: Record<string, {
    readonly subject: string;
    readonly status: string;
    readonly kind: string;
    readonly evidence: string;
    readonly ledger?: string;
  }>;
}

export function buildBaseline(result: {
  upstream: string;
  base: string;
  fork: string;
  fast: boolean;
  analyses: readonly CommitAnalysis[];
}): Baseline {
  const commits: Baseline['commits'] = {};
  for (const analysis of result.analyses) {
    commits[analysis.sha] = {
      subject: analysis.subject,
      status: analysis.status,
      kind: analysis.kind,
      evidence: analysis.evidence,
      ledger: analysis.ledger?.verdict,
    };
  }
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    upstream: result.upstream,
    base: result.base,
    fork: result.fork,
    mode: result.fast ? 'fast' : 'full',
    counts: summarize(result.analyses),
    commits,
  };
}

export interface BaselineComparison {
  readonly added: readonly string[];
  readonly changed: ReadonlyArray<{ sha: string; from: string; to: string }>;
  readonly removed: readonly string[];
  readonly stale: readonly string[];
}

export function compareBaseline(
  baseline: Baseline,
  result: { analyses: readonly CommitAnalysis[] },
): BaselineComparison {
  const current = new Map(result.analyses.map((analysis) => [analysis.sha, analysis]));
  const added: string[] = [];
  const changed: Array<{ sha: string; from: string; to: string }> = [];
  for (const analysis of result.analyses) {
    const previous = baseline.commits[analysis.sha];
    if (previous === undefined) added.push(analysis.sha);
    else if (previous.status !== analysis.status) {
      changed.push({ sha: analysis.sha, from: previous.status, to: analysis.status });
    }
  }
  const removed = Object.keys(baseline.commits).filter((sha) => !current.has(sha));
  const stale = result.analyses.filter((analysis) => analysis.staleLedger).map((analysis) => analysis.sha);
  return { added, changed, removed, stale };
}

function resolveBase(cwd: string, upstream: string): string {
  return mustGit(cwd, ['merge-base', 'HEAD', upstream]).trim();
}

function parseArgs(argv: readonly string[]): {
  command: string;
  cwd: string;
  upstream: string;
  base?: string;
  json: boolean;
  check: boolean;
  fast: boolean;
  explain?: string;
  baseline: string;
  pathsPath?: string;
  ledgerPath?: string;
} {
  const cwd = resolve(import.meta.dirname, '..');
  let command = '--analyze';
  let upstream = 'upstream/main';
  let base: string | undefined;
  let json = false;
  let check = false;
  let fast = false;
  let explain: string | undefined;
  let baseline = DEFAULT_BASELINE;
  let pathsPath: string | undefined;
  let ledgerPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--analyze' || arg === '--baseline' || arg === '--report') command = arg;
    else if (arg === '--json') json = true;
    else if (arg === '--check') check = true;
    else if (arg === '--fast') fast = true;
    else if (arg === '--upstream') upstream = argv[++index] ?? upstream;
    else if (arg === '--base') base = argv[++index];
    else if (arg === '--baseline-file') baseline = argv[++index] ?? baseline;
    else if (arg === '--paths') pathsPath = argv[++index];
    else if (arg === '--ledger') ledgerPath = argv[++index];
    else if (arg === '--explain') {
      command = '--explain';
      explain = argv[++index];
    }
  }
  return { command, cwd, upstream, base, json, check, fast, explain, baseline, pathsPath, ledgerPath };
}

function usage(): void {
  process.stdout.write(
    [
      'usage: bun scripts/upstream-drift.ts <command>',
      '',
      '  --analyze                     classify every upstream commit (default)',
      '  --baseline [--baseline-file]  write the baseline snapshot',
      '  --report [--baseline-file]    compare the current tree with the baseline',
      '  --explain <sha>               print one commit analysis',
      '',
      'options: --upstream <rev> --base <rev> --paths <file> --ledger <file> --json --check --fast',
    ].join('\n'),
  );
  process.stdout.write('\n');
}

function main(): void {
  if (process.argv.includes('--help')) {
    usage();
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const base = args.base ?? resolveBase(args.cwd, args.upstream);
  const result = analyzeUpstream({
    cwd: args.cwd,
    upstream: args.upstream,
    base,
    pathsPath: args.pathsPath,
    ledgerPath: args.ledgerPath,
    fast: args.fast,
  });
  if (args.command === '--explain') {
    const analysis = result.analyses.find((candidate) => candidate.sha.startsWith(args.explain ?? ''));
    if (analysis === undefined) {
      process.stderr.write(`no upstream commit matches ${args.explain ?? ''}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
    return;
  }
  if (args.command === '--baseline') {
    const baseline = buildBaseline(result);
    writeFileSync(resolve(args.cwd, args.baseline), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    process.stdout.write(`${formatReport(result)}\n`);
    process.stdout.write(`baseline ${args.baseline}\n`);
    return;
  }
  if (args.command === '--report') {
    const baselinePath = resolve(args.cwd, args.baseline);
    if (!existsSync(baselinePath)) {
      process.stderr.write(`baseline ${args.baseline} is missing; run --baseline first\n`);
      process.exit(1);
    }
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
    const comparison = compareBaseline(baseline, result);
    process.stdout.write(`${formatReport(result)}\n`);
    process.stdout.write(`new ${comparison.added.length} changed ${comparison.changed.length} removed ${comparison.removed.length} stale ${comparison.stale.length}\n`);
    for (const sha of comparison.added.slice(0, 20)) process.stdout.write(`  new ${sha.slice(0, 12)}\n`);
    for (const change of comparison.changed.slice(0, 20)) {
      process.stdout.write(`  changed ${change.sha.slice(0, 12)} ${change.from} -> ${change.to}\n`);
    }
    if (args.check && (result.analyses.some(isSourceMissing) || comparison.stale.length > 0)) {
      process.exit(1);
    }
    return;
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ...result, counts: summarize(result.analyses) }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
  }
  if (args.check && result.analyses.some(isSourceMissing)) process.exit(1);
}

if (import.meta.main) main();
