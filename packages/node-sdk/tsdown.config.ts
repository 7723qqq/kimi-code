import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  dts: false,
  outDir: 'dist',
  clean: true,
  // The build resolves `#/*` per importing package through `package.json`
  // `imports`; `tsconfig.build.json` clears the `paths` that the package
  // tsconfig needs at test time, because a project-wide alias would also
  // capture the `#/*` specifiers inside the bundled `agent-core-v2` sources.
  tsconfig: 'tsconfig.build.json',
  plugins: [rawTextPlugin()],
  banner: {
    js: [
      "import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';",
      "import { dirname as __cjsShimDirname } from 'node:path';",
      'const __filename = __cjsShimFileURLToPath(import.meta.url);',
      'const __dirname = __cjsShimDirname(__filename);',
    ].join('\n'),
  },
  alias: {
    '@moonshot-ai/kimi-code-oauth/provider-credential': fileURLToPath(
      new URL('../oauth/src/provider-credential.ts', import.meta.url),
    ),
    '@moonshot-ai/kimi-code-oauth': fileURLToPath(new URL('../oauth/src/index.ts', import.meta.url)),
    '@moonshot-ai/kosong': fileURLToPath(new URL('../kosong/src/index.ts', import.meta.url)),
  },
  deps: {
    alwaysBundle: [/^@moonshot-ai\//],
    neverBundle: [],
  },
});
