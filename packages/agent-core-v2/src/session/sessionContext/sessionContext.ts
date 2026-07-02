/**
 * `sessionContext` domain (L6) — seeded per-session facts.
 *
 * Defines the `ISessionContext` carrying the session's identity and storage
 * addressing (`sessionId`, `workspaceId`, `sessionDir`, `metaScope`), seeded
 * into the Session scope by `sessionLifecycle` when the session is created.
 * Pure facts — no store, no IO. Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';

export interface ISessionContext {
  readonly _serviceBrand: undefined;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionDir: string;
  readonly metaScope: string;
}

export const ISessionContext: ServiceIdentifier<ISessionContext> =
  createDecorator<ISessionContext>('sessionContext');

export function sessionContextSeed(ctx: ISessionContext): ScopeSeed {
  return [[ISessionContext as ServiceIdentifier<unknown>, ctx]];
}
