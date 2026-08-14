// apps/kimi-web/src/composables/useFileTreeBrowser.ts
// Shared state for the workspace file tree (WorkspaceFileBrowser + recursive
// FileTreeRow). Lazy per-directory listings, expansion set, and git statuses,
// exposed through provide/inject so the recursive rows and the dialog share
// one store without prop drilling.

import { inject, provide, ref, type InjectionKey, type Ref } from 'vue';
import { getKimiWebApi } from '../api';
import type { FsEntry } from '../api/types';
import { isDaemonApiError } from '../api/errors';

export interface FileTreeBrowserStore {
  /** Loaded listings by directory relative path ('' = cwd). */
  dirCache: Ref<Map<string, FsEntry[]>>;
  /** Directories currently expanded. */
  expanded: Ref<Set<string>>;
  /** Directories whose listing is in flight. */
  loadingDirs: Ref<Set<string>>;
  /** Root load error ('' only), shown under the tree. */
  treeError: Ref<string | null>;
  /** Selected file's relative path (preview target). */
  selectedPath: Ref<string | null>;
  loadDir(dirPath: string): Promise<FsEntry[]>;
  toggleDir(entry: FsEntry): Promise<void>;
  dirChildren(dirPath: string): FsEntry[];
  isDirectory(entry: FsEntry): boolean;
  reset(): void;
}

const STORE_KEY: InjectionKey<FileTreeBrowserStore> = Symbol('fileTreeBrowserStore');

export function provideFileTreeBrowser(store: FileTreeBrowserStore): void {
  provide(STORE_KEY, store);
}

export function useFileTreeBrowser(): FileTreeBrowserStore {
  const store = inject(STORE_KEY);
  if (!store) throw new Error('useFileTreeBrowser() requires provideFileTreeBrowser()');
  return store;
}

/** Create a fresh store bound to a session id ('' root = the session cwd). */
export function createFileTreeBrowserStore(sessionId: Ref<string | undefined>): FileTreeBrowserStore {
  const dirCache = ref<Map<string, FsEntry[]>>(new Map());
  const expanded = ref<Set<string>>(new Set());
  const loadingDirs = ref<Set<string>>(new Set());
  const treeError = ref<string | null>(null);
  const selectedPath = ref<string | null>(null);

  function isDirectory(entry: FsEntry): boolean {
    return entry.kind === 'directory';
  }

  async function loadDir(dirPath: string): Promise<FsEntry[]> {
    const sid = sessionId.value;
    if (!sid) return [];
    loadingDirs.value = new Set(loadingDirs.value).add(dirPath);
    treeError.value = null;
    try {
      const result = await getKimiWebApi().listDirectory(sid, {
        path: dirPath,
        depth: 1,
        includeGitStatus: true,
      });
      const next = new Map(dirCache.value);
      next.set(dirPath, result.items);
      dirCache.value = next;
      return result.items;
    } catch (error) {
      treeError.value = isDaemonApiError(error) ? error.message : String(error);
      const next = new Map(dirCache.value);
      next.set(dirPath, []);
      dirCache.value = next;
      return [];
    } finally {
      const rest = new Set(loadingDirs.value);
      rest.delete(dirPath);
      loadingDirs.value = rest;
    }
  }

  async function toggleDir(entry: FsEntry): Promise<void> {
    const path = entry.path;
    const next = new Set(expanded.value);
    if (next.has(path)) {
      next.delete(path);
      expanded.value = next;
      return;
    }
    next.add(path);
    expanded.value = next;
    if (!dirCache.value.has(path)) {
      await loadDir(path);
    }
  }

  function dirChildren(dirPath: string): FsEntry[] {
    return dirCache.value.get(dirPath) ?? [];
  }

  function reset(): void {
    dirCache.value = new Map();
    expanded.value = new Set();
    selectedPath.value = null;
  }

  const store: FileTreeBrowserStore = {
    dirCache,
    expanded,
    loadingDirs,
    treeError,
    selectedPath,
    loadDir,
    toggleDir,
    dirChildren,
    isDirectory,
    reset,
  };
  return store;
}

/** Sort: directories first, then name (locale-aware, case-insensitive). */
export function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].toSorted((a, b) => {
    const aDir = a.kind === 'directory' ? 0 : 1;
    const bDir = b.kind === 'directory' ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  });
}

/** Whether a file row passes the name filter (directories always pass). */
export function entryPassesFilter(entry: FsEntry, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle === '') return true;
  if (entry.kind === 'directory') return true;
  return entry.name.toLowerCase().includes(needle);
}

/** Symbol legend for git statuses (M/A/D/U/??). */
export const GIT_STATUS_LABEL: Record<string, string> = {
  M: 'fileTree.gitModified',
  A: 'fileTree.gitAdded',
  D: 'fileTree.gitDeleted',
  U: 'fileTree.gitConflict',
  '??': 'fileTree.gitUntracked',
};

export function gitLabel(status: string | undefined): string | null {
  if (!status) return null;
  return GIT_STATUS_LABEL[status] ?? null;
}

export function gitClass(status: string | undefined): string {
  if (status === 'M') return 'st-modified';
  if (status === 'A') return 'st-added';
  if (status === 'D') return 'st-deleted';
  if (status === 'U') return 'st-conflict';
  return 'st-untracked';
}

/** Whether a filter is active (non-blank). */
export function isFilterActive(filter: string): boolean {
  return filter.trim() !== '';
}

// Re-export for typing convenience in consumers.
export type { FsEntry };
