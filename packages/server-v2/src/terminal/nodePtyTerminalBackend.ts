/**
 * `node-pty` backed `ITerminalBackend` — server-v2 composition root.
 *
 * `agent-core-v2`'s terminal domain ships a `NotImplementedTerminalBackend`
 * stub so the binding graph is complete out of the box. That stub cannot spawn
 * a real PTY; this module supplies the real backend through the scope registry,
 * overriding the stub. Override works because `buildCollection`
 * (`agent-core-v2/src/_base/di/scope.ts`) applies scoped registrations in
 * import order and the last `set` for a given (scope, id) wins — `server-v2`
 * imports `agent-core-v2` (which registers the stub) before this module
 * registers the real backend at the same `Session` scope.
 *
 * `node-pty` is loaded lazily so merely importing this module (for example in
 * tests that override the backend with a fake) does not require the native
 * module to be built or resolvable.
 */

import {
  InstantiationType,
  ITerminalBackend,
  LifecycleScope,
  registerScopedService,
  type TerminalProcess,
  type TerminalSpawnOptions,
} from '@moonshot-ai/agent-core-v2';

export class NodePtyTerminalBackend implements ITerminalBackend {
  declare readonly _serviceBrand: undefined;

  async spawn(options: TerminalSpawnOptions): Promise<TerminalProcess> {
    const pty = await import('node-pty');
    const proc = pty.spawn(options.shell, [], {
      name: 'xterm-256color',
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      env: process.env,
    });
    return {
      onData: (listener) => proc.onData(listener),
      onExit: (listener) => proc.onExit((event) => listener({ exitCode: event.exitCode })),
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: () => proc.kill(),
    };
  }
}

registerScopedService(
  LifecycleScope.Session,
  ITerminalBackend,
  NodePtyTerminalBackend,
  InstantiationType.Delayed,
  'terminal',
);
