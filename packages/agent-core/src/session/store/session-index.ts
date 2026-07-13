import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'pathe';

export interface SessionIndexEntry {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

// Per-homeDir append chain. Within one process, concurrent index appends are
// serialized so two lines can never be interleaved at the filesystem layer.
// Cross-process, a single short line written with O_APPEND is atomic on POSIX
// (well under PIPE_BUF), so this closes the realistic same-process tearing gap
// without taking a file lock. A failed append is reported to its caller but does
// not poison the chain for later appends.
const appendQueues = new Map<string, Promise<void>>();

// ── mtime-based in-memory cache ─────────────────────────────────────────────
// The index file is append-only, so `readSessionIndex` can cache the parsed
// Map keyed by homeDir and invalidate it only when the file's mtime changes.
// Without this, every get()/create()/fork()/rename()/archive() call re-reads
// and re-parses the entire JSONL from disk.
interface IndexCacheEntry {
  readonly mtimeMs: number;
  readonly index: Map<string, SessionIndexEntry>;
}
const indexCache = new Map<string, IndexCacheEntry>();

export function sessionIndexPath(homeDir: string): string {
  return join(homeDir, 'session_index.jsonl');
}

export async function appendSessionIndexEntry(
  homeDir: string,
  entry: SessionIndexEntry,
): Promise<void> {
  const indexPath = sessionIndexPath(homeDir);
  const line = `${JSON.stringify(entry)}\n`;
  const previous = appendQueues.get(homeDir) ?? Promise.resolve();
  const next = previous.then(async () => {
    await mkdir(dirname(indexPath), { recursive: true, mode: 0o700 });
    await appendFile(indexPath, line, 'utf-8');
    // Invalidate the cache: the file's mtime has changed, so the next
    // `readSessionIndex` will re-read and re-parse.
    indexCache.delete(homeDir);
  });
  appendQueues.set(homeDir, next.then(() => undefined, () => undefined));
  return next;
}

export async function readSessionIndex(
  homeDir: string,
  sessionsDir: string,
): Promise<Map<string, SessionIndexEntry>> {
  const indexPath = sessionIndexPath(homeDir);

  // Check mtime first — if the file hasn't changed since the last parse, the
  // cached Map is still valid and we skip the read + JSON.parse entirely.
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(indexPath)).mtimeMs;
  } catch {
    // File doesn't exist (or is unreadable) — clear any stale cache and return
    // an empty Map.
    indexCache.delete(homeDir);
    return new Map();
  }

  const cached = indexCache.get(homeDir);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) {
    // Return a shallow copy so callers that mutate the Map (e.g. `reindex()`
    // calls `index.set(...)`) don't corrupt the cached entry.
    return new Map(cached.index);
  }

  let raw: string;
  try {
    raw = await readFile(indexPath, 'utf-8');
  } catch {
    return new Map();
  }

  const result = new Map<string, SessionIndexEntry>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const entry = parseIndexLine(trimmed);
    if (entry === undefined) continue;
    const sessionDir = resolve(entry.sessionDir);
    if (!isAbsolute(entry.sessionDir)) continue;
    if (!isPathInside(sessionsDir, sessionDir)) continue;
    if (basename(sessionDir) !== entry.sessionId) continue;
    // `workDir` is no longer authoritative: summaries prefer the workDir stored
    // in each session's self-describing state.json, so a stale or relocated
    // index workDir must not drop an otherwise valid entry.
    result.set(entry.sessionId, {
      sessionId: entry.sessionId,
      sessionDir,
      workDir: entry.workDir,
    });
  }

  indexCache.set(homeDir, { mtimeMs, index: result });
  // Return a copy so callers that mutate the Map (e.g. `reindex()`) don't
  // corrupt the cached entry — same pattern as the cache-hit path above.
  return new Map(result);
}

function parseIndexLine(line: string): SessionIndexEntry | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const entry = parsed as Partial<SessionIndexEntry>;
    if (
      typeof entry.sessionId !== 'string' ||
      typeof entry.sessionDir !== 'string' ||
      typeof entry.workDir !== 'string'
    ) {
      return undefined;
    }
    return {
      sessionId: entry.sessionId,
      sessionDir: entry.sessionDir,
      workDir: entry.workDir,
    };
  } catch {
    return undefined;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
