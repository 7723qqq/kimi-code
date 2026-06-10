import { cp, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '../..');
const require = createRequire(import.meta.url);
const source = resolve(repoRoot, 'apps/kimi-web/dist');
const target = resolve(appRoot, 'dist-web');
const swaggerUiSource = resolve(
  dirname(require.resolve('@fastify/swagger-ui/package.json', {
    paths: [resolve(repoRoot, 'packages/daemon')],
  })),
  'static',
);
const swaggerUiTarget = resolve(appRoot, 'dist/static');

async function assertBuiltWeb() {
  try {
    const info = await stat(resolve(source, 'index.html'));
    if (!info.isFile()) {
      throw new Error('index.html is not a file');
    }
  } catch {
    throw new Error(
      `Kimi web build output was not found at ${source}. Run \`pnpm --filter @moonshot-ai/kimi-web run build\` first.`,
    );
  }
}

await assertBuiltWeb();
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
await rm(swaggerUiTarget, { recursive: true, force: true });
await cp(swaggerUiSource, swaggerUiTarget, { recursive: true });

console.log(`Copied Kimi web assets to ${target}`);
console.log(`Copied Swagger UI assets to ${swaggerUiTarget}`);
