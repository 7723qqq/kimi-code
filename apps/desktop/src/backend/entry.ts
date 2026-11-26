import { loadOrCreateServerToken } from '@moonshot-ai/kap-server';
import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';

import { startDesktopBackend } from './desktopBackend';

const homeDir = resolveKimiHome();
const token = await loadOrCreateServerToken(homeDir);
const serverVersion = process.env['KIMI_DESKTOP_VERSION'] ?? '0.0.0';
const webAssetsDir = process.env['KIMI_DESKTOP_WEB_ASSETS'];
const debugEndpoints = process.env['KIMI_DESKTOP_DEBUG_ENDPOINTS'] === '1';
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
  identity: {
    productName: 'kimi-code-desktop',
    version: serverVersion,
    platform: `desktop-${process.platform}`,
  },
});

process.stdout.write(`${JSON.stringify({ type: 'ready', origin: backend.origin, port: backend.port })}\n`);

let closing = false;
async function shutdown(code: number): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await backend.close();
  } finally {
    process.exit(code);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(0));
}
