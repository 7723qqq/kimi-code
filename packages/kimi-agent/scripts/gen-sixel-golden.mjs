// Golden generator: run pi-tui's REAL `src/terminal-image.ts` under bun and
// record what `encodeSixel` and `calculateImageCellSize` produce for a fixed
// fixture. The Rust suite (`src/repl/terminal_image.rs`) re-encodes the same
// pixels and must match byte for byte, so the port's parity with the reference
// is measured rather than argued.
//
//   bun scripts/gen-sixel-golden.mjs            # re-record from packages/pi-tui
//   bun scripts/gen-sixel-golden.mjs --check X  # diff a candidate against golden
//
// Unlike `gen-acp-golden.mjs`, the reference here is not a `.tmp` checkout: it
// is pi-tui itself, vendored in this repo, so the script reads the source file
// directly and needs no shims.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const REPO = resolve(PKG, '../..');

const REFERENCE = resolve(REPO, 'packages/pi-tui/src/terminal-image.ts');
const GOLDEN = resolve(PKG, 'test/terminal-image-golden.json');

const reference = await import(pathToFileURL(REFERENCE).href);

// The fixture is chosen to exercise the two shapes a naive encoder gets wrong:
// a band whose colours differ between its top row and its lower rows (colour
// registration), and saturated primaries plus a grey (quantization).
const FIXTURE = {
  widthPx: 3,
  heightPx: 4,
  rgba: [
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255,
    255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255,
    0, 0, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255,
  ],
  maxWidthCells: 1,
  maxHeightCells: 1,
  cellPx: { widthPx: 9, heightPx: 18 },
};

if (process.argv.includes('--check')) {
  const actual = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--check') + 1], 'utf8'));
  const expected = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  const keys = ['widthPx', 'heightPx', 'rgba', 'maxWidthCells', 'maxHeightCells', 'cellSize', 'sequence'];
  let bad = 0;
  for (const key of keys) {
    const x = JSON.stringify(expected[key]);
    const y = JSON.stringify(actual[key]);
    if (x !== y) {
      bad++;
      console.log(`MISMATCH ${key}\n  pi-tui: ${x}\n  rust:   ${y}`);
    }
  }
  console.log(bad === 0 ? `OK: ${keys.length} fields byte-identical to pi-tui` : `${bad} mismatch(es)`);
  process.exit(bad === 0 ? 0 : 1);
}

const pixels = Uint8Array.from(FIXTURE.rgba);
const cellSize = reference.calculateImageCellSize(
  { widthPx: FIXTURE.widthPx, heightPx: FIXTURE.heightPx },
  FIXTURE.maxWidthCells,
  FIXTURE.maxHeightCells,
  FIXTURE.cellPx,
);
const sequence = reference.encodeSixel(pixels, FIXTURE.widthPx, FIXTURE.heightPx, {
  maxWidthCells: FIXTURE.maxWidthCells,
  maxHeightCells: FIXTURE.maxHeightCells,
});

writeFileSync(
  GOLDEN,
  `${JSON.stringify({ ...FIXTURE, cellSize, sequence }, null, 2)}\n`,
  'utf8',
);
console.log(`recorded ${GOLDEN}`);
console.log(`  cellSize ${JSON.stringify(cellSize)}, sequence ${sequence.length} bytes`);
