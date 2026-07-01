/**
 * `terminal` domain (L6) — default `ISessionTerminalBackend` stub.
 *
 * Placeholder backend registered so the binding graph is complete and
 * `ISessionTerminalService` resolves out of the box. It cannot spawn a real PTY; a
 * composition root that needs interactive terminals (for example the server
 * or the desktop app, both of which already depend on `node-pty`) supplies a
 * real backend through the scope registry to override this one.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { NotImplementedError } from '#/_base/errors';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { type TerminalProcess, type TerminalSpawnOptions, ISessionTerminalBackend } from './terminal';

export class SessionNotImplementedTerminalBackend implements ISessionTerminalBackend {
  declare readonly _serviceBrand: undefined;

  spawn(_options: TerminalSpawnOptions): Promise<TerminalProcess> {
    throw new NotImplementedError('terminalBackend');
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionTerminalBackend,
  SessionNotImplementedTerminalBackend,
  InstantiationType.Delayed,
  'terminal',
);
