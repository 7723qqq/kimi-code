const path = require('node:path');

const BINDING_NAME = 'kimi-native-tools';
let binding;
try {
  binding = require(`./${BINDING_NAME}.${process.platform}-${process.arch}-msvc.node`);
} catch {
  binding = require(`./${BINDING_NAME}.${process.platform}-${process.arch}.node`);
}
const wrapper = require('./');

function basename(p) {
  const n = p.replace(/\\/g, '/');
  const i = n.lastIndexOf('/');
  return i === -1 ? p : n.slice(i + 1);
}
const SENSITIVE_BASENAMES = new Set(['.env', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials']);
const SENSITIVE_PATH_SUFFIXES = [['.aws', 'credentials'], ['.gcp', 'credentials']];
const ENV_PREFIX = '.env.';
const ENV_EXEMPTIONS = new Set(['.env.example', '.env.sample', '.env.template']);
const SENSITIVE_BASENAME_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials'];
const PUBLIC_KEY_BASENAMES = new Set(['id_rsa.pub', 'id_ed25519.pub', 'id_ecdsa.pub']);
const SENSITIVE_DOT_VARIANT_SUFFIXES = ['.bak', '.backup', '.copy', '.disabled', '.key', '.old', '.orig', '.pem', '.save', '.tmp'];
const SENSITIVE_DOT_VARIANT_SUFFIX_SET = new Set(SENSITIVE_DOT_VARIANT_SUFFIXES);

function tsIsSensitiveFile(p) {
  const name = basename(p);
  const cn = name.toLowerCase();
  const cp = p.toLowerCase();
  if (ENV_EXEMPTIONS.has(cn)) return false;
  if (PUBLIC_KEY_BASENAMES.has(cn)) return false;
  if (SENSITIVE_BASENAMES.has(cn)) return true;
  if (cn.startsWith(ENV_PREFIX)) return true;
  for (const prefix of SENSITIVE_BASENAME_PREFIXES) {
    if (cn === prefix) return true;
    if (cn.length > prefix.length && cn.startsWith(prefix)) {
      const suffix = cn.slice(prefix.length);
      const next = suffix[0];
      if (next === '-' || next === '_') return true;
      if (next === '.' && SENSITIVE_DOT_VARIANT_SUFFIX_SET.has(suffix)) return true;
    }
  }
  for (const sp of SENSITIVE_PATH_SUFFIXES) {
    const suffix = sp.join('/').toLowerCase();
    if (cp.endsWith(`/${suffix}`) || cp.includes(`/${suffix}/`)) return true;
  }
  return false;
}

function bench(fn, label, paths, iterations) {
  for (let i = 0; i < 2000; i++) for (const p of paths) fn(p);
  const start = performance.now();
  let result = false;
  for (let i = 0; i < iterations; i++) {
    for (const p of paths) result = fn(p);
  }
  const elapsed = performance.now() - start;
  const totalCalls = iterations * paths.length;
  const nsPerCall = (elapsed * 1e6) / totalCalls;
  console.log(`  ${label.padEnd(45)} ${nsPerCall.toFixed(0).padStart(5)}ns/call`);
  return { nsPerCall, result };
}

const ITERATIONS = 200_000;
const paths = [
  '.env', '.env.local', '.env.production', '/home/user/.ssh/id_rsa',
  '/home/user/.aws/credentials', '.env.example', 'id_rsa.pub', 'id_rsa.bak',
  'credentials.json', 'app.py', 'src/components/Button.tsx',
  '/repo/node_modules/react/index.js', 'C:\\Users\\foo\\.ssh\\id_ed25519',
  '/home/user/.gcp/credentials', 'package.json', 'id_rsafoo.txt',
  '.env.sample', '/deeply/nested/path/to/.env.staging',
];

console.log(`\n=== Breakdown: where does time go? (${ITERATIONS.toLocaleString()} × ${paths.length} paths) ===\n`);

bench(tsIsSensitiveFile, 'TS isSensitiveFile (baseline)', paths, ITERATIONS);
bench((p) => binding.nativeIsSensitiveFile(p), 'Rust via String (napi UTF-16→UTF-8)', paths, ITERATIONS);
bench(wrapper.nativeIsSensitiveFile, 'Rust via u16 wrapper (charCodeAt+alloc)', paths, ITERATIONS);

// Isolate: JS-side conversion costs
console.log(`\n--- JS-side conversion costs ---`);
bench((p) => { const b = new Uint16Array(p.length); for (let i=0;i<p.length;i++) b[i]=p.charCodeAt(i); return b.length>0; }, 'new Uint16Array + charCodeAt loop', paths, ITERATIONS);
bench((p) => Buffer.from(p, 'latin1').length > 0, 'Buffer.from(path, "latin1")', paths, ITERATIONS);
bench((p) => Buffer.from(p, 'utf8').length > 0, 'Buffer.from(path, "utf8")', paths, ITERATIONS);
bench((p) => Buffer.from(p, 'utf16le').length > 0, 'Buffer.from(path, "utf16le")', paths, ITERATIONS);

// Pre-computed Uint16Array (no JS conversion, pure napi cost)
const preU16 = paths.map(p => { const b = new Uint16Array(p.length); for (let i=0;i<p.length;i++) b[i]=p.charCodeAt(i); return b; });
bench((_, i) => binding.nativeIsSensitiveFileU16(preU16[i]), 'Rust u16 (pre-computed, no JS conv)', paths, ITERATIONS);

// Buffer.from(latin1) + pass to Rust as Uint8Array
// (Need a Rust function that accepts &[u8] — use nativeSniffImageDimensions
// as a proxy to measure napi Uint8Array call cost)
console.log(`\n--- Latin1 Buffer approach (simulated) ---`);
const preBuf = paths.map(p => Buffer.from(p, 'latin1'));
bench((_, i) => binding.nativeIsSensitiveFileU16(new Uint16Array(preBuf[i].buffer, preBuf[i].byteOffset, Math.floor(preBuf[i].length/2))), 'Rust u16 via Buffer.from(latin1) view', paths, ITERATIONS);

// Theoretical: if we had a Rust function taking Uint8Array (Latin1 bytes)
// Buffer.from(path, 'latin1') + napi Uint8Array call
bench((p) => { const buf = Buffer.from(p, 'latin1'); return buf.length > 0; }, 'Buffer.from(latin1) allocation only', paths, ITERATIONS);
