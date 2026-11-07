import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'pathe';
import { join } from 'pathe';

import { workspaceRootKey } from '#/_base/utils/workdir-slug';

export type ProjectIdentityKind = 'git-remote' | 'git-repo' | 'path';

export interface ProjectIdentity {
  readonly kind: ProjectIdentityKind;
  readonly id: string;
  readonly detail: string;
}

interface GitLocation {
  readonly root: string;
  readonly gitDir: string;
  readonly commonDir: string;
}

function digest(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex').slice(0, 12);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readTextIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function resolveGitDir(marker: string): string | undefined {
  if (isDirectory(marker)) return marker;
  const content = readTextIfPresent(marker);
  if (content === undefined) return undefined;
  const match = /^gitdir:\s*(.+)$/m.exec(content);
  if (match === null || match[1] === undefined) return undefined;
  return resolve(dirname(marker), match[1].trim());
}

function commonDirOf(gitDir: string): string {
  const content = readTextIfPresent(join(gitDir, 'commondir'));
  if (content === undefined) return gitDir;
  const value = content.trim();
  return value.length === 0 ? gitDir : resolve(gitDir, value);
}

function findGitLocation(start: string): GitLocation | undefined {
  let dir = resolve(start);
  for (;;) {
    const marker = join(dir, '.git');
    if (existsSync(marker)) {
      const gitDir = resolveGitDir(marker);
      if (gitDir !== undefined) return { root: dir, gitDir, commonDir: commonDirOf(gitDir) };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function originUrl(commonDir: string): string | undefined {
  const config = readTextIfPresent(join(commonDir, 'config'));
  if (config === undefined) return undefined;
  let inOrigin = false;
  for (const rawLine of config.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const match = /^url\s*=\s*(.+)$/.exec(line);
    if (match !== null && match[1] !== undefined) return match[1].trim();
  }
  return undefined;
}

export function normalizeRemoteUrl(raw: string): string | undefined {
  let value = raw.trim();
  if (value.length === 0) return undefined;
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return undefined;
  const scp = /^(?:[^@/\\]+@)?([^:/\\]+):(.+)$/.exec(value);
  if (scp !== null && scp[1] !== undefined && scp[2] !== undefined && !value.includes('://')) {
    value = `${scp[1]}/${scp[2]}`;
  } else {
    value = value.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/]*@)?/, '');
  }
  value = value.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (value.length === 0) return undefined;
  const slash = value.indexOf('/');
  if (slash > 0) value = `${value.slice(0, slash).toLowerCase()}${value.slice(slash)}`;
  return value;
}

export function resolveProjectIdentity(cwd: string): ProjectIdentity {
  const location = findGitLocation(cwd);
  if (location !== undefined) {
    const url = originUrl(location.commonDir);
    const normalized = url === undefined ? undefined : normalizeRemoteUrl(url);
    if (normalized !== undefined) {
      return { kind: 'git-remote', id: digest(`git:${normalized}`), detail: normalized };
    }
    const repoKey = workspaceRootKey(location.root);
    return { kind: 'git-repo', id: digest(`repo:${repoKey}`), detail: repoKey };
  }
  const pathKey = workspaceRootKey(cwd);
  return { kind: 'path', id: digest(pathKey), detail: pathKey };
}

export function legacyProjectIdFromCwd(cwd: string): string {
  return digest(workspaceRootKey(cwd));
}
