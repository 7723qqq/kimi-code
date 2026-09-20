/**
 * CI check: verify every `t('namespace.key')` call in source code has a
 * corresponding entry in the main i18n locale files.
 *
 * Usage: node scripts/check-t-call-coverage.mjs
 * Exit code: 0 if all keys are covered, 1 if any key is missing.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, relative, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const ROOT = resolve(__dirname, '..');

// ── Config ───────────────────────────────────────────────────────────────────

// Each entry pairs a source tree with the locale file its `t()` keys resolve
// against. A tree with no entry here is completely unchecked — `apps/kimi-code`
// used to be in exactly that blind spot, which is how a `t()` call naming a key
// that exists in neither locale reached the settings list as raw text.
const LOCALE_TARGETS = [
  {
    name: 'i18n (main)',
    sourceDirs: ['packages/i18n/src'],
    localeFile: 'packages/i18n/src/locales/en.ts',
    slug: 'packages/i18n/src/locales/{en,zh}.ts',
  },
  {
    name: 'kimi-code',
    sourceDirs: ['apps/kimi-code/src'],
    localeFile: 'apps/kimi-code/src/i18n/locales/en.ts',
    slug: 'apps/kimi-code/src/i18n/locales/{en,zh}.ts',
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

let localeKeys;
async function loadLocaleKeys(localeFile) {
  if (localeKeys && localeKeys.has(localeFile)) return localeKeys.get(localeFile);
  const fullPath = resolve(ROOT, localeFile);
  try {
    const mod = await import(pathToFileURL(fullPath).href);
    const data = mod.default || mod;
    const keys = collectLeafKeys(data);
    if (!localeKeys) localeKeys = new Map();
    localeKeys.set(localeFile, keys);
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

  for (const target of LOCALE_TARGETS) {
    const localeKeySet = await loadLocaleKeys(target.localeFile);
    const allCalls = new Map(); // key -> [file1, file2, ...]
    const files = [];

    for (const dir of target.sourceDirs) {
      const fullDir = resolve(ROOT, dir);
      for (const filePath of walkFiles(fullDir)) {
        const relPath = relative(ROOT, filePath);
        files.push(relPath);
        const calls = scanFile(filePath);
        for (const key of calls) {
          if (!allCalls.has(key)) allCalls.set(key, []);
          allCalls.get(key).push(relPath);
        }
      }
    }

    totalFiles += files.length;
    const missing = [];

    for (const [key, callFiles] of allCalls) {
      if (!localeKeySet.has(key)) {
        missing.push({ key, files: callFiles });
      }
    }

    if (missing.length > 0) {
      hasErrors = true;
      console.error(
        `\n✗ [${target.name}] ${missing.length} t() call(s) without matching locale key:\n`,
      );
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
    } else {
      console.log(
        `✓ [${target.name}] ${files.length} files, ${allCalls.size} unique t() keys — all resolve.`,
      );
    }
  }

  console.log(`\nChecked ${totalFiles} files across ${LOCALE_TARGETS.length} source tree(s).`);
  if (hasErrors) {
    console.error(
      '\n❌ Some t() calls have no matching locale key — add them to the locale files named above.\n',
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
