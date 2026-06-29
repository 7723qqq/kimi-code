/**
 * `agentFs` domain (L2) — `IFsService` implementation.
 *
 * Backs the fs REST surface (search / grep / git status / git diff) by
 * orchestrating `IAgentFileSystem` (file IO) and `IProcessRunner` (`rg` /
 * `git` / `gh`). Bound at Session scope — the workspace root and execution
 * environment come from the scope, so no `sessionId` is threaded through.
 *
 * Path confinement is lexical (`IWorkspaceContext.isWithin`); it does not
 * follow symlinks, matching the rest of v2 (`_base/tools/policies/path-access.ts`).
 */

import { isAbsolute, relative, sep } from 'node:path';

import type {
  FsDiffRequest,
  FsDiffResponse,
  FsGitStatusRequest,
  FsGitStatusResponse,
  FsGrepFileHit,
  FsGrepMatch,
  FsGrepRequest,
  FsGrepResponse,
  FsPullRequest,
  FsSearchHit,
  FsSearchRequest,
  FsSearchResponse,
} from '@moonshot-ai/protocol';
import ignore, { type Ignore } from 'ignore';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ErrorCodes, KimiError } from '#/errors';
import { IProcessRunner } from '#/process';
import { IWorkspaceContext } from '#/workspaceContext';

import { IAgentFileSystem } from './agentFs';
import { IFsService } from './fs';
import { parseNumstat, parsePorcelain, parsePullRequest } from './fsGit';
import { runCommand } from './fsProcess';
import {
  compileGrepPattern,
  computeFuzzyScore,
  computeMatchPositions,
  matchesAnyGlob,
  type RgJsonRecord,
  rgPath,
  rgText,
  stripTrailingNewline,
} from './fsSearch';

const SEARCH_HARD_CAP = 500;
const GREP_TIMEOUT_MS = 30_000;
const WALK_MAX_DEPTH = 64;
const DIFF_MAX_BYTES = 1_048_576;
const PR_SPAWN_TIMEOUT_MS = 5_000;
const PULL_REQUEST_TTL_MS = 60_000;

export class FsService implements IFsService {
  declare readonly _serviceBrand: undefined;

  private readonly gitignoreCache = new Map<string, Ignore>();
  private readonly pullRequestCache = new Map<
    string,
    { value: FsPullRequest | null; fetchedAt: number }
  >();
  private rgAvailable: boolean | undefined = undefined;

  constructor(
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IAgentFileSystem private readonly fs: IAgentFileSystem,
    @IProcessRunner private readonly runner: IProcessRunner,
  ) {}

  async search(req: FsSearchRequest): Promise<FsSearchResponse> {
    const matcher = req.follow_gitignore ? await this.matcher() : undefined;
    const candidates: FsSearchHit[] = [];
    const queryLower = req.query.toLowerCase();

    await this.walk('', matcher, async (relPath, name, kind) => {
      const score = computeFuzzyScore(name, queryLower);
      if (score <= 0) return;
      if (req.include_globs && !matchesAnyGlob(relPath, req.include_globs)) {
        return;
      }
      if (req.exclude_globs && matchesAnyGlob(relPath, req.exclude_globs)) {
        return;
      }
      candidates.push({
        path: relPath,
        name,
        kind,
        score,
        match_positions: computeMatchPositions(relPath, queryLower),
      });
    });

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.path.localeCompare(b.path);
    });

    const effectiveCap = Math.min(req.limit, SEARCH_HARD_CAP);
    const truncated = candidates.length > effectiveCap;
    return { items: candidates.slice(0, effectiveCap), truncated };
  }

  async grep(req: FsGrepRequest): Promise<FsGrepResponse> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GREP_TIMEOUT_MS);
    timer.unref?.();
    try {
      if (await this.probeRg()) {
        return await this.grepWithRg(req, controller.signal, startedAt);
      }
      return await this.grepWithNode(req, controller.signal, startedAt);
    } finally {
      clearTimeout(timer);
    }
  }

  async gitStatus(req: FsGitStatusRequest): Promise<FsGitStatusResponse> {
    const cwd = this.workspace.workDir;

    let filterSet: Set<string> | undefined;
    if (req.paths !== undefined && req.paths.length > 0) {
      filterSet = new Set();
      for (const p of req.paths) {
        filterSet.add(this.toRel(this.resolveWithin(p)));
      }
    }

    const inside = await runCommand(
      this.runner,
      ['git', 'rev-parse', '--is-inside-work-tree'],
      { cwd },
    );
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw this.gitUnavailable(cwd, inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`);
    }

    const porc = await runCommand(
      this.runner,
      ['git', 'status', '--porcelain=v1', '--branch'],
      { cwd },
    );
    if (porc.exitCode !== 0) {
      throw this.gitUnavailable(cwd, porc.stderr.trim() || `git status exit ${porc.exitCode}`);
    }

    const result = parsePorcelain(porc.stdout, filterSet);

    const dirty = porc.stdout
      .split('\n')
      .some((line) => line.length > 0 && !line.startsWith('## '));
    if (dirty) {
      const head = await runCommand(
        this.runner,
        ['git', 'rev-parse', '--verify', '--quiet', 'HEAD'],
        { cwd },
      );
      if (head.exitCode === 0) {
        const numstat = await runCommand(
          this.runner,
          ['git', 'diff', '--no-color', '--numstat', 'HEAD', '--'],
          { cwd },
        );
        if (numstat.exitCode === 0) {
          const stats = parseNumstat(numstat.stdout);
          result.additions = stats.additions;
          result.deletions = stats.deletions;
        }
      }
    }

    result.pullRequest = await this.readPullRequest(cwd);
    return result;
  }

  async diff(req: FsDiffRequest): Promise<FsDiffResponse> {
    const cwd = this.workspace.workDir;
    const rel = this.toRel(this.resolveWithin(req.path));

    const inside = await runCommand(
      this.runner,
      ['git', 'rev-parse', '--is-inside-work-tree'],
      { cwd },
    );
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw this.gitUnavailable(cwd, inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`);
    }

    const statusRes = await runCommand(
      this.runner,
      ['git', 'status', '--porcelain=v1', '--', rel],
      { cwd },
    );
    if (statusRes.exitCode !== 0) {
      throw this.gitUnavailable(cwd, statusRes.stderr.trim() || `git status exit ${statusRes.exitCode}`);
    }
    const untracked = statusRes.stdout.startsWith('??');

    const headRes = await runCommand(
      this.runner,
      ['git', 'rev-parse', '--verify', '--quiet', 'HEAD'],
      { cwd },
    );
    const hasHead = headRes.exitCode === 0;

    let diffStdout: string;
    if (untracked || !hasHead) {
      const res = await runCommand(
        this.runner,
        ['git', 'diff', '--no-color', '--no-index', '--', '/dev/null', rel],
        { cwd },
      );
      if (res.exitCode !== 0 && res.exitCode !== 1) {
        throw this.gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      diffStdout = res.stdout;
    } else {
      const res = await runCommand(
        this.runner,
        ['git', 'diff', '--no-color', 'HEAD', '--', rel],
        { cwd },
      );
      if (res.exitCode !== 0) {
        throw this.gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      if (res.stdout.length === 0 && statusRes.stdout.length === 0) {
        const exists = await this.fs.stat(rel).then(
          () => true,
          () => false,
        );
        if (!exists) {
          throw new KimiError(ErrorCodes.FS_PATH_NOT_FOUND, `path not found: ${req.path}`, {
            details: { path: req.path },
          });
        }
      }
      diffStdout = res.stdout;
    }

    const truncated = diffStdout.length > DIFF_MAX_BYTES;
    return {
      path: rel,
      diff: truncated ? diffStdout.slice(0, DIFF_MAX_BYTES) : diffStdout,
      truncated,
    };
  }

  private async readPullRequest(cwd: string): Promise<FsPullRequest | null> {
    const cached = this.pullRequestCache.get(cwd);
    const now = Date.now();
    if (cached !== undefined && now - cached.fetchedAt < PULL_REQUEST_TTL_MS) {
      return cached.value;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PR_SPAWN_TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await runCommand(
        this.runner,
        ['gh', 'pr', 'view', '--json', 'number,url,state'],
        {
          cwd,
          env: { GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' },
          signal: controller.signal,
        },
      );
      const value = res.exitCode === 0 ? parsePullRequest(res.stdout) : null;
      this.pullRequestCache.set(cwd, { value, fetchedAt: now });
      return value;
    } finally {
      clearTimeout(timer);
    }
  }

  private async grepWithRg(
    req: FsGrepRequest,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<FsGrepResponse> {
    const args = ['--json'];
    if (req.context_lines > 0) {
      args.push('--context', String(req.context_lines));
    }
    if (!req.case_sensitive) args.push('--ignore-case');
    if (!req.regex) args.push('--fixed-strings');
    if (req.follow_gitignore) {
      args.push('--no-require-git');
    } else {
      args.push('--no-ignore');
    }
    if (req.include_globs) {
      for (const g of req.include_globs) args.push('--glob', g);
    }
    if (req.exclude_globs) {
      for (const g of req.exclude_globs) args.push('--glob', `!${g}`);
    }
    args.push('--max-count', String(req.max_matches_per_file));
    args.push(req.pattern);
    args.push('.');

    const res = await runCommand(this.runner, ['rg', ...args], {
      cwd: this.workspace.workDir,
      signal,
    });

    return parseRgJsonOutput(res.stdout, req, signal.aborted, Date.now() - startedAt);
  }

  private async grepWithNode(
    req: FsGrepRequest,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<FsGrepResponse> {
    const matcher = req.follow_gitignore ? await this.matcher() : undefined;
    const re = compileGrepPattern(req);

    const files: FsGrepFileHit[] = [];
    let filesScanned = 0;
    let totalMatches = 0;
    let truncated = false;

    const filePaths: string[] = [];
    await this.walk('', matcher, async (rel, _name, kind) => {
      if (kind !== 'file') return;
      if (req.include_globs && !matchesAnyGlob(rel, req.include_globs)) return;
      if (req.exclude_globs && matchesAnyGlob(rel, req.exclude_globs)) return;
      filePaths.push(rel);
    });

    for (const rel of filePaths) {
      if (signal.aborted) {
        if (totalMatches === 0 && filesScanned === 0) {
          throw new KimiError(ErrorCodes.FS_GREP_TIMEOUT, `grep timed out after ${Date.now() - startedAt}ms`);
        }
        truncated = true;
        break;
      }
      if (filesScanned >= req.max_files) {
        truncated = true;
        break;
      }
      filesScanned += 1;
      let content: string;
      try {
        content = await this.fs.readText(rel);
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      const matches: FsGrepMatch[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        re.lastIndex = 0;
        const m = re.exec(line);
        if (m === null) continue;
        if (matches.length >= req.max_matches_per_file) break;
        const before: string[] = [];
        for (let k = Math.max(0, i - req.context_lines); k < i; k++) {
          before.push(lines[k] ?? '');
        }
        const after: string[] = [];
        for (let k = i + 1; k < Math.min(lines.length, i + 1 + req.context_lines); k++) {
          after.push(lines[k] ?? '');
        }
        matches.push({ line: i + 1, col: m.index + 1, text: line, before, after });
        totalMatches += 1;
        if (totalMatches >= req.max_total_matches) {
          truncated = true;
          break;
        }
      }
      if (matches.length > 0) {
        files.push({ path: rel, matches });
      }
      if (totalMatches >= req.max_total_matches) break;
    }

    return { files, files_scanned: filesScanned, truncated, elapsed_ms: Date.now() - startedAt };
  }

  private async walk(
    rootRel: string,
    matcher: Ignore | undefined,
    visit: (
      relPath: string,
      name: string,
      kind: 'file' | 'directory' | 'symlink',
    ) => Promise<void>,
    depth = 0,
  ): Promise<void> {
    if (depth > WALK_MAX_DEPTH) return;
    let names: readonly string[];
    try {
      names = await this.fs.readdir(rootRel === '' ? '.' : rootRel);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === '.git') continue;
      const childRel = rootRel === '' ? name : `${rootRel}/${name}`;
      const st = await this.fs.stat(childRel).catch(() => undefined);
      if (st === undefined) continue;
      const isDir = st.isDirectory;
      if (matcher) {
        const probe = isDir ? `${childRel}/` : childRel;
        if (matcher.ignores(probe)) continue;
      }
      const kind: 'file' | 'directory' | 'symlink' = isDir ? 'directory' : 'file';
      await visit(childRel, name, kind);
      if (isDir) {
        await this.walk(childRel, matcher, visit, depth + 1);
      }
    }
  }

  private async matcher(): Promise<Ignore | undefined> {
    const cwd = this.workspace.workDir;
    const cached = this.gitignoreCache.get(cwd);
    if (cached !== undefined) return cached;
    const ig = ignore();
    ig.add('.git/');
    try {
      const contents = await this.fs.readText('.gitignore');
      ig.add(contents);
    } catch {
      // No .gitignore — keep the `.git/` default only.
    }
    this.gitignoreCache.set(cwd, ig);
    return ig;
  }

  private async probeRg(): Promise<boolean> {
    if (this.rgAvailable !== undefined) return this.rgAvailable;
    const res = await runCommand(this.runner, ['rg', '--version'], {
      cwd: this.workspace.workDir,
    });
    this.rgAvailable = res.exitCode === 0;
    return this.rgAvailable;
  }

  private resolveWithin(inputPath: string): string {
    if (inputPath === '' || inputPath === '/') {
      throw new KimiError(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" rejected (empty)`, {
        details: { path: inputPath, reason: 'empty' },
      });
    }
    if (isAbsolute(inputPath)) {
      throw new KimiError(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" rejected (absolute)`, {
        details: { path: inputPath, reason: 'absolute' },
      });
    }
    const segments = inputPath.split(/[/\\]+/);
    if (segments.some((s) => s === '..')) {
      throw new KimiError(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" rejected (dotdot segment)`, {
        details: { path: inputPath, reason: 'dotdot_segment' },
      });
    }
    const abs = this.workspace.resolve(inputPath);
    if (!this.workspace.isWithin(abs)) {
      throw new KimiError(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" escapes workspace`, {
        details: { path: inputPath, reason: 'resolved_outside' },
      });
    }
    return abs;
  }

  private toRel(abs: string): string {
    const cwd = this.workspace.workDir;
    if (abs === cwd) return '.';
    const rel = relative(cwd, abs);
    if (rel === '') return '.';
    return rel.split(sep).join('/');
  }

  private gitUnavailable(cwd: string, detail: string): KimiError {
    return new KimiError(ErrorCodes.FS_GIT_UNAVAILABLE, `git unavailable at ${cwd}: ${detail}`, {
      details: { cwd, detail },
    });
  }
}

function parseRgJsonOutput(
  stdout: string,
  req: FsGrepRequest,
  aborted: boolean,
  elapsedMs: number,
): FsGrepResponse {
  const fileBuf = new Map<
    string,
    { matches: FsGrepMatch[]; pending: string[]; lastMatchLine: number }
  >();
  const files: FsGrepFileHit[] = [];
  let totalMatches = 0;
  let truncated = false;
  let filesScanned = 0;

  const finalize = (p: string): void => {
    const buf = fileBuf.get(p);
    if (buf === undefined) return;
    if (buf.matches.length > 0 && buf.pending.length > 0) {
      const last = buf.matches[buf.matches.length - 1]!;
      last.after = buf.pending.slice(0, req.context_lines);
    }
    if (buf.matches.length > 0) {
      files.push({ path: p, matches: buf.matches });
    }
    fileBuf.delete(p);
  };

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    let rec: RgJsonRecord;
    try {
      rec = JSON.parse(line) as RgJsonRecord;
    } catch {
      continue;
    }
    const t = rec.type;
    if (t === 'begin') {
      const p = rgPath(rec.data?.path);
      if (p === undefined) continue;
      if (filesScanned >= req.max_files) {
        truncated = true;
        continue;
      }
      fileBuf.set(p, { matches: [], pending: [], lastMatchLine: -1 });
      filesScanned += 1;
    } else if (t === 'context') {
      const p = rgPath(rec.data?.path);
      if (p === undefined) continue;
      const buf = fileBuf.get(p);
      if (buf === undefined) continue;
      buf.pending.push(stripTrailingNewline(rgText(rec.data?.lines)));
      if (buf.pending.length > req.context_lines * 2) {
        buf.pending.shift();
      }
    } else if (t === 'match') {
      const p = rgPath(rec.data?.path);
      if (p === undefined) continue;
      const buf = fileBuf.get(p);
      if (buf === undefined) continue;
      if (totalMatches >= req.max_total_matches) {
        truncated = true;
        continue;
      }
      if (buf.matches.length >= req.max_matches_per_file) continue;
      const text = stripTrailingNewline(rgText(rec.data?.lines));
      const lineNo = rec.data?.line_number ?? 0;
      const col = (rec.data?.submatches?.[0]?.start ?? 0) + 1;
      const before = buf.pending.slice(-req.context_lines);
      buf.pending.length = 0;
      buf.matches.push({ line: lineNo, col, text, before, after: [] });
      buf.lastMatchLine = lineNo;
      totalMatches += 1;
      if (totalMatches >= req.max_total_matches) truncated = true;
    } else if (t === 'end') {
      const p = rgPath(rec.data?.path);
      if (p === undefined) continue;
      finalize(p);
    }
  }

  for (const p of [...fileBuf.keys()]) {
    finalize(p);
  }

  if (aborted) {
    if (totalMatches === 0 && filesScanned === 0) {
      throw new KimiError(ErrorCodes.FS_GREP_TIMEOUT, `grep timed out after ${elapsedMs}ms`);
    }
    truncated = true;
  }

  return { files, files_scanned: filesScanned, truncated, elapsed_ms: elapsedMs };
}

registerScopedService(
  LifecycleScope.Session,
  IFsService,
  FsService,
  InstantiationType.Delayed,
  'agentFs',
);
