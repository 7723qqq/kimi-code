/**
 * CI check: verify every `t('namespace.key')` call in source code has a
 * corresponding entry in the locale file that source tree is translated from.
 *
 * Usage: bun scripts/check-t-call-coverage.mjs
 * Exit code: 0 if all keys are covered, 1 if any key is missing.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, relative, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const ROOT = resolve(__dirname, '..');

// ── Config ───────────────────────────────────────────────────────────────────

// Each source names the directory trees it owns and the locale module those
// trees are translated from. `apps/kimi-code` keeps its own locale file, so it
// is checked against that rather than against packages/i18n.
const SOURCES = [
  {
    name: 'agent-core-v2 + kap-server + klient',
    localeFile: 'packages/i18n/src/locales/en.ts',
    sourceDirs: ['packages/agent-core-v2/src', 'packages/kap-server/src', 'packages/klient/src'],
  },
  {
    name: 'kimi-code',
    localeFile: 'apps/kimi-code/src/i18n/locales/en.ts',
    sourceDirs: ['apps/kimi-code/src'],
  },
];


// ── Simple recursive file walker ─────────────────────────────────────────────

function* walkFiles(dir) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      yield* walkFiles(fullPath);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (ext === '.ts' && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
        yield fullPath;
      }
    }
  }
}

// ── Load locale keys ────────────────────────────────────────────────────────

function collectLeafKeys(obj, prefix = '') {
  const keys = new Set();
  if (obj === null || typeof obj !== 'object') return keys;
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (value !== null && typeof value === 'object') {
      const children = collectLeafKeys(value, fullKey);
      for (const c of children) keys.add(c);
    } else {
      keys.add(fullKey);
    }
  }
  return keys;
}

const localeKeyCache = new Map();
async function loadLocaleKeys(localeFile) {
  if (localeKeyCache.has(localeFile)) return localeKeyCache.get(localeFile);
  const fullPath = resolve(ROOT, localeFile);
  try {
    const mod = await import(pathToFileURL(fullPath).href);
    const data = mod.default || mod;
    const keys = collectLeafKeys(data);
    localeKeyCache.set(localeFile, keys);
    return keys;
  } catch (error) {
    console.error(`Cannot load locale file ${localeFile}: ${error.message}`);
    process.exit(1);
  }
}

// ── Scan source for t() calls ────────────────────────────────────────────────

const T_CALL_RE = /(?<![a-zA-Z0-9_$.])t\(['"]([a-zA-Z0-9_.]+)['"]/g;

function scanFile(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const calls = [];
  let match;
  while ((match = T_CALL_RE.exec(content)) !== null) {
    calls.push(match[1]);
  }
  return calls;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let hasErrors = false;
  let totalFiles = 0;
  let totalKeys = 0;

  for (const source of SOURCES) {
    const localeKeySet = await loadLocaleKeys(source.localeFile);
    const allCalls = new Map(); // key -> [file1, file2, ...]
    let files = 0;

    for (const dir of source.sourceDirs) {
      const fullDir = resolve(ROOT, dir);
      for (const filePath of walkFiles(fullDir)) {
        const relPath = relative(ROOT, filePath);
        files++;
        const calls = scanFile(filePath);
        for (const key of calls) {
          if (!allCalls.has(key)) allCalls.set(key, []);
          allCalls.get(key).push(relPath);
        }
      }
    }

    totalFiles += files;
    totalKeys += allCalls.size;

    const missing = [];
    for (const [key, callFiles] of allCalls) {
      if (!localeKeySet.has(key)) {
        missing.push({ key, files: callFiles });
      }
    }

    console.log(
      `\n${missing.length === 0 ? '✓' : '✗'} ${source.name}: ${files} files, ${allCalls.size} unique t() keys, ${localeKeySet.size} locale keys`,
    );

    if (missing.length > 0) {
      hasErrors = true;
      console.error(`  Found ${missing.length} t() call(s) without matching locale key:\n`);
      for (const { key, files: callFiles } of missing) {
        const uniqueFiles = [...new Set(callFiles)];
        console.error(`  - ${key}`);
        for (const f of uniqueFiles.slice(0, 5)) {
          console.error(`      ${String(f)}`);
        }
        if (uniqueFiles.length > 5) {
          console.error(`      ... and ${uniqueFiles.length - 5} more files`);
        }
      }
    }
  }

  console.log(`\nChecked ${totalFiles} files, ${totalKeys} unique t() keys.`);
  if (hasErrors) {
    console.error(
      '\n❌ Some t() calls have no matching locale key — add them to the locale file named above.\n',
    );
    process.exit(1);
  } else {
    console.log('\n✅ All t() calls have matching locale keys.\n');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
