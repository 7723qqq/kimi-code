/**
 * `sessionIndex` domain (L2) — session index contract.
 *
 * `ISessionIndex` is a domain-specific persistence Store: it knows how to
 * locate and enumerate session directories under a `sessionsRoot`. Business
 * code depends on `ISessionIndex` rather than touching the filesystem directly.
 * Backends are deployment-specific (local filesystem today; database on a
 * server).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionIndex {
  readonly _serviceBrand: undefined;
  /** Absolute directory for a given session under `sessionsRoot`. */
  sessionDir(sessionsRoot: string, workDir: string, sessionId: string): string;
  /** Stable workspace id (the `wd_<slug>_<hash>` key) derived from a work dir. */
  workspaceIdFor(workDir: string): string;
  /** Count non-archived session directories for a work dir under `sessionsRoot`. */
  countActive(sessionsRoot: string, workDir: string): Promise<number>;
}

export const ISessionIndex: ServiceIdentifier<ISessionIndex> =
  createDecorator<ISessionIndex>('sessionIndex');
