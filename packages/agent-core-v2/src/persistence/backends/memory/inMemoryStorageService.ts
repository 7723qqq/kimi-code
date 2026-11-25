import { InMemoryStorageService as CoreInMemoryStorageService } from '@moonshot-ai/core/store/backend/memory';

import type {
  IFileSystemStorageService,
  StorageListOptions,
} from '#/persistence/interface/storage';

export class InMemoryStorageService
  extends CoreInMemoryStorageService
  implements IFileSystemStorageService
{
  declare readonly _serviceBrand: undefined;

  override async list(
    scope: string,
    prefix?: string,
    _options: StorageListOptions = {},
  ): Promise<readonly string[]> {
    return super.list(scope, prefix);
  }
}
