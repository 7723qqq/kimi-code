import { join } from 'node:path';

import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk/runtime';
import { app } from 'electron';

import {
  asBrowserRunRequest,
  describeInvalidBrowserRunRequest,
} from '../../shared/browser-automation';
import { DESKTOP_DISPLAY_NAME, DESKTOP_REPLY_STYLE_GUIDE } from '../../shared/identity';
import { resolveDesktopHostIdentity } from '../app/identity';
import { browserAgentControl, browserSubagentControl } from '../browser/browser-agent-control';
import {
  collectBrowserDialogReminder,
  forgetSessionBrowserDialogs,
  isAgentLocalFileAddress,
  runBrowserAutomation,
} from '../browser/browser-automation';
import { revokeBrowserSubagentRun, restoreBrowserSubagentRuns } from '../browser/browser-control';
import { formatBrowserToolResult } from '../browser/browser-tool-output';
import { log } from '../diagnostics/log';
import { createRendererLogWriter, sanitizeRendererLogMessage } from '../diagnostics/renderer-log';
import { wireDesktopTelemetry } from '../diagnostics/telemetry';
import { trySendDesktopEvent } from '../diagnostics/track';
import { BunBackend, resolveBackendLaunch } from './bun-backend';
import { BunBrowserBridge } from './bun-browser';
import { desktopServerSecret } from './server-auth';
import { serverLogPayload } from './server-log';

export interface DesktopServerHandle {
  readonly origin: string;
  readonly port: number;
  readonly connected?: boolean;
  readonly shutdownTelemetry: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface StartDesktopServerOptions {
  readonly webAssetsDir?: string;
  readonly extraCorsOrigins?: readonly string[];
  readonly debugEndpoints?: boolean;
  readonly signal?: AbortSignal;
  readonly onDisconnect?: () => void;
}

export async function startDesktopServer(
  opts: StartDesktopServerOptions,
): Promise<DesktopServerHandle> {
  opts.signal?.throwIfAborted();
  const homeDir = resolveKimiHome();
  const host = resolveDesktopHostIdentity(homeDir);
  const secret = desktopServerSecret();
  const browserMcpTestToken = opts.debugEndpoints
    ? process.env['KIMI_BROWSER_MCP_TEST_TOKEN']
    : undefined;
  const launch = resolveBackendLaunch({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    bunPath: process.env['KIMI_DESKTOP_BUN_PATH'],
  });
  const diagnostic = createRendererLogWriter(undefined, undefined, 'server');
  const backend = new BunBackend(
    launch,
    (line) => {
      const payload = serverLogPayload(line);
      if (payload !== null) diagnostic(payload);
      else if (line.trim() !== '')
        log.info(`[kimi-desktop] backend: ${sanitizeRendererLogMessage(line)}`);
    },
    [secret, browserMcpTestToken ?? ''],
  );
  backend.channel.onDisconnect(() => opts.onDisconnect?.());
  const browser = new BunBrowserBridge(
    backend.channel,
    browserAgentControl,
    browserSubagentControl,
    {
      execute: async ({ args, sessionId, controller }, signal, assertActive, validateActive) => {
        assertActive();
        const input = asBrowserRunRequest(args, { isLocalFileAddress: isAgentLocalFileAddress });
        if (input === null)
          return {
            operation: 'unknown',
            errorCode: 'INVALID_ARGS',
            text: describeInvalidBrowserRunRequest(args, {
              isLocalFileAddress: isAgentLocalFileAddress,
            }),
          };
        const run = controller === undefined ? undefined : { ...controller, assertActive };
        const result = await runBrowserAutomation(
          input,
          signal,
          sessionId,
          run,
          assertActive,
          validateActive,
        );
        assertActive();
        const image = result.visual ?? result.crop;
        return {
          operation: result.operation,
          errorCode: result.ok ? undefined : (result.error?.code ?? 'INTERNAL_ERROR'),
          text: formatBrowserToolResult(result),
          image,
        };
      },
      collect: async (sessionId) => (await collectBrowserDialogReminder(sessionId)) ?? null,
      forget: forgetSessionBrowserDialogs,
      revoke: (sessionId, run, settingChange) =>
        revokeBrowserSubagentRun(sessionId, run, settingChange ? 'ipc' : undefined),
      restore: restoreBrowserSubagentRuns,
      operation: (payload) => trySendDesktopEvent('browser_operation_result', payload),
      reconnect: (payload) => trySendDesktopEvent('browser_mcp_reconnect', payload),
    },
  );
  let telemetry: Awaited<ReturnType<typeof wireDesktopTelemetry>> | undefined;
  try {
    const workerDir = app.isPackaged
      ? join(process.resourcesPath, 'bun-backend')
      : join(app.getAppPath(), 'src', 'backend');
    const ready = await backend.start(
      {
        homeDir,
        webAssetsDir: opts.webAssetsDir,
        searchWorkerPath: join(
          workerDir,
          app.isPackaged ? 'search-worker.mjs' : 'search-worker.ts',
        ),
        textBuildWorkerPath: join(
          workerDir,
          app.isPackaged ? 'text-build-worker.mjs' : 'text-build-worker.ts',
        ),
        serverVersion: __KIMI_CORE_VERSION__,
        hostIdentity: {
          ...host.identity,
          displayName: DESKTOP_DISPLAY_NAME,
          replyStyleGuide: DESKTOP_REPLY_STYLE_GUIDE,
        },
        deviceId: host.deviceId,
        authSecret: secret,
        devOrigin: opts.extraCorsOrigins?.[0],
        debugEndpoints: opts.debugEndpoints === true,
        browserMcpTestToken,
        browser: browser.settings,
      },
      opts.signal,
    );
    browser.activate();
    telemetry = await wireDesktopTelemetry(backend.channel, ready.telemetry).catch(() => {
      log.error('[kimi-desktop] telemetry host wiring failed');
      return undefined;
    });
    if (!backend.connected) throw new Error('Desktop Bun backend disconnected during startup');
    log.info(`[kimi-desktop] Bun backend runtime ${ready.runtime.version}`);
    log.info(
      `[kimi-desktop] Browser MCP listening on http://127.0.0.1:${ready.browserMcpPort}/mcp`,
    );
    log.info(`[kimi-desktop] embedded server listening on ${ready.origin}`);
    let closing: Promise<void> | undefined;
    return {
      origin: ready.origin,
      port: ready.port,
      get connected() {
        return backend.connected;
      },
      shutdownTelemetry: () => telemetry?.shutdown() ?? Promise.resolve(),
      close: () =>
        (closing ??= (async () => {
          browser.dispose();
          try {
            await telemetry?.shutdown();
          } finally {
            await backend.close();
          }
        })()),
    };
  } catch (error) {
    browser.dispose();
    await backend.close().catch(() => {
      log.error('[kimi-desktop] backend startup cleanup failed');
    });
    throw error;
  }
}
