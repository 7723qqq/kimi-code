import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(appRoot, 'dist-web');

async function assertWebSnapshot() {
  try {
    const info = await stat(resolve(target, 'index.html'));
    if (!info.isFile()) {
      throw new Error('index.html is not a file');
    }
  } catch {
    throw new Error(
      `Embedded web snapshot was not found at ${target}. ` +
        `The web app now lives in the code-app repo. Run code-app's \`pnpm run sync:web\` ` +
        `and commit the dist-web snapshot here first.`,
    );
  }
}

await assertWebSnapshot();
console.log(`Embedded web snapshot present at ${target}`);
