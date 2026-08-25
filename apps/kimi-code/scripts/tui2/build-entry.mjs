// apps/kimi-code/scripts/tui2/build-entry.mjs
//
// Bundle the tui2 opentui entry into a standalone Bun single-file binary
// (`bun build --compile`). Distribution option A for the tui2 migration:
// tui2 renders only under Bun (Node lacks node:ffi), so the v2 shell ships
// as its own binary alongside the Node SEA build.
//
//   node scripts/tui2/build-entry.mjs          # default: dist/tui2/tui2-entry[.exe]
//   node scripts/tui2/build-entry.mjs --outfile dist/tui2/kimi-tui2
//
// The solid transform MUST be applied at build time: opentui/solid's
// bun-plugin rewrites `solid-js/dist/server.js` to the reactive client build
// and lazifies JSX children through babel-preset-solid. Without it the
// bundled binary crashes with "Tui2StoreProvider missing" (providers mount
// before their consumers). `bunfig.toml` preload only covers `bun run`,
// not `bun build`, so the plugin is passed explicitly here.
//
// Success prints the output path; the binary replies to the boot check with
// `TUI2_ENTRY_BOOT_OK`.

import { resolve } from 'node:path';

import { fileURLToPath } from 'node:url';

const appRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const srcEntry = resolve(appRoot, 'src/tui2/entry.tsx');
const outfile = process.argv.includes('--outfile')
  ? resolve(appRoot, process.argv[process.argv.indexOf('--outfile') + 1])
  : resolve(appRoot, 'dist/tui2/tui2-entry');

const ext = process.platform === 'win32' ? '.exe' : '';
const output = `${outfile}${ext}`;

const solidPlugin = (await import('@opentui/solid/bun-plugin')).default;

await Bun.build({
  entrypoints: [srcEntry],
  target: 'bun',
  outfile: output,
  compile: true,
  plugins: [solidPlugin],
});

process.stdout.write(`TUI2 entry bundled to ${output}\n`);
