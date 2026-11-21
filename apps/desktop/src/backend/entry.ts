import { resolve } from 'node:path';
import { formatWithOptions } from 'node:util';

import { BackendChannel } from '../shared/backend-channel';
import { BackendProtocolError, BackendRequestError } from '../shared/backend-protocol';

const protocolOutput = process.stdout;
for (const name of ['log', 'info', 'debug', 'warn', 'error'] as const) {
  console[name] = (...args: unknown[]) => {
    process.stderr.write(formatWithOptions({ colors: false }, ...args) + '\n');
  };
}
const channel = new BackendChannel('bun', process.stdin, protocolOutput);
let state: 'idle' | 'starting' | 'ready' | 'closing' | 'closed' = 'idle';
let initialization: Promise<void> | undefined;
let closeRuntime: (() => Promise<void>) | undefined;
let settings: import('./browser-settings').BackendBrowserSettings | undefined;
let browserAccess: import('./browser-mcp-registration').DesktopBrowserSessionAccess | undefined;
let telemetry: Awaited<ReturnType<typeof import('./telemetry').wireBackendTelemetry>>;
let closing: Promise<void> | undefined;
const lifetime = new AbortController();

async function close(): Promise<void> {
  return (closing ??= (async () => {
    state = 'closing';
    lifetime.abort();
    await initialization?.catch(() => {});
    await closeRuntime?.();
    state = 'closed';
  })());
}

async function exit(code: number): Promise<void> {
  const watchdog = setTimeout(() => process.exit(1), 8000);
  try {
    await close();
    await channel.drain().catch(() => {});
    clearTimeout(watchdog);
    process.exit(code);
  } catch {
    console.error('[kimi-desktop] backend cleanup failed');
    clearTimeout(watchdog);
    process.exit(1);
  }
}

channel.onDisconnect(() => {
  void exit(state === 'closed' ? 0 : 1);
});
channel.on('browser.settings', (next) => {
  if (state !== 'ready' || settings === undefined)
    throw new BackendProtocolError('Desktop backend is not ready');
  settings.update(next);
});
channel.on('telemetry.record', ({ event, properties }) => {
  if (state === 'ready') telemetry?.track(event, properties);
});
channel.handle(
  'browser.validate-owner',
  ({ sessionId, owner, settingsRevision }) =>
    state === 'ready' &&
    settingsRevision === settings?.revision &&
    Boolean(browserAccess?.resolveOwner?.(sessionId, owner)),
);
channel.handle('telemetry.shutdown', async () => {
  await telemetry?.shutdown();
  return null;
});
channel.handle('telemetry.first-launch', () => telemetry?.firstLaunch() ?? false);
channel.handle('telemetry.session-count', async () => (await telemetry?.sessionCount()) ?? 0);
channel.handle('shutdown', async () => {
  await close();
  setTimeout(() => {
    void exit(0);
  }, 0);
  return null;
});
channel.handle('start', async (input, signal) => {
  if (state !== 'idle')
    throw new BackendRequestError('not_ready', 'Desktop backend startup was already requested');
  if (!process.versions.bun || process.versions.bun !== '1.4.4')
    throw new BackendRequestError('startup_failed', 'Desktop backend requires Bun 1.4.4');
  state = 'starting';
  const startup = AbortSignal.any([signal, lifetime.signal]);
  let result: import('../shared/backend-protocol').BackendOutput<'start'> | undefined;
  initialization = (async () => {
    const [
      { startServer, createServerLogger },
      { configureSearchWorkerRuntime },
      { configureTextBuildWorkerRuntime },
      { installGlobalProxyDispatcher },
      { createDesktopAuthTokenService },
      { BackendBrowserSettings },
      { startDesktopBrowserMcp },
      { createDesktopBrowserAccess, registerDesktopBrowserMcp },
      { registerDesktopBrowserDialogReminder },
      { wireBackendTelemetry },
    ] = await Promise.all([
      import('@moonshot-ai/kap-server'),
      import('@moonshot-ai/kap-server/search-worker-runtime'),
      import('@moonshot-ai/minidb/worker-runtime'),
      import('@moonshot-ai/kimi-code-sdk/proxy'),
      import('./server-auth'),
      import('./browser-settings'),
      import('./browser-mcp'),
      import('./browser-mcp-registration'),
      import('./browser-dialog-reminder'),
      import('./telemetry'),
    ]);
    startup.throwIfAborted();
    process.env['KIMI_CODE_REGION_MARKER'] = 'off';
    if (input.searchWorkerPath !== undefined)
      configureSearchWorkerRuntime(resolve(input.searchWorkerPath));
    if (input.textBuildWorkerPath !== undefined)
      configureTextBuildWorkerRuntime(resolve(input.textBuildWorkerPath));
    installGlobalProxyDispatcher();
    settings = new BackendBrowserSettings(input.browser);
    const access = createDesktopBrowserAccess(settings.agent, settings.subagent);
    browserAccess = access;
    const browser = await startDesktopBrowserMcp({
      access,
      token: input.debugEndpoints ? input.browserMcpTestToken : undefined,
      track: (payload) => {
        void channel.emit('telemetry.browser-operation', payload).catch(() => {});
      },
      execute: async (request, signal) => {
        if (state !== 'ready' || settings === undefined || !channel.connected)
          throw new BackendRequestError('closing', 'Desktop backend browser is unavailable');
        const owner =
          request.owner === undefined
            ? undefined
            : access.resolveOwner?.(request.sessionId, request.owner);
        if (request.owner !== undefined && !owner)
          throw new BackendRequestError('not_ready', 'Desktop browser owner is no longer active');
        owner?.assertActive();
        const controller = request.controller;
        const lease =
          controller === undefined
            ? undefined
            : access.resolveRun(request.sessionId, controller.run);
        if (controller !== undefined && !lease)
          throw new BackendRequestError('not_ready', 'Desktop browser run is no longer active');
        lease?.assertActive();
        return channel.request(
          'browser.run',
          { ...request, settingsRevision: settings.revision },
          { signal: AbortSignal.any([signal, lifetime.signal]), timeoutMs: 11 * 60_000 },
        );
      },
    });
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let registration: ReturnType<typeof registerDesktopBrowserMcp> | undefined;
    let reminder: ReturnType<typeof registerDesktopBrowserDialogReminder> | undefined;
    let cleanup: Promise<void> | undefined;
    closeRuntime = () =>
      (cleanup ??= (async () => {
        registration?.dispose();
        reminder?.dispose();
        const results = await Promise.allSettled([
          telemetry?.shutdown(),
          server?.close(),
          browser.close(),
        ]);
        if (results.some((result) => result.status === 'rejected'))
          throw new BackendRequestError('shutdown_failed', 'Desktop backend cleanup failed');
      })());
    try {
      startup.throwIfAborted();
      server = await startServer({
        host: '127.0.0.1',
        port: 0,
        homeDir: input.homeDir,
        logger: createServerLogger({
          level: input.debugEndpoints ? 'info' : 'warn',
          stream: process.stderr,
        }),
        webAssetsDir: input.webAssetsDir,
        env: { ...process.env, KIMI_CODE_EXPERIMENTAL_TOOL_SELECT: '1' },
        serverVersion: input.serverVersion,
        hostIdentity: input.hostIdentity,
        pluginNodeRunner: {
          command: process.execPath,
          args:
            typeof __KIMI_DESKTOP_COMPILED__ !== 'undefined' && __KIMI_DESKTOP_COMPILED__
              ? ['__desktop_plugin_entry']
              : [...process.execArgv, process.argv[1]!, '__desktop_plugin_entry'],
        },
        corsOrigins: [
          'app://renderer',
          ...(input.devOrigin === undefined ? [] : [input.devOrigin]),
        ],
        authTokenService: await createDesktopAuthTokenService(input.homeDir, input.authSecret),
        debugEndpoints: input.debugEndpoints,
      });
      startup.throwIfAborted();
      registration = registerDesktopBrowserMcp(server.core, browser.config, access, {
        restoreRuns: () => {
          void channel
            .emit('browser.restore-runs', { settingsRevision: settings?.revision ?? 0 })
            .catch(() => {});
        },
        revokeRun: (sessionId, run, settingChange) => {
          void channel
            .emit('browser.revoke-run', { sessionId, run, settingChange })
            .catch(() => {});
        },
        reconnect: (payload) => {
          void channel.emit('telemetry.browser-reconnect', payload).catch(() => {});
        },
      });
      reminder = registerDesktopBrowserDialogReminder(server.core, {
        collect: async (sessionId) =>
          (await channel.request(
            'browser.collect-dialogs',
            { sessionId },
            { signal: lifetime.signal },
          )) ?? undefined,
        forgetSession: (sessionId) => {
          void channel.emit('browser.forget-dialogs', { sessionId }).catch(() => {});
        },
      });
      telemetry = await wireBackendTelemetry(server.core, input.deviceId).catch(() => {
        console.error('[kimi-desktop] telemetry wiring failed; continuing without telemetry');
        return null;
      });
      startup.throwIfAborted();
      state = 'ready';
      result = {
        origin: `http://127.0.0.1:${server.port}`,
        port: server.port,
        browserMcpPort: new URL(browser.url).port ? Number(new URL(browser.url).port) : 0,
        runtime: { name: 'bun', version: process.versions.bun! },
        telemetry: telemetry !== null,
      };
    } catch {
      await closeRuntime();
      throw new BackendRequestError(
        'startup_failed',
        'Desktop Bun backend failed to initialize; see backend diagnostics',
      );
    }
  })();
  try {
    await initialization;
    if (result === undefined)
      throw new BackendRequestError('startup_failed', 'Desktop Bun backend did not become ready');
    return result;
  } catch (error) {
    state = 'closing';
    setTimeout(() => {
      void exit(1);
    }, 0);
    throw error;
  }
});

for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void exit(0);
  });
