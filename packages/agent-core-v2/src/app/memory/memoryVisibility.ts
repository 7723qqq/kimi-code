import { canonicalPath, isWindowsAbsolutePath, resolvePath } from '#/_base/utils/paths';

import {
  legacyProjectIdFromCwd,
  parseMemoryPath,
  projectIdFromCwd,
  type MemoryEntry,
} from './memoryPaths';

export interface MemoryVisibilityContext {
  readonly projectId: string;
  readonly projectAliases: readonly string[];
  readonly sessionId: string;
}

export function createMemoryVisibilityContext(
  cwd: string,
  sessionId: string,
): MemoryVisibilityContext {
  const projectId = projectIdFromCwd(cwd);
  const legacy = legacyProjectIdFromCwd(cwd);
  return {
    projectId,
    projectAliases: legacy === projectId ? [] : [legacy],
    sessionId,
  };
}

export function isMemoryVisible(
  path: string,
  context: MemoryVisibilityContext,
  metadata?: Pick<MemoryEntry, 'scope' | 'scopeId'>,
): boolean {
  if (path.includes('\\') || path.includes('\0')) return false;
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..')) return false;
  const parsed = parseMemoryPath(path);
  if (parsed === undefined) return false;
  if (
    metadata !== undefined &&
    (metadata.scope !== parsed.scope || metadata.scopeId !== parsed.scopeId)
  )
    return false;
  if (parsed.scope === 'global') return true;
  if (parsed.scope === 'session') return parsed.scopeId === context.sessionId;
  return parsed.scopeId === context.projectId || context.projectAliases.includes(parsed.scopeId);
}

function withinPath(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

function comparisonPath(base: string, value: string, windows: boolean): string {
  const resolved = resolvePath(base, value).replaceAll('\\', '/');
  const normalized = resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
  return windows ? normalized.toLowerCase() : normalized;
}

export function knowledgeScopeApplies(
  storedScope: string | null | undefined,
  projectRoot: string,
  requestedPath?: string,
): boolean {
  if (storedScope === null || storedScope === undefined || storedScope.trim().length === 0)
    return true;
  if (!projectRoot || storedScope.includes('\0') || requestedPath?.includes('\0')) return false;
  const windows = isWindowsAbsolutePath(projectRoot);
  if (
    !windows &&
    (isWindowsAbsolutePath(storedScope) ||
      (requestedPath !== undefined && isWindowsAbsolutePath(requestedPath)))
  )
    return false;
  const root = canonicalPath(projectRoot);
  const candidate = comparisonPath(root, requestedPath ?? '.', windows);
  const scope = comparisonPath(root, storedScope, windows);
  return withinPath(candidate, comparisonPath(root, '.', windows)) && withinPath(candidate, scope);
}
