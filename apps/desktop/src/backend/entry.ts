import { loadOrCreateServerToken } from '@moonshot-ai/kap-server';
import { configureSearchWorkerRuntime } from '@moonshot-ai/kap-server/search-worker-runtime';

import { DESKTOP_DISPLAY_NAME, DESKTOP_MSH_PLATFORM, DESKTOP_PRODUCT_NAME, DESKTOP_REPLY_STYLE_GUIDE } from '../shared/identity';
import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';

import { startDesktopBackend } from './desktopBackend';
import { createDesktopBrowserHostClient } from './browser/host-client';

process.env['KIMI_CODE_REGION_MARKER'] = 'off';
const searchWorker = process.env['KIMI_DESKTOP_SEARCH_WORKER'];
if (searchWorker !== undefined) configureSearchWorkerRuntime(searchWorker);
const homeDir = resolveKimiHome();
const token = process.env['KIMI_DESKTOP_TOKEN'] ?? (await loadOrCreateServerToken(homeDir));
const serverVersion = process.env['KIMI_DESKTOP_VERSION'] ?? '0.0.0';
const webAssetsDir = process.env['KIMI_DESKTOP_WEB_ASSETS'];
const debugEndpoints = process.env['KIMI_DESKTOP_DEBUG_ENDPOINTS'] === '1';
const browserHostUrl = process.env['KIMI_DESKTOP_BROWSER_HOST_URL'];
const browserHostToken = process.env['KIMI_DESKTOP_BROWSER_HOST_TOKEN'];
const browserHost = browserHostUrl !== undefined && browserHostToken !== undefined
  ? createDesktopBrowserHostClient(browserHostUrl, browserHostToken)
  : undefined;
const corsOrigins = (process.env['KIMI_DESKTOP_CORS_ORIGINS'] ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const backend = await startDesktopBackend({
  homeDir,
  token,
  webAssetsDir,
  debugEndpoints,
  serverVersion,
  corsOrigins,
  browserHost,
  telemetry: process.env['KIMI_DESKTOP_DEVICE_ID'] === undefined ? undefined : {
    deviceId: process.env['KIMI_DESKTOP_DEVICE_ID']!,
    theme: process.env['KIMI_DESKTOP_THEME'] === 'dark' ? 'dark' : 'light',
    launchId: process.env['KIMI_DESKTOP_LAUNCH_ID'] ?? '',
    releaseChannel: process.env['KIMI_DESKTOP_RELEASE_CHANNEL'] ?? '',
    locale: process.env['KIMI_DESKTOP_LOCALE'],
    firstLaunch: process.env['KIMI_DESKTOP_FIRST_LAUNCH'] === '1',
  },
  identity: {
    productName: DESKTOP_PRODUCT_NAME,
    version: serverVersion,
    platform: DESKTOP_MSH_PLATFORM,
    displayName: DESKTOP_DISPLAY_NAME,
    replyStyleGuide: DESKTOP_REPLY_STYLE_GUIDE,
  },
});

process.stdout.write(`${JSON.stringify({ type: 'ready', origin: backend.origin, port: backend.port, ...(backend.telemetry === undefined ? {} : { telemetry: backend.telemetry }), ...(backend.browserMcp === undefined ? {} : { browserMcp: backend.browserMcp }) })}\n`);

let closing = false;
async function shutdown(code: number): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await backend.close();
    browserHost?.close();
  } finally {
    process.exit(code);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(0));
}
