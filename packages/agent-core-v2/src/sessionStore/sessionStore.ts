/**
 * `sessionStore` domain — core-scope session directory store contract.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionStore {
  readonly _serviceBrand: undefined;
  read(sessionId: string): Promise<unknown>;
  write(sessionId: string, data: unknown): Promise<void>;
}

export const ISessionStore: ServiceIdentifier<ISessionStore> =
  createDecorator<ISessionStore>('sessionStore');
