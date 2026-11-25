import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';

import { FileStorageService as CoreFileStorageService } from '@moonshot-ai/core/store/backend/node';
import { join } from 'pathe';

import type {
  IFileSystemStorageService,
  StorageListOptions,
} from '#/persistence/interface/storage';
import { toStorageIoError } from '#/persistence/interface/storage';

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function collectFileKeys(dir: string, relativeDir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const keys: string[] = [];
  for (const entry of entries) {
    const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      keys.push(...(await collectFileKeys(join(dir, entry.name), relative)));
      continue;
    }
    keys.push(relative);
  }
  return keys;
}

export class FileStorageService
  extends CoreFileStorageService
  implements IFileSystemStorageService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly rootDir: string,
    dirMode?: number,
    fileMode?: number,
  ) {
    super(rootDir, dirMode, fileMode, toStorageIoError);
  }

  override async list(
    scope: string,
    prefix?: string,
    options: StorageListOptions = {},
  ): Promise<readonly string[]> {
    if (options.recursive !== true) return super.list(scope, prefix);
    const scopePath = join(this.rootDir, scope);
    let keys: readonly string[];
    try {
      keys = await collectFileKeys(scopePath, '');
    } catch (error) {
      if (isEnoent(error)) return [];
      throw toStorageIoError(error, { path: scopePath, op: 'list' });
    }
    return prefix === undefined ? keys : keys.filter((key) => key.startsWith(prefix));
  }
}
