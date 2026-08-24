import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { bunAssets } from './bun-assets.gen';

const assets: Record<string, string> = {};
for (const [key, path] of bunAssets) {
  assets[key] = path;
}
(
  globalThis as unknown as { __KIMI_BUN_ASSETS__?: Record<string, string> }
).__KIMI_BUN_ASSETS__ = assets;

const mainAsset = bunAssets.find(([key]) => key === 'runtime/main.cjs');
if (mainAsset === undefined) {
  throw new Error('Bun bundle is missing the runtime/main.cjs asset');
}
// Extract to a content-addressed path instead of a per-launch temp dir, so
// repeated launches refresh one copy in place rather than leaking a new one.
const bytes = readFileSync(mainAsset[1]);
const dir = join(tmpdir(), 'kimi-bun-main');
mkdirSync(dir, { recursive: true });
const mainPath = join(dir, `${createHash('sha256').update(bytes).digest('hex')}.cjs`);
const tempPath = `${mainPath}.${process.pid}.tmp`;
writeFileSync(tempPath, bytes);
try {
  renameSync(tempPath, mainPath);
} catch {
  // The target is content-addressed: whoever holds it serves the same bytes.
  rmSync(tempPath, { force: true });
}
// Best-effort sweep of superseded extractions from previous versions. Only
// files untouched for over a day are removed: anything younger may be the
// in-flight extraction of a concurrently starting older binary, and a process
// already running never re-reads its main.cjs from disk.
try {
  const staleGraceMs = 24 * 60 * 60 * 1000;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.cjs') || entry === basename(mainPath)) continue;
    const candidate = join(dir, entry);
    try {
      if (Date.now() - statSync(candidate).mtimeMs > staleGraceMs) {
        rmSync(candidate, { force: true });
      }
    } catch {
      // Unlink races and platform locks are fine to lose — this is hygiene.
    }
  }
} catch {
  // A missing or unreadable sweep directory must never block startup.
}
// No top-level await here: bytecode builds (KIMI_CODE_BUN_ENABLE_BYTECODE=1)
// use Bun's default CommonJS output, which cannot express it; top-level await
// works only with explicit `--format=esm` (supported since Bun 1.3.9). A
// pending dynamic import still keeps the process alive until the imported
// main finishes starting.
async function bootstrap() {
  await import(pathToFileURL(mainPath).href);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
