/**
 * `IFsWatcher` — daemon-OWN filesystem watcher (W12 / Chain 14, P1.14).
 *
 * **Responsibility**: maintain one `chokidar.FSWatcher` per active session,
 * accept dynamic `subscribe.watch_fs` / `watch_fs_add` / `watch_fs_remove`
 * mutations from WS connections, coalesce raw chokidar events into the
 * `event.fs.changed` wire shape (WS.md §4.9), and push each coalesced
 * frame ONLY to the connections whose subscribed paths overlap the
 * affected paths (WS.md §5 last row: "仅推给 watch_fs 内 path 与变更
 * path 有交集的连接").
 *
 * **Daemon-OWN distinction**: like `IFsService` / `IFsSearchService` /
 * `IFsGitService`, this service is NOT a thin wrapper around an
 * `IHarnessBridge` call. agent-core has no fs-watch surface; the wire path
 * directly addresses `session.metadata.cwd` and is implemented against
 * Node `fs` + `chokidar`. So it lives in `packages/daemon`, NOT in
 * `@moonshot-ai/services`.
 *
 * # Architecture (per W12 prompt §critical-design-questions)
 *
 *   - Per-session `chokidar.FSWatcher` instance.
 *     - Lazily created on first `addPaths(sessionId, ...)`.
 *     - Closed (and entry dropped) when no connection has any path subscribed
 *       for that session (`session.paths.size === 0`).
 *   - Per-session 200ms debounce window collecting raw events.
 *     - Inside the window: at most `MAX_CHANGES_PER_WINDOW` (500) per-entry
 *       changes accumulate before we flip to truncated-mode (WS.md §4.9
 *       `truncated:true` + `count`; ROADMAP Chain 14 AC #2).
 *   - Per-connection state:
 *     - `Map<connectionId, Map<sessionId, Set<absolutePath>>>` for the
 *       overlap filter AND for the 100-path cap enforcement
 *       (`MAX_PATHS_PER_CONNECTION`).
 *   - Per-session aggregate state:
 *     - `Map<sessionId, { watcher, paths: Map<absolutePath, refCount>,
 *                          pending: PendingWindow }>`.
 *     - `refCount` is the number of connections that have asked for this
 *       path. We `chokidar.add(path)` on first ref and `chokidar.unwatch(path)`
 *       on last unref.
 *   - Path safety: every input path runs through W10's `resolveSafePath`
 *     BEFORE chokidar sees it. We propagate `FsPathEscapesError` so the WS
 *     adapter can translate to a `41304` error frame (today the WS path
 *     uses 42902 for over-cap; we surface 41304-bearing errors via the
 *     same error throw).
 *
 * # Wire path
 *
 *   1. `WsConnection.onSubscribe` / `onWatchFsAdd` / `onWatchFsRemove`
 *      → resolve `session.metadata.cwd` via `ISessionService.get(sid)`.
 *      → resolve each input path via `resolveSafePath(cwd, p)`.
 *      → check the projected per-connection total count against
 *        `MAX_PATHS_PER_CONNECTION` (100). Exceed → throw `FsWatchLimitError`.
 *      → call `IFsWatcher.addPaths(sessionId, connectionId, absPaths)`.
 *   2. chokidar emits `'all'` events.
 *      → fs-watcher pushes the (`{absPath, action, kind}`) tuple into the
 *        session's pending window. If no timer is running, schedule one
 *        for 200ms.
 *      → if the pending window has > 500 entries when a new event comes
 *        in, flip the window's `truncated` flag and stop accumulating
 *        per-entry detail (just keep counting raw events).
 *   3. Timer fires after 200ms.
 *      → for each connection subscribed to this session, filter entries
 *        whose `absPath` is under one of that connection's subscribed
 *        absPaths. If non-empty, build an `event.fs.changed` envelope and
 *        push it directly to the connection (bypassing the per-session
 *        EventBus broadcast — this is targeted push, not broadcast).
 *      → clear the pending window.
 *
 * # Why bypass the EventBus seq channel
 *
 * `DaemonEventBus.publish` is typed around agent-core's `Event` union
 * (camelCase, `sessionId` discriminator). `event.fs.changed` is a
 * daemon-OWN event with NO agent-core source. Threading it through the
 * `Event` union would force a type-system hole (we'd have to cast) and
 * — more importantly — would entangle the fs-change stream with the
 * per-session ring-buffer seq counter that downstream replay logic depends
 * on. Fs changes don't need replay-on-reconnect (clients should re-`:list`
 * on reconnect anyway, per WS.md §4.9 "truncated → re-fetch"). So we push
 * direct via the targeted connection set.
 *
 * # Errors
 *
 *   - `FsWatchLimitError` → routed to `42902 fs.watch_limit_exceeded`
 *     by the WS handler when a connection's total subscribed paths
 *     (across all sessions) would exceed 100.
 *   - `FsPathEscapesError` (from `resolveSafePath`) → bubbled up; WS
 *     handler maps to `41304 fs.path_escapes_session`.
 *   - `SessionNotFoundError` → bubbled up; WS handler maps to
 *     `40401 session.not_found`.
 *
 * # Anti-corruption
 *
 * Imports only `chokidar`, `node:fs`, `node:path`, agent-core
 * (`Disposable` + decorator), `@moonshot-ai/services` (for `ISessionService`),
 * and our own `fs-path-safety`. ZERO SDK imports.
 *
 * # Tunables exposed for tests
 *
 *   - `debounceMs` (default 200) — collapse window.
 *   - `maxChangesPerWindow` (default 500) — truncate threshold.
 *   - `maxPathsPerConnection` (default 100) — cap for 42902.
 */

import nodePath from 'node:path';

import { FSWatcher } from 'chokidar';

import {
  Disposable,
  createDecorator,
} from '@moonshot-ai/agent-core';
import { ISessionService } from '@moonshot-ai/services';
// `SessionNotFoundError` is thrown by `ISessionService.get` when the session
// doesn't exist; we let it propagate to the WS handler which maps to 40401.

import type { FsChangeEntry, FsChangeAction, FsChangeKind } from '@moonshot-ai/protocol';

import { ILogger } from './logger.js';
// `FsPathEscapesError` and `resolveSafePath` are used by the WS adapter
// in `start.ts` BEFORE calling into this service; we don't import them
// here. The watcher only sees pre-validated absolute paths.

import type { WsConnection } from '../ws/connection.js';

/* -------------------------------------------------------------------------
 * Tunable constants
 * ----------------------------------------------------------------------- */

/** WS.md §4.9 — 200ms coalesce window. */
const DEFAULT_DEBOUNCE_MS = 200;

/**
 * ROADMAP Chain 14 AC #2 — when a single window collects > this many raw
 * change events, we flip to `truncated:true` mode and stop accumulating
 * per-entry detail. The client is expected to throw away local fs state
 * and re-`:list` to resync. WS.md §4.9 mentions "单窗口 changes 超 500
 * 时 true" — 500 is the spec threshold.
 */
const DEFAULT_MAX_CHANGES_PER_WINDOW = 500;

/** ROADMAP Chain 14 AC #4 — per-connection total watched-path cap. */
const DEFAULT_MAX_PATHS_PER_CONNECTION = 100;

/* -------------------------------------------------------------------------
 * Error sentinels
 * ----------------------------------------------------------------------- */

/**
 * Thrown when a WS connection's projected total watched-paths count
 * (across all sessions on that connection) would exceed
 * `maxPathsPerConnection` (default 100, ROADMAP Chain 14 AC #4). The WS
 * handler maps this to envelope/ack `code: 42902 fs.watch_limit_exceeded`.
 */
export class FsWatchLimitError extends Error {
  readonly connectionId: string;
  readonly attempted: number;
  readonly limit: number;
  constructor(connectionId: string, attempted: number, limit: number) {
    super(
      `connection ${connectionId} would watch ${attempted} paths; limit is ${limit}`,
    );
    this.name = 'FsWatchLimitError';
    this.connectionId = connectionId;
    this.attempted = attempted;
    this.limit = limit;
  }
}

/* -------------------------------------------------------------------------
 * Service interface (DI decorator)
 * ----------------------------------------------------------------------- */

/**
 * `event.fs.changed` envelope built by `IFsWatcher` and consumed by the
 * targeted push path. We do NOT route this through `DaemonEventBus`
 * (it's typed for agent-core's `Event` union and threads through the
 * per-session ring-buffer seq counter). Instead we push directly to the
 * filtered connection set — `seq` here is a daemon-mint that increments
 * inside `FsWatcherService` so client deduping logic still has SOMETHING
 * to compare. Always per-session monotonic, starts at 1.
 */
export interface FsChangedFrame {
  type: 'event.fs.changed';
  seq: number;
  session_id: string;
  timestamp: string;
  payload: {
    changes: FsChangeEntry[];
    coalesced_window_ms: number;
    truncated?: boolean;
    count?: number;
  };
}

export interface IFsWatcher {
  /**
   * Add a (sessionId, paths) subscription tied to a specific connection.
   * Caller MUST have already resolved each path through `resolveSafePath`
   * to absolute. We enforce per-connection cap on the projected total
   * and throw `FsWatchLimitError` if exceeded.
   *
   * Idempotent: re-adding the same `(sessionId, connectionId, absPath)`
   * triple has no effect and does not bump the per-connection count.
   *
   * Returns the dedup'd list of absolute paths that this connection now
   * watches for the session (post-mutation).
   */
  addPaths(
    sessionId: string,
    connectionId: string,
    absPaths: readonly string[],
  ): readonly string[];

  /**
   * Remove a (sessionId, paths) subscription tied to a specific connection.
   * Idempotent. Closes the session's chokidar watcher if this leaves it
   * with no remaining subscribers.
   *
   * Returns the dedup'd list of absolute paths this connection STILL
   * watches for the session (post-mutation).
   */
  removePaths(
    sessionId: string,
    connectionId: string,
    absPaths: readonly string[],
  ): readonly string[];

  /** Total absolute paths watched on this connection across all sessions. */
  countForConnection(connectionId: string): number;

  /**
   * Drop all subscriptions for this connection across all sessions. Closes
   * any chokidar watcher whose path-set became empty. Idempotent.
   */
  forgetConnection(connectionId: string): void;

  /**
   * Look up the absolute paths this connection currently watches under
   * `sessionId`. Used by the WS ack to populate `watched_paths` (returned
   * as POSIX-relative to `session.cwd`).
   */
  watchedPaths(connectionId: string, sessionId: string): readonly string[];
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IFsWatcher = createDecorator<IFsWatcher>('IFsWatcher');

/* -------------------------------------------------------------------------
 * Connection-side delivery sink (structural)
 *
 * Mirrors the `WsConnection.send(unknown)` surface so tests can pass a
 * stub. Production wires `WsConnection` instances directly.
 * ----------------------------------------------------------------------- */

export interface FsWatcherDeliverySink {
  send(frame: FsChangedFrame): void;
}

/**
 * Lookup hook: `connectionId → FsWatcherDeliverySink`. In production, the
 * `IFsWatcher` impl walks `ISessionClientsService` to find every active
 * connection by id; in tests we inject a `Map<connectionId, sink>` stub.
 *
 * Returning `undefined` for a connectionId is treated as "connection gone"
 * — we silently skip delivery and clean up its state on the next
 * `forgetConnection` (the WS layer is responsible for calling that on
 * socket close).
 */
export interface FsWatcherConnectionLookup {
  resolve(connectionId: string): FsWatcherDeliverySink | undefined;
}

/* -------------------------------------------------------------------------
 * Internal types
 * ----------------------------------------------------------------------- */

interface PendingChange {
  /** Absolute path of the affected entry. */
  absPath: string;
  action: FsChangeAction;
  kind: FsChangeKind;
}

interface SessionEntry {
  /** Live chokidar watcher; closed + dropped on last unref. */
  watcher: FSWatcher;
  /** `sessionId.cwd` (absolute, post-realpath) for relative-path mapping. */
  cwd: string;
  /** `absPath → refCount` across all connections subscribed to this session. */
  pathRefs: Map<string, number>;
  /** `connectionId → Set<absPath>` for overlap filtering on emit. */
  connectionPaths: Map<string, Set<string>>;
  /** Accumulating changes for the current 200ms window. */
  pendingChanges: PendingChange[];
  /** Raw event count (used for `truncated.count`). */
  pendingRawCount: number;
  /** True once `pendingChanges.length > maxChangesPerWindow`. */
  truncated: boolean;
  /** Timer for the active debounce window; `undefined` between windows. */
  debounceTimer: NodeJS.Timeout | undefined;
  /** Per-session seq counter, monotonic, starts at 1. */
  seq: number;
}

/* -------------------------------------------------------------------------
 * Implementation
 * ----------------------------------------------------------------------- */

export interface FsWatcherServiceOptions {
  debounceMs?: number;
  maxChangesPerWindow?: number;
  maxPathsPerConnection?: number;
  /**
   * Factory for the underlying chokidar watcher. Injected for tests; in
   * production this defaults to `new FSWatcher({ ignoreInitial: true,
   * persistent: false, ignored: ['**\/.git/**'] })`.
   *
   * We pass `ignored` for `.git/**` because git operations (`checkout`,
   * `stash`) churn an enormous amount of inside-`.git/` noise that the
   * client doesn't care about (WS.md §4.9 实现要点: "daemon 不 emit
   * `.git/` 内部变化").
   */
  watcherFactory?: () => FSWatcher;
}

export class FsWatcherService extends Disposable implements IFsWatcher {
  private readonly debounceMs: number;
  private readonly maxChangesPerWindow: number;
  private readonly maxPathsPerConnection: number;
  private readonly makeWatcher: () => FSWatcher;
  private readonly sessions = new Map<string, SessionEntry>();
  /** `connectionId → Map<sessionId, Set<absPath>>`. */
  private readonly connections = new Map<string, Map<string, Set<string>>>();

  constructor(
    // P2.6: VSCode-style static-first / services-last. `lookup` is a
    // closure built at start.ts so it stays a positional static dep;
    // `options` is the config bag. `logger` + `_sessionService` are
    // auto-injected via @ILogger / @ISessionService. The
    // `_sessionService` parameter is intentionally unused (reserved to
    // lock construction order so IFsWatcher disposes BEFORE
    // ISessionService — see field doc above) — the leading underscore
    // keeps the linter quiet.
    private readonly lookup: FsWatcherConnectionLookup,
    options: FsWatcherServiceOptions,
    @ILogger private readonly logger: ILogger,
    @ISessionService _sessionService: ISessionService,
  ) {
    super();
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxChangesPerWindow =
      options.maxChangesPerWindow ?? DEFAULT_MAX_CHANGES_PER_WINDOW;
    this.maxPathsPerConnection =
      options.maxPathsPerConnection ?? DEFAULT_MAX_PATHS_PER_CONNECTION;
    this.makeWatcher =
      options.watcherFactory ??
      (() =>
        new FSWatcher({
          ignoreInitial: true,
          persistent: false,
          // WS.md §4.9: filter `.git/` noise. Regex matches a `.git` segment
          // anywhere in the absolute path.
          ignored: (p: string) => /(?:^|[/\\])\.git(?:$|[/\\])/.test(p),
        }));
  }

  addPaths(
    sessionId: string,
    connectionId: string,
    absPaths: readonly string[],
  ): readonly string[] {
    if (this._isDisposed) return [];

    // Project the new total for this connection (assuming all `absPaths` are
    // additions). Dedup against existing first.
    const connSessions = this.getOrCreateConnection(connectionId);
    let existingForSession = connSessions.get(sessionId);
    const newlyAdded: string[] = [];
    let projectedTotal = this.countForConnection(connectionId);
    for (const abs of absPaths) {
      if (existingForSession?.has(abs)) continue;
      newlyAdded.push(abs);
      projectedTotal += 1;
    }
    if (projectedTotal > this.maxPathsPerConnection) {
      throw new FsWatchLimitError(
        connectionId,
        projectedTotal,
        this.maxPathsPerConnection,
      );
    }
    if (newlyAdded.length === 0) {
      // Nothing to do; return current set.
      return existingForSession ? Array.from(existingForSession) : [];
    }

    // Lazy-create session entry. cwd is best-effort: we trust the caller
    // resolved absPaths against the session's real cwd, so any one of
    // the absPaths' shared prefix would do — but we don't have the cwd
    // in hand here. The caller is expected to pre-call
    // `bindSessionCwd` (see `_bindCwd` below) OR the lookup callback
    // will pass it on first add. We use the longest absolute-path
    // segment that is a prefix of all absPaths; failing that, fall back
    // to the first absPath's dirname. This is only used for
    // wire-path conversion at emit time and the WS handler will
    // override via `bindSessionCwd` before any emit can happen.
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = this.createSessionEntry(sessionId, deriveSharedCwd(newlyAdded));
      this.sessions.set(sessionId, entry);
    }

    if (!existingForSession) {
      existingForSession = new Set();
      connSessions.set(sessionId, existingForSession);
    }
    const adds: string[] = [];
    for (const abs of newlyAdded) {
      existingForSession.add(abs);
      const ref = entry.pathRefs.get(abs) ?? 0;
      entry.pathRefs.set(abs, ref + 1);
      // Add to chokidar only on first refcount.
      if (ref === 0) {
        adds.push(abs);
      }
      // Always tracked in per-connection set.
      let cps = entry.connectionPaths.get(connectionId);
      if (!cps) {
        cps = new Set();
        entry.connectionPaths.set(connectionId, cps);
      }
      cps.add(abs);
    }
    if (adds.length > 0) {
      entry.watcher.add(adds);
    }
    return Array.from(existingForSession);
  }

  removePaths(
    sessionId: string,
    connectionId: string,
    absPaths: readonly string[],
  ): readonly string[] {
    if (this._isDisposed) return [];
    const entry = this.sessions.get(sessionId);
    if (!entry) return [];
    const connSessions = this.connections.get(connectionId);
    const connSessionPaths = connSessions?.get(sessionId);
    if (!connSessionPaths) return [];

    const unwatch: string[] = [];
    for (const abs of absPaths) {
      if (!connSessionPaths.has(abs)) continue;
      connSessionPaths.delete(abs);
      const cps = entry.connectionPaths.get(connectionId);
      cps?.delete(abs);
      if (cps && cps.size === 0) entry.connectionPaths.delete(connectionId);
      const ref = (entry.pathRefs.get(abs) ?? 1) - 1;
      if (ref <= 0) {
        entry.pathRefs.delete(abs);
        unwatch.push(abs);
      } else {
        entry.pathRefs.set(abs, ref);
      }
    }
    if (unwatch.length > 0) {
      entry.watcher.unwatch(unwatch);
    }
    // Per-connection cleanup.
    if (connSessionPaths.size === 0) {
      connSessions?.delete(sessionId);
      if (connSessions && connSessions.size === 0) {
        this.connections.delete(connectionId);
      }
    }
    // Per-session cleanup: if no path references remain, close the watcher.
    if (entry.pathRefs.size === 0) {
      this.disposeSessionEntry(sessionId, entry);
    }
    return connSessionPaths ? Array.from(connSessionPaths) : [];
  }

  countForConnection(connectionId: string): number {
    const m = this.connections.get(connectionId);
    if (!m) return 0;
    let total = 0;
    for (const set of m.values()) total += set.size;
    return total;
  }

  forgetConnection(connectionId: string): void {
    const sessionMap = this.connections.get(connectionId);
    if (!sessionMap) return;
    // Snapshot to avoid mutation-during-iteration.
    const entries = Array.from(sessionMap.entries());
    for (const [sid, paths] of entries) {
      this.removePaths(sid, connectionId, Array.from(paths));
    }
    this.connections.delete(connectionId);
  }

  watchedPaths(connectionId: string, sessionId: string): readonly string[] {
    const set = this.connections.get(connectionId)?.get(sessionId);
    if (!set) return [];
    return Array.from(set);
  }

  /**
   * WS adapter calls this AFTER resolving the session's cwd so the
   * watcher can map absolute → POSIX-relative paths on emit. Idempotent —
   * subsequent calls with a different cwd overwrite (which would be a bug
   * but we log + accept).
   */
  bindSessionCwd(sessionId: string, cwd: string): void {
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = this.createSessionEntry(sessionId, cwd);
      this.sessions.set(sessionId, entry);
      return;
    }
    if (entry.cwd !== cwd) {
      this.logger.debug(
        { sessionId, oldCwd: entry.cwd, newCwd: cwd },
        'fs-watcher cwd override',
      );
      entry.cwd = cwd;
    }
  }

  /* ------------------------------------------------------------- internals */

  private getOrCreateConnection(
    connectionId: string,
  ): Map<string, Set<string>> {
    let m = this.connections.get(connectionId);
    if (!m) {
      m = new Map();
      this.connections.set(connectionId, m);
    }
    return m;
  }

  private createSessionEntry(sessionId: string, cwd: string): SessionEntry {
    const watcher = this.makeWatcher();
    const entry: SessionEntry = {
      watcher,
      cwd,
      pathRefs: new Map(),
      connectionPaths: new Map(),
      pendingChanges: [],
      pendingRawCount: 0,
      truncated: false,
      debounceTimer: undefined,
      seq: 0,
    };
    watcher.on(
      'all',
      (eventName: string, absPath: string) => {
        this.onRawChange(sessionId, entry, eventName, absPath);
      },
    );
    watcher.on('error', (err) => {
      this.logger.warn(
        { sessionId, err: String(err) },
        'fs-watcher chokidar error',
      );
    });
    return entry;
  }

  private disposeSessionEntry(sessionId: string, entry: SessionEntry): void {
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = undefined;
    }
    void entry.watcher.close().catch((err) => {
      this.logger.warn(
        { sessionId, err: String(err) },
        'fs-watcher close failed',
      );
    });
    this.sessions.delete(sessionId);
  }

  private onRawChange(
    sessionId: string,
    entry: SessionEntry,
    eventName: string,
    absPath: string,
  ): void {
    if (this._isDisposed) return;
    const action = mapChokidarEventToAction(eventName);
    if (action === undefined) return; // 'ready', 'raw', 'all', 'error'
    const kind = mapChokidarEventToKind(eventName);

    entry.pendingRawCount += 1;
    if (entry.truncated) {
      // Already over threshold — keep counting but don't accumulate per-entry.
    } else {
      entry.pendingChanges.push({ absPath, action, kind });
      if (entry.pendingChanges.length > this.maxChangesPerWindow) {
        entry.truncated = true;
        // Drop accumulated detail to free memory; we only emit the count.
        entry.pendingChanges = [];
      }
    }

    if (entry.debounceTimer === undefined) {
      const timer = setTimeout(() => this.flushWindow(sessionId), this.debounceMs);
      // Unref so tests don't keep the loop alive on lingering windows.
      timer.unref?.();
      entry.debounceTimer = timer;
    }
  }

  private flushWindow(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.debounceTimer = undefined;
    if (entry.pendingRawCount === 0) return;
    const truncated = entry.truncated;
    const rawCount = entry.pendingRawCount;
    const pending = entry.pendingChanges;
    // Reset for next window BEFORE emit (defensive: emit could schedule a
    // synchronous re-fire if the consumer turns around and writes a file).
    entry.pendingChanges = [];
    entry.pendingRawCount = 0;
    entry.truncated = false;

    // Build per-connection filtered payload.
    for (const [connectionId, connPaths] of entry.connectionPaths) {
      const sink = this.lookup.resolve(connectionId);
      if (!sink) continue;
      let perConnChanges: FsChangeEntry[];
      if (truncated) {
        perConnChanges = [];
      } else {
        perConnChanges = [];
        for (const ch of pending) {
          if (!isUnderAny(ch.absPath, connPaths)) continue;
          const relPath = toPosixRelative(entry.cwd, ch.absPath);
          perConnChanges.push({
            path: relPath,
            change: ch.action,
            kind: ch.kind,
          });
        }
        if (perConnChanges.length === 0) continue;
      }
      entry.seq += 1;
      const frame: FsChangedFrame = {
        type: 'event.fs.changed',
        seq: entry.seq,
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          changes: perConnChanges,
          coalesced_window_ms: this.debounceMs,
          ...(truncated ? { truncated: true, count: rawCount } : {}),
        },
      };
      try {
        sink.send(frame);
      } catch (err) {
        this.logger.warn(
          { connectionId, err: String(err) },
          'fs-watcher send failed',
        );
      }
    }
  }

  override dispose(): void {
    if (this._isDisposed) return;
    const entries = Array.from(this.sessions.entries());
    for (const [sid, e] of entries) {
      this.disposeSessionEntry(sid, e);
    }
    this.connections.clear();
    super.dispose();
  }
}

/* -------------------------------------------------------------------------
 * Production-time connection lookup adapter
 *
 * Walks `ISessionClientsService` lazily to find a connection by id.
 * We can't add a `getById` to `ISessionClientsService` without breaking
 * its index invariant (sessionId → connections); instead we walk every
 * session bucket. With PLAN's "O(10) WS clients per daemon" assumption
 * this is fine. If the cardinality grows we can extend the registry.
 * ----------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
 * Helpers
 * ----------------------------------------------------------------------- */

function mapChokidarEventToAction(name: string): FsChangeAction | undefined {
  switch (name) {
    case 'add':
    case 'addDir':
      return 'created';
    case 'change':
      return 'modified';
    case 'unlink':
    case 'unlinkDir':
      return 'deleted';
    default:
      return undefined;
  }
}

function mapChokidarEventToKind(name: string): FsChangeKind {
  switch (name) {
    case 'addDir':
    case 'unlinkDir':
      return 'directory';
    // `add` / `change` / `unlink` are file events in chokidar 4. Symlinks
    // emit as `add` with no separate event; consumers that need to
    // distinguish should call `:stat`. We classify as `file` here; the
    // wire schema also accepts `symlink` but we don't generate it.
    default:
      return 'file';
  }
}

function isUnderAny(absPath: string, parents: Set<string>): boolean {
  for (const parent of parents) {
    if (absPath === parent) return true;
    // Must check with separator to avoid '/foo/bar2' under '/foo/bar'
    // false-positive. We add `path.sep` once.
    const sep = nodePath.sep;
    if (absPath.startsWith(parent + sep)) return true;
    // POSIX cross-check (some test paths may pre-canonicalize separators).
    if (sep !== '/' && absPath.startsWith(parent + '/')) return true;
  }
  return false;
}

function toPosixRelative(cwd: string, abs: string): string {
  if (abs === cwd) return '.';
  const rel = nodePath.relative(cwd, abs);
  if (rel === '') return '.';
  return rel.split(nodePath.sep).join('/');
}

function deriveSharedCwd(absPaths: readonly string[]): string {
  if (absPaths.length === 0) return '/';
  if (absPaths.length === 1) return nodePath.dirname(absPaths[0]!);
  // Common prefix path-segment walk.
  let prefix = absPaths[0]!.split(nodePath.sep);
  for (let i = 1; i < absPaths.length; i++) {
    const segs = absPaths[i]!.split(nodePath.sep);
    let j = 0;
    while (j < prefix.length && j < segs.length && prefix[j] === segs[j]) j++;
    prefix = prefix.slice(0, j);
  }
  return prefix.length === 0 ? '/' : prefix.join(nodePath.sep) || nodePath.sep;
}

/**
 * Best-effort `resolve(connectionId)` against a connection registry.
 * Caller passes a lookup function returning the live `WsConnection` for an
 * id (typically `IConnectionRegistry.get` bound).
 */
export function createConnectionLookup(
  getConnection: (connId: string) => WsConnection | undefined,
): FsWatcherConnectionLookup {
  return {
    resolve(connectionId: string): FsWatcherDeliverySink | undefined {
      const conn = getConnection(connectionId);
      if (!conn) return undefined;
      return {
        send(frame): void {
          conn.send(frame);
        },
      };
    },
  };
}

/**
 * `void`-cast for the `fsp` import — keeps the realpath-on-cwd helper
 * available if a future iteration of `IFsWatcher` wants to canonicalize
 * cwd internally (today the WS handler does it via `resolveSafePath`).
 */
