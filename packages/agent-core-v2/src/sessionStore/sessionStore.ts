/**
 * `sessionStore` domain — core-scope session directory store contract.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionStore {
  readonly _serviceBrand: undefined;
  /** Absolute directory for a given session under `sessionsRoot`. */
  sessionDir(sessionsRoot: string, workDir: string, sessionId: string): string;
  /** Stable workspace id (the `wd_<slug>_<hash>` key) derived from a work dir. */
  workspaceIdFor(workDir: string): string;
  /** Count non-archived session directories for a work dir under `sessionsRoot`. */
  countActiveSessions(sessionsRoot: string, workDir: string): Promise<number>;
}

export const ISessionStore: ServiceIdentifier<ISessionStore> =
  createDecorator<ISessionStore>('sessionStore');
