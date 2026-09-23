import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { MiniDb } from '@moonshot-ai/minidb';

import { t } from '#/i18n';

import {
  getEmbeddedNativeAssetManifest,
  getNativeCacheBase,
  getNativePackageRoot,
} from './native-assets';

const smokePackages = [
  '@mariozechner/clipboard',
  '@moonshot-ai/pi-tui',
  '@moonshot-ai/kimi-agent',
];

function smokePiTuiNativeLoad(): void {
  const platform = process.platform;
  const arch = process.arch;
  let rel: string | undefined;
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    rel = join('native', 'darwin', 'prebuilds', `darwin-${arch}`, 'darwin-platform.node');
  } else if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    rel = join('native', 'linux', 'prebuilds', `linux-${arch}`, 'linux-platform-x11.node');
  } else if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) {
    rel = join('native', 'win32', 'prebuilds', `win32-${arch}`, 'win32-platform.node');
  }
  if (rel === undefined) return;

  const req = createRequire(import.meta.url);
  const helper = req(join(dirname(process.execPath), rel)) as {
    getText?: unknown;
    getImage?: unknown;
  };
  if (typeof helper.getText !== 'function' || typeof helper.getImage !== 'function') {
    throw new TypeError(`pi-tui native helper exports are unexpected: ${rel}`);
  }
}

async function smokeMinidbWorker(): Promise<void> {
  const cacheBase = getNativeCacheBase();
  mkdirSync(cacheBase, { recursive: true });
  const dir = mkdtempSync(join(cacheBase, 'minidb-smoke-'));
  let db: MiniDb<Record<string, unknown>> | null = null;
  try {
    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    const total = 4_200;
    for (let base = 0; base < total; base += 500) {
      await db.batch(
        Array.from({ length: Math.min(500, total - base) }, (_, offset) => {
          const id = base + offset;
          return {
            op: 'set' as const,
            key: `doc-${id}`,
            value: { text: `worker searchable document ${id}` },
          };
        }),
      );
    }
    await db.createTextIndex('smoke', { fields: ['text'] });
    if (db.stats.textWorkerBuilds < 1) {
      throw new Error(`MiniDb worker did not run: ${JSON.stringify(db.stats)}`);
    }
    if (db.stats.textWorkerFallbacks !== 0) {
      throw new Error(
        `MiniDb worker unexpectedly fell back: ${db.stats.lastTextWorkerFallback ?? 'unknown'}`,
      );
    }
    if (!db.search('smoke', 'searchable').some((hit) => hit.key === 'doc-0')) {
      throw new Error(t('tui.statusMessages.minidbWorkerSearchResultIncorrect'));
    }
  } finally {
    await db?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The SDK reaches the addon through `import('@moonshot-ai/kimi-agent/native')`,
 * which the native bundle inlines as a CommonJS module. When that module's
 * binding load throws, the bundler's helper caches the empty `exports` object
 * it had already allocated, so every later import in the process silently
 * resolves to `{}` — no error, just missing functions. Loading it here is the
 * only check that covers that path.
 */
async function smokeKimiAgentNativeLoad(): Promise<void> {
  const mod = (await import('@moonshot-ai/kimi-agent/native')) as { initPluginStore?: unknown };
  if (typeof mod.initPluginStore !== 'function') {
    throw new TypeError('@moonshot-ai/kimi-agent/native did not expose initPluginStore');
  }
}

async function runSmoke(): Promise<void> {
  const manifest = getEmbeddedNativeAssetManifest();
  if (manifest === null) throw new Error(t('tui.statusMessages.nativeManifestNotAvailable'));
  for (const packageName of smokePackages) {
    if (getNativePackageRoot(packageName, { manifest }) === null) {
      throw new Error(`Native package is not available: ${packageName}`);
    }
  }
  smokePiTuiNativeLoad();
  await smokeKimiAgentNativeLoad();
  await smokeMinidbWorker();
  process.stdout.write(
    `Native asset smoke passed: ${manifest.target}; MiniDb worker build passed\n`,
  );
}

export function runNativeAssetSmokeIfRequested(): boolean {
  if (process.env['KIMI_CODE_NATIVE_ASSET_SMOKE'] !== '1') return false;
  void runSmoke().then(
    () => process.exit(0),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Native asset smoke failed: ${message}\n`);
      process.exit(1);
    },
  );
  return true;
}
