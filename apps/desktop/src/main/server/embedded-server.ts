import { nativeTheme } from 'electron';

import { resolveKimiHome } from '../home';

import { resolveDesktopHostIdentity } from '../app/identity';
import { markFirstLaunchReported, shouldReportFirstLaunch } from '../app/ui-state';
import { startBrowserHostBridge, type BrowserHostBridgeHandle } from '../browser/browser-host-bridge';
import { launchChannel, launchId } from '../diagnostics/log';
import { getRuntimeLocale } from '../diagnostics/track';
import { startDesktopSystemMetrics, stopDesktopSystemMetrics } from '../diagnostics/system-metrics';
import { startDesktopBackendProcess } from './backend-process';

export interface DesktopServerHandle {
  readonly origin: string;
  readonly port: number;
  readonly shutdownTelemetry: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface StartDesktopServerOptions {
  readonly webAssetsDir?: string;
  readonly extraCorsOrigins?: readonly string[];
  readonly debugEndpoints?: boolean;
  readonly logger?: unknown;
}

export async function startDesktopServer(opts: StartDesktopServerOptions): Promise<DesktopServerHandle> {
  let bridge: BrowserHostBridgeHandle | undefined;
  try {
    bridge = await startBrowserHostBridge();
    const identity = resolveDesktopHostIdentity(resolveKimiHome());
    const firstLaunch = shouldReportFirstLaunch();
    if (firstLaunch) markFirstLaunchReported();
    const backend = await startDesktopBackendProcess({
      webAssetsDir: opts.webAssetsDir,
      extraCorsOrigins: opts.extraCorsOrigins,
      debugEndpoints: opts.debugEndpoints,
      browserHost: bridge,
      telemetry: {
        deviceId: identity.deviceId,
        theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
        launchId: launchId(),
        releaseChannel: launchChannel(),
        locale: getRuntimeLocale(),
        firstLaunch,
      },
    });
    startDesktopSystemMetrics();
    return {
      origin: backend.origin,
      port: backend.port,
      shutdownTelemetry: backend.shutdownTelemetry,
      async close() {
        try {
          stopDesktopSystemMetrics();
          await backend.close();
        } finally {
          await bridge?.close();
        }
      },
    };
  } catch (error) {
    await bridge?.close().catch(() => {});
    throw error;
  }
}
