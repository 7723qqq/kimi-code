// Post-process the napi-generated type definitions into the committed
// `napi-contract.d.ts`. The v2 macro's function defs carry their own
// `export declare` prefix, which the v3 CLI renderer prepends again —
// collapse the doubling so the file parses. Run after `napi build --dts`.
import { readFileSync, writeFileSync } from 'node:fs';

const src = new URL('../target/napi-generated.d.ts', import.meta.url);
const dest = new URL('../napi-contract.d.ts', import.meta.url);

const raw = readFileSync(src, 'utf-8');
const fixed = raw.replaceAll('export declare export declare ', 'export declare ');
writeFileSync(dest, fixed);
console.log(`napi-contract.d.ts: ${fixed.length} bytes (${raw.length} raw)`);