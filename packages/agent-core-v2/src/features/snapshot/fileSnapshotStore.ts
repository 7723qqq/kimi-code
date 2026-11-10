import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';

import { dirname, join } from 'pathe';

import {
  SNAPSHOT_RECORD_VERSION,
  isSnapshotAgentMark,
  isSnapshotRecord,
  type ISnapshotStore,
  type SnapshotAgentMark,
  type SnapshotAgentMarkInput,
  type SnapshotPruneOptions,
  type SnapshotPruneResult,
  type SnapshotRecord,
  type SnapshotRecordInput,
} from './snapshot';

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 10_000;
const localStoreLocks = new Map<string, Promise<void>>();

function sha256Hex(value: Uint8Array | string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function normalizedPath(path: string): string {
  const slashed = path.replaceAll('\\', '/');
  return /^[a-zA-Z]:\//.test(slashed) ? slashed.toLowerCase() : slashed;
}

export function snapshotPathKey(path: string): string {
  return sha256Hex(normalizedPath(path));
}

export function snapshotContentHash(bytes: Uint8Array | string): string {
  return sha256Hex(bytes);
}

export class FileSnapshotStore implements ISnapshotStore {
  declare readonly _serviceBrand: undefined;

  private readonly objectsDir: string;
  private readonly pathsDir: string;
  private readonly agentsDir: string;

  constructor(private readonly root: string) {
    this.objectsDir = join(root, 'objects');
    this.pathsDir = join(root, 'paths');
    this.agentsDir = join(root, 'agents');
  }

  async record(input: SnapshotRecordInput): Promise<SnapshotRecord> {
    return this.withLock(async () => {
      const dir = this.pathDir(input.path);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const previousId = await this.newestId(dir);
      const hash = input.bytes === undefined ? '' : sha256Hex(input.bytes);
      if (input.bytes !== undefined && hash !== '') await this.writeObject(hash, input.bytes);
      const id = `${String(input.at.getTime()).padStart(13, '0')}-${randomUUID().slice(0, 8)}`;
      const record: SnapshotRecord = {
        version: SNAPSHOT_RECORD_VERSION,
        id,
        path: input.path,
        hash,
        size: input.size,
        at: input.at.toISOString(),
        tool: input.tool,
        mode: input.mode,
        ...(input.mtimeMs === undefined ? {} : { mtimeMs: input.mtimeMs }),
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        ...(previousId === undefined ? {} : { previousId }),
        ...(input.skipped === undefined ? {} : { skipped: input.skipped }),
      };
      await this.writeAtomic(join(dir, `${id}.json`), `${JSON.stringify(record)}\n`);
      return record;
    });
  }

  remove(path: string, id: string): Promise<boolean> {
    return this.unlinkSafe(join(this.pathDir(path), `${id}.json`));
  }

  async complete(
    path: string,
    id: string,
    after: { readonly hash: string; readonly size: number },
  ): Promise<boolean> {
    const file = join(this.pathDir(path), `${id}.json`);
    const parsed = await this.readJson(file);
    if (!isSnapshotRecord(parsed)) return false;
    const next: SnapshotRecord = {
      ...parsed,
      afterHash: after.hash,
      afterSize: after.size,
    };
    await this.writeAtomic(file, `${JSON.stringify(next)}\n`);
    return true;
  }

  async list(path: string): Promise<readonly SnapshotRecord[]> {
    const dir = this.pathDir(path);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
    const records: SnapshotRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const parsed = await this.readJson(join(dir, name));
      if (isSnapshotRecord(parsed)) records.push(parsed);
    }
    return records.toSorted((left, right) => right.id.localeCompare(left.id));
  }

  async content(hash: string): Promise<Uint8Array | undefined> {
    if (hash === '') return undefined;
    const file = Bun.file(this.objectPath(hash));
    if (!(await file.exists())) return undefined;
    const bytes = new Uint8Array(await file.arrayBuffer());
    return sha256Hex(bytes) === hash ? bytes : undefined;
  }

  async markAgent(input: SnapshotAgentMarkInput): Promise<void> {
    await this.withLock(async () => {
      const dir = join(this.agentsDir, encodeSegment(input.sessionId));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const mark: SnapshotAgentMark = {
        version: SNAPSHOT_RECORD_VERSION,
        agentId: input.agentId,
        sessionId: input.sessionId,
        at: input.at.toISOString(),
        cwd: input.cwd,
        ...(input.parentAgentId === undefined ? {} : { parentAgentId: input.parentAgentId }),
        ...(input.profileName === undefined ? {} : { profileName: input.profileName }),
        ...(input.swarmIndex === undefined ? {} : { swarmIndex: input.swarmIndex }),
      };
      await this.writeAtomic(
        join(dir, `${encodeSegment(input.agentId)}.json`),
        `${JSON.stringify(mark)}\n`,
      );
    });
  }

  async agents(sessionId: string): Promise<readonly SnapshotAgentMark[]> {
    const dir = join(this.agentsDir, encodeSegment(sessionId));
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
    const marks: SnapshotAgentMark[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const parsed = await this.readJson(join(dir, name));
      if (isSnapshotAgentMark(parsed)) marks.push(parsed);
    }
    return marks.toSorted((left, right) => left.at.localeCompare(right.at));
  }

  async prune(options: SnapshotPruneOptions): Promise<SnapshotPruneResult> {
    return this.withLock(async () => {
      const startedAt = options.now.getTime();
      const sweepStartedAt = Date.now();
      const oldestKept = startedAt - options.maxAgeMs;
      const referenced = new Set<string>();
      let recordsRemoved = 0;
      for (const dir of await this.pathDirs()) {
        const names = (await this.readdirSafe(dir))
          .filter((name) => name.endsWith('.json'))
          .toSorted()
          .toReversed();
        let keptBytes = 0;
        for (const [index, name] of names.entries()) {
          const parsed = await this.readJson(join(dir, name));
          if (!isSnapshotRecord(parsed)) {
            if (index > 0 && (await this.unlinkSafe(join(dir, name)))) recordsRemoved += 1;
            continue;
          }
          const expired = Date.parse(parsed.at) < oldestKept;
          const overBudget = index > 0 && keptBytes + parsed.size > options.maxBytesPerPath;
          if (index >= options.maxPerPath || (expired && index > 0) || overBudget) {
            if (await this.unlinkSafe(join(dir, name))) recordsRemoved += 1;
            continue;
          }
          keptBytes += parsed.size;
          if (parsed.hash !== '') referenced.add(parsed.hash);
        }
      }
      let objectsRemoved = 0;
      for (const dir of await this.objectDirs()) {
        for (const name of await this.readdirSafe(dir)) {
          if (referenced.has(name)) continue;
          const path = join(dir, name);
          try {
            const info = await stat(path);
            if (sweepStartedAt - info.mtimeMs < options.minObjectAgeMs) continue;
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error;
            continue;
          }
          if (await this.unlinkSafe(path)) objectsRemoved += 1;
        }
      }
      let agentMarksRemoved = 0;
      for (const bucket of await this.readdirSafe(this.agentsDir)) {
        const dir = join(this.agentsDir, bucket);
        for (const name of await this.readdirSafe(dir)) {
          if (!name.endsWith('.json')) continue;
          const parsed = await this.readJson(join(dir, name));
          if (isSnapshotAgentMark(parsed) && Date.parse(parsed.at) >= oldestKept) continue;
          if (await this.unlinkSafe(join(dir, name))) agentMarksRemoved += 1;
        }
      }
      return { recordsRemoved, objectsRemoved, agentMarksRemoved };
    });
  }

  private async pathDirs(): Promise<string[]> {
    const dirs: string[] = [];
    for (const bucket of await this.readdirSafe(this.pathsDir)) {
      for (const key of await this.readdirSafe(join(this.pathsDir, bucket))) {
        dirs.push(join(this.pathsDir, bucket, key));
      }
    }
    return dirs;
  }

  private async objectDirs(): Promise<string[]> {
    return (await this.readdirSafe(this.objectsDir)).map((bucket) => join(this.objectsDir, bucket));
  }

  private async readdirSafe(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  private async unlinkSafe(path: string): Promise<boolean> {
    try {
      await unlink(path);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  private pathDir(path: string): string {
    const key = snapshotPathKey(path);
    return join(this.pathsDir, key.slice(0, 2), key);
  }

  private objectPath(hash: string): string {
    return join(this.objectsDir, hash.slice(0, 2), hash);
  }

  private async writeObject(hash: string, bytes: Uint8Array): Promise<void> {
    const target = this.objectPath(hash);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const file = Bun.file(target);
    if (await file.exists()) {
      if ((await this.content(hash)) !== undefined) return;
      await this.unlinkSafe(target);
    }
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
      try {
        await rename(temp, target);
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private async newestId(dir: string): Promise<string | undefined> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
    let newest: string | undefined;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (newest === undefined || id > newest) newest = id;
    }
    return newest;
  }

  private async readJson(path: string): Promise<unknown> {
    try {
      return JSON.parse(await Bun.file(path).text()) as unknown;
    } catch {
      return undefined;
    }
  }

  private async withLock<T>(run: () => Promise<T>): Promise<T> {
    const previous = localStoreLocks.get(this.root) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    localStoreLocks.set(this.root, tail);
    await previous;
    try {
      return await this.withFileLock(run);
    } finally {
      release();
      if (localStoreLocks.get(this.root) === tail) localStoreLocks.delete(this.root);
    }
  }

  private async withFileLock<T>(run: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, '.lock');
    const token = randomUUID();
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await writeFile(path, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        break;
      } catch (error) {
        const code = errorCode(error);
        if (code !== 'EEXIST' && code !== 'EPERM') throw error;
        if (code === 'EPERM' && !(await Bun.file(path).exists())) throw error;
        const age = await stat(path)
          .then((info) => Date.now() - info.mtimeMs)
          .catch(() => 0);
        if (age > LOCK_STALE_MS) {
          await rm(path, { force: true });
          continue;
        }
        if (Date.now() > deadline)
          throw new Error(`Timed out waiting for the snapshot lock: ${path}`);
        await Bun.sleep(LOCK_RETRY_MS);
      }
    }
    const heartbeat = setInterval(() => {
      const at = new Date();
      void utimes(path, at, at).catch(() => undefined);
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      return await run();
    } finally {
      clearInterval(heartbeat);
      const owner = await Bun.file(path)
        .text()
        .catch(() => undefined);
      if (owner === token) await rm(path, { force: true });
    }
  }

  private async writeAtomic(path: string, data: string): Promise<void> {
    const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temp, data, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
  }
}

export function encodeSegment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, '_');
}
