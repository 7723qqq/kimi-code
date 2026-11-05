import { join } from 'node:path';

import { HostFileSystem, type IHostFileSystem } from '@moonshot-ai/agent-core-v2';

export function mappingHostFs(remoteRoot: string): IHostFileSystem {
  const inner = new HostFileSystem();
  const relative = (path: string): string =>
    path.replace(/^[A-Za-z]:/, '').replace(/^[/\\]+/, '');
  const map = (path: string): string => join(remoteRoot, relative(path));
  const unmap = (path: string): string => {
    const normalized = path.replaceAll('\\', '/');
    const root = remoteRoot.replaceAll('\\', '/');
    if (normalized === root) return '/';
    return normalized.startsWith(`${root}/`) ? normalized.slice(root.length) : path;
  };
  return {
    _serviceBrand: undefined,
    readText: (path, options) => inner.readText(map(path), options),
    writeText: (path, data) => inner.writeText(map(path), data),
    appendText: (path, data) => inner.appendText(map(path), data),
    readBytes: (path, n, offset) => inner.readBytes(map(path), n, offset),
    writeBytes: (path, data) => inner.writeBytes(map(path), data),
    readLines: (path, options) => inner.readLines(map(path), options),
    createExclusive: (path, data) => inner.createExclusive(map(path), data),
    stat: (path) => inner.stat(map(path)),
    lstat: (path) => inner.lstat(map(path)),
    readdir: (path) => inner.readdir(map(path)),
    mkdir: (path, options) => inner.mkdir(map(path), options),
    remove: (path) => inner.remove(map(path)),
    realpath: async (path) => unmap(await inner.realpath(map(path))),
  };
}
