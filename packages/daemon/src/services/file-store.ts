/**
 * `IFileStore` — daemon-OWN files store (W12.2 / Chain 15, P1.15).
 *
 * **Responsibility**: persist uploaded blobs under `<KIMI_CODE_HOME>/files/`
 * (defaults to `~/.kimi-code/files/`; overridable via `KIMI_CODE_HOME` env
 * or `options.homeDir`), maintain a JSON index of `FileMeta` records, and
 * serve them back by `file_id` for download / delete. Streams writes (no
 * in-memory buffering) and enforces the 50MB size cap DURING the streaming
 * write — abort on overrun, then delete the partial blob.
 *
 * **Daemon-OWN distinction**: like `IFsService` / `IFsWatcher`, the
 * store is NOT a thin wrapper around an `IHarnessBridge` call.
 * agent-core has no upload surface; the wire path directly addresses
 * the local filesystem. Lives in `packages/daemon`.
 *
 * # Storage layout
 *
 *   <homeDir>/files/<file_id>           # blob (raw bytes)
 *   <homeDir>/files/index.json          # array of FileMeta
 *
 * `homeDir` defaults to `os.homedir()/.kimi`; the WS / REST adapter
 * passes `bridgeOptions.homeDir` so tests can isolate the store under
 * a tmpdir.
 *
 * The index is read once into memory on first access (lazy) and
 * written-on-mutate. The blob file is the source of truth for bytes;
 * the index is the source of truth for metadata. If the two get out of
 * sync (e.g. a stray blob without an index entry, or vice versa) we
 * log a warning at load time and let the next mutation reconcile.
 *
 * # Errors
 *
 *   - `FileNotFoundError`  → routed to `40407 file.not_found`.
 *   - `FileTooLargeError`  → routed to `41301 file.too_large` (>50MB).
 *   - Other I/O errors    → routed to `50001 internal`.
 *
 * # Size cap (50MB) enforcement
 *
 * The route handler streams the multipart `file` field directly into
 * `fs.createWriteStream(blobPath)`. We attach a `'data'` listener that
 * tracks `bytesWritten` and aborts the write (closing both streams +
 * unlinking the partial blob) on overrun. The route translates the
 * abort signal to `FileTooLargeError`.
 *
 * # Anti-corruption
 *
 * Imports `node:fs`, `node:path`, `node:os`, `node:crypto`,
 * `node:stream/promises`, agent-core (`Disposable` + decorator), and the
 * protocol `FileMeta` type. ZERO SDK imports.
 */

import { createWriteStream, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import { ulid } from 'ulid';

import {
  Disposable,
  createDecorator,
  resolveKimiHome,
} from '@moonshot-ai/agent-core';

import type { FileMeta } from '@moonshot-ai/protocol';

import { ILogger } from './logger.js';

/* -------------------------------------------------------------------------
 * Tunable constants
 * ----------------------------------------------------------------------- */

/** REST.md §3.10 + ROADMAP Chain 15 AC #2 — upload cap (50 MB). */
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/* -------------------------------------------------------------------------
 * Error sentinels
 * ----------------------------------------------------------------------- */

/** Thrown when `file_id` doesn't exist in the index. Mapped to 40407. */
export class FileNotFoundError extends Error {
  readonly fileId: string;
  constructor(fileId: string) {
    super(`file not found: ${fileId}`);
    this.name = 'FileNotFoundError';
    this.fileId = fileId;
  }
}

/**
 * Thrown when a streaming upload would exceed `maxUploadBytes`. The
 * route layer maps this to envelope `code: 41301 file.too_large`.
 *
 * On throw, the implementation MUST have already aborted the
 * underlying writes and unlinked the partial blob — callers don't need
 * to clean up.
 */
export class FileTooLargeError extends Error {
  readonly limit: number;
  readonly seen: number;
  constructor(seen: number, limit: number) {
    super(`upload size ${seen} bytes exceeds limit ${limit} bytes`);
    this.name = 'FileTooLargeError';
    this.seen = seen;
    this.limit = limit;
  }
}

/* -------------------------------------------------------------------------
 * Service interface (DI decorator)
 * ----------------------------------------------------------------------- */

export interface SaveOptions {
  /** Daemon-side filename override (multipart `name` field). */
  name?: string;
  /** Multipart `mimetype`; defaults to `application/octet-stream`. */
  mimeType?: string;
  /** Optional expiry seconds (deferred GC — reserved for a later phase). */
  expiresInSec?: number;
}

export interface GetResult {
  meta: FileMeta;
  blobPath: string;
}

export interface IFileStore {
  /**
   * Stream `source` to disk under a fresh `file_id`. Enforces the size
   * cap during streaming; throws `FileTooLargeError` on overrun and
   * leaves NO partial blob on disk. Returns the persisted FileMeta.
   *
   * `filename` is preserved verbatim (used for `Content-Disposition`).
   */
  save(source: Readable, filename: string, options?: SaveOptions): Promise<FileMeta>;

  /**
   * Look up by `file_id`. Throws `FileNotFoundError` if absent. The
   * returned `blobPath` is suitable for `fs.createReadStream`.
   */
  get(fileId: string): Promise<GetResult>;

  /**
   * Idempotent delete. Throws `FileNotFoundError` if `file_id` is
   * not present (per REST.md §3.10 — `DELETE` returns 40407 for
   * unknown ids).
   */
  delete(fileId: string): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IFileStore = createDecorator<IFileStore>('IFileStore');

/* -------------------------------------------------------------------------
 * Implementation
 * ----------------------------------------------------------------------- */

export interface FileStoreOptions {
  /**
   * Base directory containing the `files/` subdir + `index.json`. In
   * production this is `<KIMI_CODE_HOME>` (defaults to `~/.kimi-code`);
   * tests pass a tmpdir under `~/.kimi-code-test-...`.
   */
  homeDir?: string;
  /** Override the 50 MB cap (tests set this to something tiny). */
  maxUploadBytes?: number;
}

interface IndexFile {
  version: 1;
  files: FileMeta[];
}

export class FileStoreImpl extends Disposable implements IFileStore {
  private readonly baseDir: string;
  private readonly indexPath: string;
  private readonly maxUploadBytes: number;
  private indexCache: Map<string, FileMeta> | undefined;
  private indexLoadPromise: Promise<void> | undefined;

  constructor(
    // P2.6: static-first / services-last. `options` carries `homeDir`
    // + `maxUploadBytes`; @ILogger auto-injects. The inline default on
    // options is dropped (required `@ILogger` can't follow an optional
    // param); start.ts passes `{}` explicitly when no overrides apply.
    options: FileStoreOptions,
    @ILogger private readonly logger: ILogger,
  ) {
    super();
    const home = options.homeDir ?? resolveKimiHome();
    this.baseDir = join(home, 'files');
    this.indexPath = join(this.baseDir, 'index.json');
    this.maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  }

  async save(
    source: Readable,
    filename: string,
    options: SaveOptions = {},
  ): Promise<FileMeta> {
    await this.ensureIndex();
    const fileId = `f_${ulid()}`;
    const blobPath = join(this.baseDir, fileId);

    // Track bytes during streaming to enforce the size cap. We
    // intercept on the source via `'data'`, abort the writable if the
    // limit trips, and `unlink` the partial blob in the catch path.
    let bytes = 0;
    let aborted = false;
    let abortReason: Error | undefined;

    const writable = createWriteStream(blobPath);

    source.on('data', (chunk: Buffer | string) => {
      const len = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      bytes += len;
      if (!aborted && bytes > this.maxUploadBytes) {
        aborted = true;
        abortReason = new FileTooLargeError(bytes, this.maxUploadBytes);
        // `destroy(err)` propagates the error through `pipeline`.
        source.destroy(abortReason);
      }
    });

    try {
      await pipeline(source, writable);
    } catch (err) {
      // Clean up any partial blob — best-effort, swallow ENOENT.
      try {
        await fsp.unlink(blobPath);
      } catch {
        /* ignore */
      }
      if (abortReason) throw abortReason;
      throw err;
    }

    // Re-stat to capture the final size on disk (the pipeline may have
    // counted differently if upstream re-chunked).
    const stat = await fsp.stat(blobPath);
    const meta: FileMeta = {
      id: fileId,
      name: options.name ?? filename,
      media_type: options.mimeType ?? 'application/octet-stream',
      size: stat.size,
      created_at: new Date().toISOString(),
      ...(options.expiresInSec !== undefined
        ? {
            expires_at: new Date(
              Date.now() + options.expiresInSec * 1000,
            ).toISOString(),
          }
        : {}),
    };

    this.indexCache!.set(meta.id, meta);
    await this.writeIndex();
    return meta;
  }

  async get(fileId: string): Promise<GetResult> {
    await this.ensureIndex();
    const meta = this.indexCache!.get(fileId);
    if (!meta) {
      throw new FileNotFoundError(fileId);
    }
    const blobPath = join(this.baseDir, fileId);
    // Verify the blob actually exists; if it disappeared on disk we
    // raise FileNotFoundError too (treat the missing blob as
    // equivalent to a missing id from the client's POV).
    try {
      await fsp.access(blobPath);
    } catch {
      this.logger.warn(
        { fileId },
        'file index says present but blob missing; reporting 40407',
      );
      this.indexCache!.delete(fileId);
      await this.writeIndex();
      throw new FileNotFoundError(fileId);
    }
    return { meta, blobPath };
  }

  async delete(fileId: string): Promise<void> {
    await this.ensureIndex();
    if (!this.indexCache!.has(fileId)) {
      throw new FileNotFoundError(fileId);
    }
    const blobPath = join(this.baseDir, fileId);
    this.indexCache!.delete(fileId);
    try {
      await fsp.unlink(blobPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // Restore the index entry so the next call can re-attempt.
        // We don't have the meta here; re-throw to surface as 50001.
        throw err;
      }
      // ENOENT — blob missing but index had it. Continue (we've
      // already dropped the index entry); the writeIndex below makes
      // the deletion stick.
    }
    await this.writeIndex();
  }

  /* ----------------------------------------------------------- internals */

  /**
   * Lazy index loader. Concurrency-safe (a second call before the
   * first resolves returns the same in-flight Promise).
   */
  private ensureIndex(): Promise<void> {
    if (this.indexCache !== undefined) return Promise.resolve();
    if (this.indexLoadPromise !== undefined) return this.indexLoadPromise;
    this.indexLoadPromise = this.loadIndex().finally(() => {
      this.indexLoadPromise = undefined;
    });
    return this.indexLoadPromise;
  }

  private async loadIndex(): Promise<void> {
    await fsp.mkdir(this.baseDir, { recursive: true });
    let raw: string;
    try {
      raw = await fsp.readFile(this.indexPath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // First-run: empty index.
        this.indexCache = new Map();
        return;
      }
      throw err;
    }
    let parsed: IndexFile;
    try {
      parsed = JSON.parse(raw) as IndexFile;
    } catch (err) {
      this.logger.warn(
        { err: String(err) },
        'file-store index.json malformed; starting empty',
      );
      this.indexCache = new Map();
      return;
    }
    const map = new Map<string, FileMeta>();
    if (parsed && Array.isArray(parsed.files)) {
      for (const f of parsed.files) {
        if (f && typeof f.id === 'string') {
          map.set(f.id, f);
        }
      }
    }
    this.indexCache = map;
  }

  private async writeIndex(): Promise<void> {
    const cache = this.indexCache;
    if (!cache) return;
    const payload: IndexFile = {
      version: 1,
      files: Array.from(cache.values()),
    };
    await fsp.mkdir(this.baseDir, { recursive: true });
    const tmpPath = `${this.indexPath}.tmp`;
    await fsp.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    await fsp.rename(tmpPath, this.indexPath);
  }

  override dispose(): void {
    if (this._isDisposed) return;
    this.indexCache = undefined;
    super.dispose();
  }
}
