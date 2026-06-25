/**
 * `sessionMetaStore` domain — session-scope metadata persistence contract.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionMetaStore {
  readonly _serviceBrand: undefined;
  read(): Promise<Record<string, unknown>>;
  write(patch: Record<string, unknown>): Promise<void>;
  flush(): Promise<void>;
}

export const ISessionMetaStore: ServiceIdentifier<ISessionMetaStore> =
  createDecorator<ISessionMetaStore>('sessionMetaStore');
