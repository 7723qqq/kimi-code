import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';

import { dirname, join, resolve } from 'pathe';

import {
  OPERATION_LOG_DEFAULT_RETENTION,
  OPERATION_LOG_RECORD_VERSION,
  OperationLogError,
  type OperationActionInput,
  type OperationLogHead,
  type OperationLogRetention,
  type OperationRecord,
  type OperationView,
} from './operationLog';

const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 10_000;
const localLocks = new Map<string, Promise<void>>();

interface StoredOperationView extends OperationView {
  readonly version: number;
}

interface OperationDocument {
  readonly path: string;
  readonly raw: string;
  readonly operation: OperationRecord;
}

function sha256(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

function encoded(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function assertId(id: string): void {
  if (!/^[a-f0-9]{64}$/.test(id))
    throw new OperationLogError('invalid', 'Invalid operation object id');
}

function isOperationView(value: unknown): value is StoredOperationView {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StoredOperationView>;
  if (
    candidate.version !== OPERATION_LOG_RECORD_VERSION ||
    typeof candidate.tree !== 'string' ||
    typeof candidate.indexTree !== 'string' ||
    typeof candidate.refs !== 'object' ||
    candidate.refs === null ||
    Array.isArray(candidate.refs) ||
    typeof candidate.head !== 'object' ||
    candidate.head === null
  ) {
    return false;
  }
  if (!Object.values(candidate.refs).every((target) => typeof target === 'string')) return false;
  const head = candidate.head;
  const validHead =
    head.kind === 'detached'
      ? typeof head.target === 'string'
      : head.kind === 'unborn'
        ? typeof head.ref === 'string'
        : head.kind === 'branch' && typeof head.ref === 'string' && typeof head.target === 'string';
  return (
    validHead &&
    (candidate.unfinishedOperation === undefined ||
      candidate.unfinishedOperation === 'merge' ||
      candidate.unfinishedOperation === 'rebase')
  );
}

function isOperationRecord(value: unknown): value is OperationRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<OperationRecord>;
  return (
    candidate.version === OPERATION_LOG_RECORD_VERSION &&
    typeof candidate.id === 'string' &&
    Array.isArray(candidate.parents) &&
    candidate.parents.every((parent) => typeof parent === 'string') &&
    typeof candidate.viewId === 'string' &&
    (candidate.kind === 'capture' ||
      candidate.kind === 'undo' ||
      candidate.kind === 'redo' ||
      candidate.kind === 'restore') &&
    typeof candidate.at === 'string' &&
    typeof candidate.description === 'string' &&
    typeof candidate.nonce === 'string'
  );
}

function isOperationHead(value: unknown): value is OperationLogHead {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<OperationLogHead>;
  return (
    typeof candidate.operationId === 'string' &&
    (candidate.undoTargetId === undefined || typeof candidate.undoTargetId === 'string') &&
    Array.isArray(candidate.redoStack) &&
    candidate.redoStack.every((id) => typeof id === 'string')
  );
}

export class OperationLogStore {
  private readonly root: string;
  private readonly operationsDir: string;
  private readonly viewsDir: string;
  private readonly headPath: string;
  private readonly retention: OperationLogRetention;

  constructor(root: string, retention: Partial<OperationLogRetention> = {}) {
    this.root = resolve(root);
    this.operationsDir = join(this.root, 'operations');
    this.viewsDir = join(this.root, 'views');
    this.headPath = join(this.root, 'head.json');
    this.retention = { ...OPERATION_LOG_DEFAULT_RETENTION, ...retention };
    if (
      !Number.isSafeInteger(this.retention.maxOperations) ||
      this.retention.maxOperations < 1 ||
      !Number.isFinite(this.retention.maxAgeMs) ||
      this.retention.maxAgeMs < 0 ||
      !Number.isSafeInteger(this.retention.maxTotalBytes) ||
      this.retention.maxTotalBytes < 1
    ) {
      throw new OperationLogError('invalid', 'Invalid operation log retention configuration');
    }
  }

  capture(
    view: OperationView,
    input: OperationActionInput,
    beforeView?: OperationView,
  ): Promise<OperationRecord> {
    return this.withLock(async () => {
      const head = await this.readHead();
      const parent = head === undefined ? undefined : await this.readOperation(head.operationId);
      return this.append({
        kind: 'capture',
        view,
        beforeView,
        parent,
        input,
        nextHead: (operation) => ({
          operationId: operation.id,
          undoTargetId: operation.id,
          redoStack: [],
        }),
      });
    });
  }

  undo(input: OperationActionInput): Promise<OperationRecord> {
    return this.withLock(async () => {
      const head = await this.requireHead();
      if (head.undoTargetId === undefined) {
        throw new OperationLogError('nothing-to-undo', 'No operation is available to undo');
      }
      const parent = await this.readOperation(head.operationId);
      const target = await this.readOperation(head.undoTargetId);
      if (target.beforeViewId === undefined) {
        throw new OperationLogError('nothing-to-undo', 'The first operation cannot be undone');
      }
      const view = await this.readView(target.beforeViewId);
      const nextUndoTargetId = target.parents[0];
      return this.append({
        kind: 'undo',
        view,
        parent,
        input,
        targetId: target.id,
        nextHead: (operation) => ({
          operationId: operation.id,
          ...(nextUndoTargetId === undefined ? {} : { undoTargetId: nextUndoTargetId }),
          redoStack: [...head.redoStack, target.id],
        }),
      });
    });
  }

  redo(input: OperationActionInput): Promise<OperationRecord> {
    return this.withLock(async () => {
      const head = await this.requireHead();
      const targetId = head.redoStack.at(-1);
      if (targetId === undefined) {
        throw new OperationLogError('nothing-to-redo', 'No operation is available to redo');
      }
      const parent = await this.readOperation(head.operationId);
      const target = await this.readOperation(targetId);
      const view = await this.readView(target.viewId);
      return this.append({
        kind: 'redo',
        view,
        parent,
        input,
        targetId,
        nextHead: (operation) => ({
          operationId: operation.id,
          undoTargetId: operation.id,
          redoStack: head.redoStack.slice(0, -1),
        }),
      });
    });
  }

  restore(targetId: string, input: OperationActionInput): Promise<OperationRecord> {
    assertId(targetId);
    return this.withLock(async () => {
      const head = await this.requireHead();
      const parent = await this.readOperation(head.operationId);
      const target = await this.readOperation(targetId);
      const view = await this.readView(target.viewId);
      return this.append({
        kind: 'restore',
        view,
        parent,
        input,
        targetId,
        nextHead: (operation) => ({
          operationId: operation.id,
          undoTargetId: operation.id,
          redoStack: [],
        }),
      });
    });
  }

  head(): Promise<OperationLogHead | undefined> {
    return this.withLock(() => this.readHead());
  }

  get(id: string): Promise<OperationRecord> {
    assertId(id);
    return this.withLock(() => this.readOperation(id));
  }

  view(id: string): Promise<OperationView> {
    assertId(id);
    return this.withLock(() => this.readView(id));
  }

  list(limit?: number): Promise<readonly OperationRecord[]> {
    return this.withLock(async () => {
      const head = await this.readHead();
      if (head === undefined) return [];
      const operations: OperationRecord[] = [];
      let cursor: string | undefined = head.operationId;
      const seen = new Set<string>();
      while (cursor !== undefined && !seen.has(cursor)) {
        if (limit !== undefined && operations.length >= limit) break;
        seen.add(cursor);
        const operation = await this.readOperation(cursor);
        operations.push(operation);
        cursor = operation.parents[0];
      }
      return operations;
    });
  }

  private async append(input: {
    readonly kind: OperationRecord['kind'];
    readonly view: OperationView;
    readonly beforeView?: OperationView;
    readonly parent: OperationRecord | undefined;
    readonly input: OperationActionInput;
    readonly targetId?: string;
    readonly nextHead: (operation: OperationRecord) => OperationLogHead;
  }): Promise<OperationRecord> {
    if (!isOperationView({ version: OPERATION_LOG_RECORD_VERSION, ...input.view })) {
      throw new OperationLogError('invalid', 'Invalid operation view');
    }
    const storedView: StoredOperationView = {
      version: OPERATION_LOG_RECORD_VERSION,
      ...input.view,
    };
    const viewRaw = encoded(storedView);
    const viewId = sha256(viewRaw);
    let beforeViewRaw: string | undefined;
    let beforeViewId: string | undefined;
    if (input.beforeView !== undefined) {
      if (!isOperationView({ version: OPERATION_LOG_RECORD_VERSION, ...input.beforeView })) {
        throw new OperationLogError('invalid', 'Invalid operation before view');
      }
      beforeViewRaw = encoded({ version: OPERATION_LOG_RECORD_VERSION, ...input.beforeView });
      beforeViewId = sha256(beforeViewRaw);
      if (input.parent !== undefined && input.parent.viewId !== beforeViewId) {
        throw new OperationLogError(
          'view-mismatch',
          'The capture before view differs from the operation head view',
        );
      }
    }
    const effectiveBeforeViewId = input.parent?.viewId ?? beforeViewId;
    const content: Omit<OperationRecord, 'id'> = {
      version: OPERATION_LOG_RECORD_VERSION,
      parents: input.parent === undefined ? [] : [input.parent.id],
      ...(effectiveBeforeViewId === undefined ? {} : { beforeViewId: effectiveBeforeViewId }),
      viewId,
      kind: input.kind,
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      at: input.input.at.toISOString(),
      description: input.input.description,
      nonce: randomUUID(),
      ...(input.input.origin === undefined ? {} : { origin: input.input.origin }),
    };
    const withId: OperationRecord = { id: sha256(encoded(content)), ...content };
    const operationRaw = encoded(withId);
    await this.assertRetention(withId, operationRaw, viewRaw, input.input.at, beforeViewRaw);
    if (beforeViewId !== undefined && beforeViewRaw !== undefined) {
      await this.writeImmutable(this.viewPath(beforeViewId), beforeViewRaw);
    }
    await this.writeImmutable(this.viewPath(viewId), viewRaw);
    await this.writeImmutable(this.operationPath(withId.id), operationRaw);
    await this.writeAtomic(this.headPath, encoded(input.nextHead(withId)));
    return withId;
  }

  private async assertRetention(
    operation: OperationRecord,
    operationRaw: string,
    viewRaw: string,
    at: Date,
    beforeViewRaw?: string,
  ): Promise<void> {
    const documents = await this.operationDocuments();
    if (documents.length >= this.retention.maxOperations) {
      throw new OperationLogError(
        'retention-exceeded',
        `Operation count limit reached (${String(this.retention.maxOperations)})`,
        { limit: 'operations', maximum: this.retention.maxOperations },
      );
    }
    const oldestAllowed = at.getTime() - this.retention.maxAgeMs;
    if (documents.some((document) => Date.parse(document.operation.at) < oldestAllowed)) {
      throw new OperationLogError(
        'retention-exceeded',
        `Operation age limit reached (${String(this.retention.maxAgeMs)}ms)`,
        { limit: 'age', maximum: this.retention.maxAgeMs },
      );
    }
    const viewIds = new Set(
      documents.flatMap((document) => [
        document.operation.viewId,
        ...(document.operation.beforeViewId === undefined ? [] : [document.operation.beforeViewId]),
      ]),
    );
    let totalBytes = documents.reduce(
      (total, document) => total + Buffer.byteLength(document.raw),
      0,
    );
    for (const viewId of viewIds) totalBytes += await this.fileSize(this.viewPath(viewId));
    totalBytes += Buffer.byteLength(operationRaw);
    if (!viewIds.has(operation.viewId)) {
      totalBytes += Buffer.byteLength(viewRaw);
      viewIds.add(operation.viewId);
    }
    if (
      beforeViewRaw !== undefined &&
      operation.beforeViewId !== undefined &&
      !viewIds.has(operation.beforeViewId)
    ) {
      totalBytes += Buffer.byteLength(beforeViewRaw);
    }
    if (totalBytes > this.retention.maxTotalBytes) {
      throw new OperationLogError(
        'retention-exceeded',
        `Operation byte limit reached (${String(this.retention.maxTotalBytes)})`,
        { limit: 'bytes', maximum: this.retention.maxTotalBytes },
      );
    }
  }

  private async operationDocuments(): Promise<readonly OperationDocument[]> {
    const documents: OperationDocument[] = [];
    for (const bucket of await this.readdirSafe(this.operationsDir)) {
      const dir = join(this.operationsDir, bucket);
      for (const name of await this.readdirSafe(dir)) {
        if (!name.endsWith('.json')) continue;
        const path = join(dir, name);
        const raw = await Bun.file(path).text();
        const operation = this.parseOperation(raw, name.slice(0, -'.json'.length));
        documents.push({ path, raw, operation });
      }
    }
    return documents;
  }

  private async requireHead(): Promise<OperationLogHead> {
    const head = await this.readHead();
    if (head === undefined) throw new OperationLogError('not-found', 'Operation log is empty');
    return head;
  }

  private async readHead(): Promise<OperationLogHead | undefined> {
    const raw = await this.readRaw(this.headPath);
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new OperationLogError('corrupt', 'Operation head is not valid JSON');
    }
    if (!isOperationHead(parsed))
      throw new OperationLogError('corrupt', 'Operation head is invalid');
    return parsed;
  }

  private async readOperation(id: string): Promise<OperationRecord> {
    const raw = await this.readRaw(this.operationPath(id));
    if (raw === undefined) throw new OperationLogError('not-found', `Operation not found: ${id}`);
    return this.parseOperation(raw, id);
  }

  private parseOperation(raw: string, id: string): OperationRecord {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new OperationLogError('corrupt', `Operation is not valid JSON: ${id}`);
    }
    if (!isOperationRecord(parsed) || parsed.id !== id) {
      throw new OperationLogError('corrupt', `Operation content does not match its id: ${id}`);
    }
    const content = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'id'));
    if (sha256(encoded(content)) !== id) {
      throw new OperationLogError('corrupt', `Operation content does not match its id: ${id}`);
    }
    return parsed;
  }

  private async readView(id: string): Promise<OperationView> {
    const raw = await this.readRaw(this.viewPath(id));
    if (raw === undefined)
      throw new OperationLogError('not-found', `Operation view not found: ${id}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new OperationLogError('corrupt', `Operation view is not valid JSON: ${id}`);
    }
    if (!isOperationView(parsed) || sha256(raw) !== id) {
      throw new OperationLogError('corrupt', `Operation view content does not match its id: ${id}`);
    }
    return {
      tree: parsed.tree,
      head: parsed.head,
      refs: parsed.refs,
      indexTree: parsed.indexTree,
      ...(parsed.unfinishedOperation === undefined
        ? {}
        : { unfinishedOperation: parsed.unfinishedOperation }),
    };
  }

  private operationPath(id: string): string {
    assertId(id);
    return join(this.operationsDir, id.slice(0, 2), `${id}.json`);
  }

  private viewPath(id: string): string {
    assertId(id);
    return join(this.viewsDir, id.slice(0, 2), `${id}.json`);
  }

  private async readRaw(path: string): Promise<string | undefined> {
    try {
      return await Bun.file(path).text();
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async fileSize(path: string): Promise<number> {
    const info = await stat(path);
    return info.size;
  }

  private async readdirSafe(path: string): Promise<readonly string[]> {
    try {
      return await readdir(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  private async writeImmutable(path: string, raw: string): Promise<void> {
    const existing = await this.readRaw(path);
    if (existing !== undefined) {
      if (existing !== raw)
        throw new OperationLogError('corrupt', `Immutable object differs: ${path}`);
      return;
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true }).catch(() => null);
    }
  }

  private async writeAtomic(path: string, raw: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true }).catch(() => null);
    }
  }

  private async withLock<T>(run: () => Promise<T>): Promise<T> {
    const previous = localLocks.get(this.root) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    localLocks.set(this.root, tail);
    await previous;
    try {
      return await this.withFileLock(run);
    } finally {
      release();
      if (localLocks.get(this.root) === tail) localLocks.delete(this.root);
    }
  }

  private async withFileLock<T>(run: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, '.lock');
    const token = randomUUID();
    try {
      await writeFile(path, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      const age = await stat(path)
        .then((info) => Date.now() - info.mtimeMs)
        .catch(() => 0);
      if (age <= LOCK_STALE_MS) {
        throw new OperationLogError('busy', 'Operation log is locked by another process');
      }
      await unlink(path);
      await writeFile(path, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }
    const heartbeat = setInterval(() => {
      const at = new Date();
      void utimes(path, at, at).catch(() => null);
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      return await run();
    } finally {
      clearInterval(heartbeat);
      const owner = await this.readRaw(path).catch(() => null);
      if (owner === token) await rm(path, { force: true });
    }
  }
}
