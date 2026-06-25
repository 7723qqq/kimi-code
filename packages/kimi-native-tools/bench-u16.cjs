const path = require('node:path');

// Load raw binding directly (to access old String-based function)
const BINDING_NAME = 'kimi-native-tools';
let binding;
try {
  binding = require(`./${BINDING_NAME}.${process.platform}-${process.arch}-msvc.node`);
} catch {
  binding = require(`./${BINDING_NAME}.${process.platform}-${process.arch}.node`);
}

// Load via index.js wrapper (uses new u16 path)
const wrapper = require('./');

// TS implementation for baseline
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
  console.log(`  ${label.padEnd(40)} ${elapsed.toFixed(1).padStart(7)}ms  ${nsPerCall.toFixed(0).padStart(5)}ns/call`);
  return { elapsed, nsPerCall, result };
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

console.log(`\n=== isSensitiveFile: String vs Uint16Array vs TS (${ITERATIONS.toLocaleString()} iterations × ${paths.length} paths) ===\n`);

// 1. TS baseline
bench(tsIsSensitiveFile, 'TS isSensitiveFile', paths, ITERATIONS);

// 2. Old Rust path: String parameter (UTF-16→UTF-8 conversion)
bench((p) => binding.nativeIsSensitiveFile(p), 'Rust old (String param)', paths, ITERATIONS);

// 3. New Rust path: wrapper converts string→Uint16Array→u16
bench(wrapper.nativeIsSensitiveFile, 'Rust new (u16 via wrapper)', paths, ITERATIONS);

// 4. Raw u16 binding with pre-computed Uint16Array (isolates charCodeAt cost)
const precomputed = paths.map((p) => {
  const buf = new Uint16Array(p.length);
  for (let i = 0; i < p.length; i++) buf[i] = p.charCodeAt(i);
  return buf;
});
bench((p) => {
  const idx = paths.indexOf(p);
  return binding.nativeIsSensitiveFileU16(precomputed[idx]);
}, 'Rust u16 raw (pre-computed buf)', paths, ITERATIONS);

// 5. Just the charCodeAt conversion loop (isolates JS-side cost)
bench((p) => {
  const buf = new Uint16Array(p.length);
  for (let i = 0; i < p.length; i++) buf[i] = p.charCodeAt(i);
  return buf.length > 0;
}, 'JS charCodeAt→Uint16Array only', paths, ITERATIONS);

// Single short path
console.log(`\n=== Single short path ".env" (${ITERATIONS.toLocaleString()} iterations) ===\n`);
const singlePath = ['.env'];
bench(tsIsSensitiveFile, 'TS', singlePath, ITERATIONS);
bench((p) => binding.nativeIsSensitiveFile(p), 'Rust old (String)', singlePath, ITERATIONS);
bench(wrapper.nativeIsSensitiveFile, 'Rust new (u16 wrapper)', singlePath, ITERATIONS);
