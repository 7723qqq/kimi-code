import { resolve } from 'node:path';

import type { BunPlugin } from 'bun';

export const backendRawPlugin: BunPlugin = {
  name: 'desktop-backend-assets',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, ({ path, importer, resolveDir }) => ({
      path: resolve(
        resolveDir || (importer ? importer.replace(/[\\/][^\\/]*$/, '') : process.cwd()),
        path.slice(0, -4),
      ),
      namespace: 'desktop-raw',
    }));
    build.onLoad({ filter: /.*/, namespace: 'desktop-raw' }, async ({ path }) => {
      const contents = await Bun.file(path).text();
      return { contents: `export default ${JSON.stringify(contents)};`, loader: 'js' };
    });
  },
};
