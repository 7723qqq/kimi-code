import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';

import { dirname, join, resolve } from 'pathe';

import {
  operationGitHeadsEqual,
  operationRefsEqual,
  operationViewsEqual,
  OperationLogError,
  type OperationGitHead,
  type OperationView,
} from './operationLog';

interface RepositoryViewServiceOptions {
  readonly repoRoot: string;
  readonly storageRoot?: string;
}

export interface RepositoryFile {
  readonly hash: string;
  readonly size: number;
}

export interface RepositoryFileQuery {
  readonly view: OperationView;
  readonly path: string;
}

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface GitRunOptions {
  readonly shadowIndex?: boolean;
  readonly input?: string;
  readonly allowedExitCodes?: readonly number[];
}

type RefResolution =
  | { readonly kind: 'resolved'; readonly target: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' };

const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OBJECT_LINE_PATTERN = /^([0-9a-f]{40}|[0-9a-f]{64}) (blob|tree|commit|tag) (\d+)$/;
const MAX_SYMREF_DEPTH = 8;
const FILE_CACHE_MAX_ENTRIES = 50_000;
const BLOB_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const BLOB_CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const FORBIDDEN_REF_CHARACTERS = new Set([' ', '~', '^', ':', '?', '*', '[', '\\']);

function isValidRefName(ref: string): boolean {
  if (!ref.startsWith('refs/') || ref.endsWith('/') || ref.endsWith('.')) return false;
  if (ref.includes('//') || ref.includes('..') || ref.includes('@{')) return false;
  for (const character of ref) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || FORBIDDEN_REF_CHARACTERS.has(character)) return false;
  }
  for (const component of ref.split('/')) {
    if (component === '' || component.startsWith('.') || component.endsWith('.lock')) return false;
  }
  return true;
}

function compareRefNames(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function resolveRefChain(refs: ReadonlyMap<string, string>, name: string): string | undefined {
  let current = name;
  for (let depth = 0; depth < MAX_SYMREF_DEPTH; depth += 1) {
    const value = refs.get(current);
    if (value === undefined) return undefined;
    if (!value.startsWith('ref: ')) return OBJECT_ID_PATTERN.test(value) ? value : undefined;
    current = value.slice(5).trim();
  }
  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return false;
    throw error;
  }
}

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'EISDIR') return undefined;
    throw error;
  }
}

async function readDirectoryIdentity(directory: string): Promise<string | undefined> {
  try {
    const info = await stat(directory);
    return `${String(info.dev)}:${String(info.ino)}`;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GitOperationError extends Error {
  override readonly name = 'GitOperationError';

  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number,
  ) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || 'unknown error'}`);
  }
}

export class RepositoryViewService {
  private gitDirIdentity: string | undefined;
  private readonly fileCache = new Map<string, RepositoryFile | null>();
  private readonly blobCache = new Map<string, Uint8Array>();
  private blobCacheBytes = 0;

  private constructor(
    private readonly repoRoot: string,
    private readonly gitDir: string,
    readonly storageRoot: string,
    private readonly actualObjectDir: string,
    private readonly shadowIndexPath: string,
    private readonly shadowObjectDir: string,
    private readonly recoveryPath: string,
    private readonly refsFromFiles: boolean,
  ) {}

  static async open(options: RepositoryViewServiceOptions): Promise<RepositoryViewService> {
    const repoRoot = resolve(options.repoRoot);
    const resolved = await runGit(repoRoot, [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--absolute-git-dir',
      '--git-path',
      'objects',
    ]);
    const [root, gitDir, objectDir] = resolved.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (root === undefined || gitDir === undefined || objectDir === undefined) {
      throw new OperationLogError(
        'invalid',
        'git rev-parse did not resolve the repository root, git directory, and object directory',
      );
    }
    const storageRoot = resolve(options.storageRoot ?? join(gitDir, 'kimi-operation-log'));
    const refsFromFiles =
      !(await pathExists(join(gitDir, 'commondir'))) &&
      !(await pathExists(join(gitDir, 'reftable')));
    const service = new RepositoryViewService(
      root,
      gitDir,
      storageRoot,
      objectDir,
      join(storageRoot, 'index'),
      join(storageRoot, 'objects'),
      join(storageRoot, 'recovery-required.json'),
      refsFromFiles,
    );
    service.gitDirIdentity = await readDirectoryIdentity(gitDir);
    return service;
  }

  async isRepositoryCurrent(): Promise<boolean> {
    const identity = this.gitDirIdentity;
    if (identity === undefined) return false;
    return (await readDirectoryIdentity(this.gitDir)) === identity;
  }

  async captureView(): Promise<OperationView> {
    await this.assertNoRecoveryRequired();
    return this.captureCurrentView();
  }

  async readFiles(
    queries: readonly RepositoryFileQuery[],
  ): Promise<readonly (RepositoryFile | undefined)[]> {
    const reads: (RepositoryFile | undefined)[] = [];
    const pending: {
      readonly tree: string;
      readonly path: string;
      readonly indexes: number[];
    }[] = [];
    const pendingByKey = new Map<string, (typeof pending)[number]>();
    for (const [index, query] of queries.entries()) {
      const key = `${query.view.tree}\0${query.path}`;
      const cached = this.cachedFile(key);
      if (cached !== undefined) {
        reads[index] = cached ?? undefined;
        continue;
      }
      const existing = pendingByKey.get(key);
      if (existing !== undefined) {
        existing.indexes.push(index);
        continue;
      }
      const entry = { tree: query.view.tree, path: query.path, indexes: [index] };
      pendingByKey.set(key, entry);
      pending.push(entry);
    }
    const batched = pending.filter((entry) => !/[\n\r]/.test(entry.path));
    const unbatched = pending.filter((entry) => /[\n\r]/.test(entry.path));
    if (batched.length > 0) {
      const files = await this.readFilesFromGit(batched);
      for (const [index, entry] of batched.entries()) {
        const file = files[index];
        this.cacheFile(`${entry.tree}\0${entry.path}`, file ?? null);
        for (const target of entry.indexes) reads[target] = file;
      }
    }
    for (const entry of unbatched) {
      const file = await this.readFileFromGit(entry.tree, entry.path);
      this.cacheFile(`${entry.tree}\0${entry.path}`, file ?? null);
      for (const target of entry.indexes) reads[target] = file;
    }
    return reads;
  }

  async readFile(view: OperationView, path: string): Promise<RepositoryFile | undefined> {
    const [file] = await this.readFiles([{ view, path }]);
    return file;
  }

  async readBlobs(hashes: readonly string[]): Promise<readonly (Uint8Array | undefined)[]> {
    const reads: (Uint8Array | undefined)[] = [];
    const pending: { readonly hash: string; readonly indexes: number[] }[] = [];
    const pendingByHash = new Map<string, (typeof pending)[number]>();
    for (const [index, hash] of hashes.entries()) {
      const cached = this.cachedBlob(hash);
      if (cached !== undefined) {
        reads[index] = cached;
        continue;
      }
      const existing = pendingByHash.get(hash);
      if (existing !== undefined) {
        existing.indexes.push(index);
        continue;
      }
      const entry = { hash, indexes: [index] };
      pendingByHash.set(hash, entry);
      pending.push(entry);
    }
    if (pending.length === 0) return reads;
    const input = `${pending.map((entry) => entry.hash).join('\n')}\n`;
    const output = await runGitBytes(
      this.repoRoot,
      ['cat-file', '--batch'],
      this.gitEnv(true),
      input,
    );
    let offset = 0;
    for (const entry of pending) {
      const headerEnd = output.indexOf(0x0a, offset);
      if (headerEnd < 0) {
        throw new GitOperationError(['cat-file', 'blob', entry.hash], 'truncated output', 1);
      }
      const header = new TextDecoder().decode(output.subarray(offset, headerEnd));
      offset = headerEnd + 1;
      if (header.endsWith(' missing')) {
        throw new GitOperationError(['cat-file', 'blob', entry.hash], 'object is missing', 128);
      }
      const metadata = OBJECT_LINE_PATTERN.exec(header);
      if (metadata === null || metadata[2] !== 'blob') {
        throw new GitOperationError(['cat-file', 'blob', entry.hash], 'not a blob', 128);
      }
      const size = Number(metadata[3]);
      const bytes = output.subarray(offset, offset + size);
      offset += size + 1;
      this.cacheBlob(entry.hash, bytes);
      for (const target of entry.indexes) reads[target] = bytes;
    }
    return reads;
  }

  async readBlob(hash: string): Promise<Uint8Array> {
    const [bytes] = await this.readBlobs([hash]);
    if (bytes === undefined) {
      throw new GitOperationError(['cat-file', 'blob', hash], 'object is missing', 128);
    }
    return bytes.slice();
  }

  private async readFilesFromGit(
    entries: readonly { readonly tree: string; readonly path: string }[],
  ): Promise<(RepositoryFile | undefined)[]> {
    const trees = [...new Set(entries.map((entry) => entry.tree))];
    for (const tree of trees) {
      if (tree === '') throw new GitOperationError(['ls-tree', tree], 'invalid tree', 128);
    }
    const input = [
      ...trees.map((tree) => `${tree}\n`),
      ...entries.map((entry) => `${entry.tree}:${entry.path}\n`),
    ].join('');
    const result = await this.git(['cat-file', '--batch-check'], { input });
    const lines = result.stdout.split('\n');
    for (const [index, tree] of trees.entries()) {
      if ((lines[index] ?? '').endsWith(' missing')) {
        throw new GitOperationError(['ls-tree', tree], 'tree object is missing', 128);
      }
    }
    const reads: (RepositoryFile | undefined)[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const metadata = OBJECT_LINE_PATTERN.exec(lines[trees.length + index] ?? '');
      const hash = metadata?.[1];
      const type = metadata?.[2];
      const size = metadata?.[3];
      if (hash === undefined || type !== 'blob' || size === undefined) continue;
      reads[index] = { hash, size: Number(size) };
    }
    return reads;
  }

  private async readFileFromGit(
    tree: string,
    path: string,
  ): Promise<RepositoryFile | undefined> {
    const result = await this.git(['ls-tree', '-z', tree, '--', path]);
    if (result.stdout === '') return undefined;
    const separator = result.stdout.indexOf('\t');
    const metadata = result.stdout.slice(0, separator).split(' ');
    const type = metadata[1];
    const hash = metadata[2];
    if (type !== 'blob' || hash === undefined) return undefined;
    const size = Number((await this.git(['cat-file', '-s', hash])).stdout.trim());
    return { hash, size };
  }

  private cachedFile(key: string): RepositoryFile | null | undefined {
    const cached = this.fileCache.get(key);
    if (cached === undefined) return undefined;
    this.fileCache.delete(key);
    this.fileCache.set(key, cached);
    return cached;
  }

  private cacheFile(key: string, file: RepositoryFile | null): void {
    if (this.fileCache.size >= FILE_CACHE_MAX_ENTRIES) {
      const oldest = this.fileCache.keys().next().value;
      if (oldest !== undefined) this.fileCache.delete(oldest);
    }
    this.fileCache.set(key, file);
  }

  private cachedBlob(hash: string): Uint8Array | undefined {
    const cached = this.blobCache.get(hash);
    if (cached === undefined) return undefined;
    this.blobCache.delete(hash);
    this.blobCache.set(hash, cached);
    return cached;
  }

  private cacheBlob(hash: string, bytes: Uint8Array): void {
    if (bytes.byteLength > BLOB_CACHE_MAX_ENTRY_BYTES || this.blobCache.has(hash)) return;
    this.blobCache.set(hash, bytes);
    this.blobCacheBytes += bytes.byteLength;
    while (this.blobCacheBytes > BLOB_CACHE_MAX_BYTES) {
      const oldest = this.blobCache.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.blobCache.get(oldest);
      this.blobCache.delete(oldest);
      if (evicted !== undefined) this.blobCacheBytes -= evicted.byteLength;
    }
  }

  async changedFiles(before: OperationView, after: OperationView): Promise<readonly string[]> {
    const result = await this.git(['diff', '--name-only', '-z', before.tree, after.tree]);
    return result.stdout.split('\0').filter((path) => path !== '');
  }

  async restoreView(expected: OperationView, target: OperationView): Promise<void> {
    const current = await this.captureView();
    await this.assertRestorable(target);
    if (!operationViewsEqual(current, expected)) {
      throw new OperationLogError(
        'view-mismatch',
        'The repository changed after the expected view was captured',
      );
    }
    await mkdir(dirname(this.recoveryPath), { recursive: true, mode: 0o700 });
    await writeFile(this.recoveryPath, JSON.stringify({ current, target }), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await this.applyView(current, target);
    } catch (error) {
      try {
        const interrupted = await this.captureCurrentView();
        await this.applyView(interrupted, current);
        await rm(this.recoveryPath, { force: true });
      } catch (rollbackError) {
        throw new OperationLogError(
          'recovery-required',
          `Git view restoration failed (${errorMessage(error)}); rollback failed (${errorMessage(rollbackError)})`,
        );
      }
      throw error;
    }
    try {
      await rm(this.recoveryPath, { force: true });
    } catch (error) {
      throw new OperationLogError(
        'recovery-required',
        `Git view was restored but its recovery marker could not be removed: ${errorMessage(error)}`,
      );
    }
  }

  async assertRestorable(view: OperationView): Promise<void> {
    await this.assertNoRecoveryRequired();
    const currentUnfinished = await this.readUnfinishedOperation();
    if (currentUnfinished !== undefined) {
      throw new OperationLogError(
        'unfinished-operation',
        `Cannot restore while a ${currentUnfinished} is in progress`,
        { operation: currentUnfinished },
      );
    }
    if (!(await this.actualIndexIsClean())) {
      throw new OperationLogError('staged-changes', 'Cannot restore with staged changes');
    }
    if (view.unfinishedOperation !== undefined) {
      throw new OperationLogError(
        'unfinished-operation',
        `Cannot restore a view recorded during a ${view.unfinishedOperation}`,
        { operation: view.unfinishedOperation },
      );
    }
    const expectedIndexTree = await this.treeForHead(view.head);
    if (view.indexTree === '' || view.indexTree !== expectedIndexTree) {
      throw new OperationLogError('staged-changes', 'The target view contains staged changes');
    }
  }

  private async captureCurrentView(): Promise<OperationView> {
    await mkdir(dirname(this.shadowIndexPath), { recursive: true, mode: 0o700 });
    await mkdir(this.shadowObjectDir, { recursive: true, mode: 0o700 });
    const head = await this.readHead();
    await this.git(['read-tree', ...(head.kind === 'unborn' ? ['--empty'] : ['HEAD'])]);
    await this.git(['add', '-A', '--', '.']);
    const tree = (await this.git(['write-tree'])).stdout.trim();
    const [refs, indexTree, unfinishedOperation] = await Promise.all([
      this.readRefs(),
      this.readActualIndexTree(),
      this.readUnfinishedOperation(),
    ]);
    return {
      tree,
      head,
      refs,
      indexTree,
      ...(unfinishedOperation === undefined ? {} : { unfinishedOperation }),
    };
  }

  private async applyView(current: OperationView, target: OperationView): Promise<void> {
    if (current.tree !== target.tree) {
      await this.git(['read-tree', current.tree]);
      await this.git(['read-tree', '--reset', '-u', target.tree]);
    }
    if (!operationGitHeadsEqual(current.head, target.head)) {
      if (target.head.kind === 'detached') {
        const oldTarget = current.head.kind === 'unborn' ? '0'.repeat(40) : current.head.target;
        await this.git(['update-ref', '--no-deref', 'HEAD', target.head.target, oldTarget], {
          shadowIndex: false,
        });
      } else {
        await this.git(['symbolic-ref', 'HEAD', target.head.ref], { shadowIndex: false });
      }
    }
    if (!operationRefsEqual(current.refs, target.refs))
      await this.updateRefs(current.refs, target.refs);
    if (current.indexTree !== target.indexTree) {
      await this.git(
        ['read-tree', ...(target.head.kind === 'unborn' ? ['--empty'] : [target.head.target])],
        { shadowIndex: false },
      );
    }
  }

  private async updateRefs(
    current: Readonly<Record<string, string>>,
    target: Readonly<Record<string, string>>,
  ): Promise<void> {
    const missing = '0'.repeat(40);
    const commands: string[] = [];
    for (const [ref, oldTarget] of Object.entries(current)) {
      const newTarget = target[ref];
      if (newTarget === undefined) commands.push(`delete ${ref} ${oldTarget}`);
      else if (newTarget !== oldTarget) commands.push(`update ${ref} ${newTarget} ${oldTarget}`);
    }
    for (const [ref, newTarget] of Object.entries(target)) {
      if (current[ref] === undefined) commands.push(`update ${ref} ${newTarget} ${missing}`);
    }
    if (commands.length === 0) return;
    await this.git(['update-ref', '--stdin'], {
      input: `${commands.join('\n')}\n`,
      shadowIndex: false,
    });
  }

  private async assertNoRecoveryRequired(): Promise<void> {
    if (await pathExists(this.recoveryPath)) {
      throw new OperationLogError(
        'recovery-required',
        'A previous Git view restoration requires recovery',
      );
    }
  }

  private async readHead(): Promise<OperationGitHead> {
    return (await this.readHeadFile()) ?? this.readHeadWithGit();
  }

  private async readHeadFile(): Promise<OperationGitHead | undefined> {
    if (!this.refsFromFiles) return undefined;
    const raw = await readTextFile(join(this.gitDir, 'HEAD'));
    if (raw === undefined) return undefined;
    const value = raw.trim();
    if (value.includes('\n')) return undefined;
    if (value.startsWith('ref: ')) {
      const ref = value.slice(5).trim();
      if (!isValidRefName(ref)) return undefined;
      const resolution = await this.resolveRefFile(ref, 0);
      if (resolution.kind === 'invalid') return undefined;
      if (resolution.kind === 'missing') return { kind: 'unborn', ref };
      return { kind: 'branch', ref, target: resolution.target };
    }
    return OBJECT_ID_PATTERN.test(value) ? { kind: 'detached', target: value } : undefined;
  }

  private async resolveRefFile(ref: string, depth: number): Promise<RefResolution> {
    if (depth >= MAX_SYMREF_DEPTH || !isValidRefName(ref)) return { kind: 'invalid' };
    const raw = await readTextFile(join(this.gitDir, ref));
    if (raw !== undefined) {
      const value = raw.trim();
      if (value.startsWith('ref: ')) {
        return this.resolveRefFile(value.slice(5).trim(), depth + 1);
      }
      return OBJECT_ID_PATTERN.test(value)
        ? { kind: 'resolved', target: value }
        : { kind: 'invalid' };
    }
    const packed = await this.readPackedRefs();
    if (packed === 'invalid') return { kind: 'invalid' };
    const target = packed?.get(ref);
    return target === undefined ? { kind: 'missing' } : { kind: 'resolved', target };
  }

  private async readHeadWithGit(): Promise<OperationGitHead> {
    const [symbolic, targetResult] = await Promise.all([
      this.git(['symbolic-ref', '-q', 'HEAD'], {
        allowedExitCodes: [0, 1],
      }),
      this.git(['rev-parse', '--verify', '--quiet', 'HEAD'], {
        allowedExitCodes: [0, 1],
      }),
    ]);
    if (symbolic.exitCode === 0) {
      const ref = symbolic.stdout.trim();
      if (targetResult.exitCode !== 0) return { kind: 'unborn', ref };
      return { kind: 'branch', ref, target: targetResult.stdout.trim() };
    }
    if (targetResult.exitCode !== 0) {
      throw new OperationLogError(
        'invalid',
        'Cannot resolve HEAD as a branch, detached commit, or unborn branch',
      );
    }
    return { kind: 'detached', target: targetResult.stdout.trim() };
  }

  private async readRefs(): Promise<Readonly<Record<string, string>>> {
    return (await this.readRefsFromFiles()) ?? this.readRefsWithGit();
  }

  private async readRefsFromFiles(): Promise<Readonly<Record<string, string>> | undefined> {
    if (!this.refsFromFiles) return undefined;
    const packed = await this.readPackedRefs();
    if (packed === 'invalid') return undefined;
    const raw = new Map<string, string>(packed ?? []);
    if (!(await this.collectLooseRefs(join(this.gitDir, 'refs'), 'refs', raw))) return undefined;
    for (const value of raw.values()) {
      if (!OBJECT_ID_PATTERN.test(value) && !value.startsWith('ref: ')) return undefined;
    }
    const refs: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const name of [...raw.keys()].toSorted(compareRefNames)) {
      const target = resolveRefChain(raw, name);
      if (target !== undefined) refs[name] = target;
    }
    return refs;
  }

  private async collectLooseRefs(
    directory: string,
    prefix: string,
    refs: Map<string, string>,
  ): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      return (error as { code?: unknown }).code === 'ENOENT';
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith('.') || name.endsWith('.lock')) continue;
      const ref = `${prefix}/${name}`;
      if (entry.isDirectory()) {
        if (!(await this.collectLooseRefs(join(directory, name), ref, refs))) return false;
        continue;
      }
      if (!entry.isFile() || !isValidRefName(ref)) continue;
      const raw = await readTextFile(join(directory, name));
      if (raw === undefined) return false;
      refs.set(ref, raw.trim());
    }
    return true;
  }

  private async readPackedRefs(): Promise<ReadonlyMap<string, string> | 'invalid' | undefined> {
    const raw = await readTextFile(join(this.gitDir, 'packed-refs'));
    if (raw === undefined) return undefined;
    const refs = new Map<string, string>();
    for (const line of raw.split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      if (line.startsWith('^')) {
        if (!OBJECT_ID_PATTERN.test(line.slice(1).trim())) return 'invalid';
        continue;
      }
      const separator = line.indexOf(' ');
      if (separator <= 0) return 'invalid';
      const target = line.slice(0, separator);
      const name = line.slice(separator + 1).trim();
      if (!OBJECT_ID_PATTERN.test(target) || !isValidRefName(name)) return 'invalid';
      refs.set(name, target);
    }
    return refs;
  }

  private async readRefsWithGit(): Promise<Readonly<Record<string, string>>> {
    const result = await this.git(['for-each-ref', '--format=%(refname)%00%(objectname)']);
    const refs: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const line of result.stdout.split('\n')) {
      if (line === '') continue;
      const separator = line.indexOf('\0');
      if (separator <= 0) throw new OperationLogError('corrupt', 'Unexpected git ref record');
      refs[line.slice(0, separator)] = line.slice(separator + 1).trim();
    }
    return refs;
  }

  private async readActualIndexTree(): Promise<string> {
    if (!(await pathExists(join(this.gitDir, 'index')))) return this.emptyTree();
    try {
      return (await this.git(['write-tree'], { shadowIndex: false })).stdout.trim();
    } catch (error) {
      if (!(error instanceof GitOperationError)) throw error;
      const unmerged = await this.git(['diff', '--cached', '--name-only', '--diff-filter=U'], {
        shadowIndex: false,
      });
      if (unmerged.stdout.trim() === '') throw error;
      return '';
    }
  }

  private async actualIndexIsClean(): Promise<boolean> {
    const result = await this.git(['diff', '--cached', '--quiet'], {
      shadowIndex: false,
      allowedExitCodes: [0, 1],
    });
    return result.exitCode === 0;
  }

  private async treeForHead(head: OperationGitHead): Promise<string> {
    if (head.kind === 'unborn') return this.emptyTree();
    return (
      await this.git(['rev-parse', `${head.target}^{tree}`], { shadowIndex: false })
    ).stdout.trim();
  }

  private async emptyTree(): Promise<string> {
    return (await this.git(['mktree'], { input: '', shadowIndex: false })).stdout.trim();
  }

  private async readUnfinishedOperation(): Promise<'merge' | 'rebase' | undefined> {
    if (
      (await pathExists(join(this.gitDir, 'rebase-merge'))) ||
      (await pathExists(join(this.gitDir, 'rebase-apply')))
    ) {
      return 'rebase';
    }
    if (await pathExists(join(this.gitDir, 'MERGE_HEAD'))) return 'merge';
    return undefined;
  }

  private git(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    return runGit(this.repoRoot, args, this.gitEnv(options.shadowIndex !== false), options);
  }

  private gitEnv(shadowIndex: boolean): Record<string, string> {
    const env: Record<string, string> = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OBJECT_DIRECTORY: this.shadowObjectDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: this.actualObjectDir,
    };
    if (shadowIndex) env['GIT_INDEX_FILE'] = this.shadowIndexPath;
    return env;
  }
}

async function runGit(
  cwd: string,
  args: readonly string[],
  env?: Record<string, string>,
  options: GitRunOptions = {},
): Promise<GitResult> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    env: env ?? { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdin: options.input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
    timeout: 60_000,
  });
  if (options.input !== undefined) {
    if (proc.stdin === undefined) throw new Error('Git stdin is unavailable');
    await proc.stdin.write(options.input);
    await proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const result = { stdout, stderr, exitCode };
  if (!(options.allowedExitCodes ?? [0]).includes(exitCode)) {
    throw new GitOperationError(args, stderr, exitCode);
  }
  return result;
}

async function runGitBytes(
  cwd: string,
  args: readonly string[],
  env: Record<string, string>,
  input?: string,
): Promise<Uint8Array> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    env,
    stdin: input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
    timeout: 60_000,
  });
  if (input !== undefined) {
    if (proc.stdin === undefined) throw new Error('Git stdin is unavailable');
    await proc.stdin.write(input);
    await proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new GitOperationError(args, stderr, exitCode);
  return new Uint8Array(stdout);
}
