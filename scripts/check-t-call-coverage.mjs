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
  // The developer-facing tools each own a locale tree that this check did not
  // walk, so a `t('key')` there could name a key neither tree defines and
  // nothing reported it. They are scanned against their own `en` tree.
  {
    name: 'kimi-inspect',
    localeFile: 'apps/kimi-inspect/src/i18n/locales/en.ts',
    sourceDirs: ['apps/kimi-inspect/src'],
  },
  {
    name: 'vis-web',
    localeFile: 'apps/vis/web/src/i18n/locales/en.ts',
    sourceDirs: ['apps/vis/web/src'],
  },
  {
    name: 'vscode-webview',
    localeFile: 'apps/vscode/webview-ui/src/i18n/locales/en.ts',
    sourceDirs: ['apps/vscode/webview-ui/src'],
  },
  // kimi-web stores its messages as one module per domain under
  // `i18n/locales/<locale>/`, re-exported by `locales/index.ts`, and aliases
  // `i18n.global.t` to a bare `t` — so its calls look exactly like the other
  // trees and the same scan applies. Its calls were outside this gate, which
  // meant a `t('key')` here could name a key neither tree defines.
  {
    name: 'kimi-web',
    localeFile: 'apps/kimi-web/src/i18n/locales/index.ts',
    sourceDirs: ['apps/kimi-web/src'],
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
      // `.vue` matters for the Vue trees (vis-web, kimi-web, the VS Code
      // webview): their templates call `t('key')` too, and a `.ts`-only walk
      // reported "0 unique keys" for a tree with hundreds of calls.
      if (
        (ext === '.ts' || ext === '.vue' || ext === '.tsx') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.test.tsx') &&
        !entry.name.endsWith('.d.ts')
      ) {
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
    // Some trees (kimi-web) export one module per domain under a `messages`
    // map keyed by locale rather than a flat `{key: value}` object. Unwrap the
    // English side so the same leaf-key walk applies.
    const nested =
      data.messages && typeof data.messages === 'object' ? data.messages : data;
    const unwrapped =
      nested.en !== undefined && typeof nested.en === 'object' && nested.zh !== undefined
        ? nested.en
        : data;
    const keys = collectLeafKeys(unwrapped);
    localeKeyCache.set(localeFile, keys);
    return keys;
  } catch (error) {
    console.error(`Cannot load locale file ${localeFile}: ${error.message}`);
    process.exit(1);
  }
}

/** The translated VALUE for a dotted key, or undefined when absent. */
async function localeValue(localeFile, dottedKey) {
  const fullPath = resolve(ROOT, localeFile);
  try {
    const mod = await import(pathToFileURL(fullPath).href);
    const data = mod.default || mod;
    let current = data;
    for (const part of dottedKey.split('.')) {
      if (current === null || typeof current !== 'object') return undefined;
      current = current[part];
    }
    return typeof current === 'string' ? current : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A translated value that is byte-identical to English is not translated. This
 * catches the case the key-coverage check above cannot see: a key exists in
 * both trees, so parity passes, while the zh side still ships the English
 * sentence (or an English sentence interpolated into a Chinese frame).
 *
 * Only `errorCodes.*` is checked, and only when the value has no CJK and reads
 * as prose — identifiers, placeholders and deliberately-English proper nouns
 * (`Kimi`, `MCP`, `JSON`) are excluded so this stays actionable.
 */
async function checkErrorCodeTranslation() {
  const enFile = 'apps/kimi-code/src/i18n/locales/en.ts';
  const zhFile = 'apps/kimi-code/src/i18n/locales/zh.ts';
  const keys = await loadLocaleKeys(enFile);
  const errorCodeKeys = [...keys].filter((key) => key.startsWith('errorCodes.'));

  const untranslated = [];
  for (const key of errorCodeKeys.sort((a, b) => a.localeCompare(b))) {
    const en = await localeValue(enFile, key);
    const zh = await localeValue(zhFile, key);
    if (en === undefined || zh === undefined) continue;
    if (zh !== en) continue;
    if (!/[A-Za-z]/.test(zh)) continue;
    if (/[\u4e00-\u9fff]/.test(zh)) continue;
    // A value that is only placeholders/punctuation carries no sentence.
    if (!/[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(zh)) continue;
    untranslated.push(key);
  }

  console.log(
    `\n${untranslated.length === 0 ? '✓' : '✗'} error-code copy: ${errorCodeKeys.length} keys, ${untranslated.length} still identical to English`,
  );
  if (untranslated.length > 0) {
    console.error(`  ${untranslated.length} errorCodes.* value(s) are the English sentence in zh:\n`);
    for (const key of untranslated.slice(0, 40)) console.error(`  - ${key}`);
    if (untranslated.length > 40) console.error(`  ... and ${untranslated.length - 40} more`);
    console.error('  Translate the zh value; do not leave the English sentence in place.');
  }
  return untranslated.length === 0;
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

    /** @type {{ code: string; key: string; absentIn: string[] }[]} */
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

  const codeCoverageOk = await checkErrorCodeCoverage();
  const codeTranslationOk = await checkErrorCodeTranslation();
  if (hasErrors || !codeCoverageOk || !codeTranslationOk) {
    console.error(
      '\n❌ Some t() calls have no matching locale key, an engine error code has no locale entry, or a zh errorCodes value still carries the English sentence — see above.\n',
    );
    process.exit(1);
  } else {
    console.log(
      '\n✅ All t() calls have matching locale keys, every engine error code is localized, and no zh errorCodes value is a copy of English.\n',
    );
  }
}

/**
 * The engine registry (`packages/agent-core-v2/src/errors.ts`) is the single
 * source of truth for error codes; `errorCodes.<camelCaseCode>` in the
 * kimi-code locale tree is the single source of truth for how they read.
 * `formatLocalizedError` maps one onto the other at display time, so a code
 * without a key falls back to the raw English sentence the engine threw.
 */
async function checkErrorCodeCoverage() {
  const { ErrorCodes } = await import(
    pathToFileURL(resolve(ROOT, 'packages/agent-core-v2/src/errors.ts')).href
  );
  const camelCaseCode = (code) =>
    code
      .split(/[._]/)
      .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join('');

  const codes = [...new Set(Object.values(ErrorCodes))].sort((a, b) => a.localeCompare(b));
  const trees = {
    en: await loadLocaleKeys('apps/kimi-code/src/i18n/locales/en.ts'),
    zh: await loadLocaleKeys('apps/kimi-code/src/i18n/locales/zh.ts'),
  };

  const missing = [];
  for (const code of codes) {
    const key = `errorCodes.${camelCaseCode(code)}`;
    const absentIn = Object.entries(trees)
      .filter(([, keys]) => !keys.has(key))
      .map(([lang]) => lang);
    if (absentIn.length > 0) missing.push({ code, key, absentIn });
  }

  const enKeys = trees.en;
  const orphans = [...enKeys]
    .filter((key) => key.startsWith('errorCodes.'))
    .map((key) => key.slice('errorCodes.'.length))
    .filter((camel) => !camel.endsWith('Action'))
    .filter((camel) => !codes.some((code) => camelCaseCode(code) === camel))
    .sort((a, b) => a.localeCompare(b));

  console.log(
    `\n${missing.length === 0 ? '✓' : '✗'} error codes: ${codes.length} engine codes, ${enKeys.size} locale keys`,
  );

  if (missing.length > 0) {
    console.error(`  ${missing.length} engine code(s) have no errorCodes.* locale entry:\n`);
    for (const entry of missing.slice(0, 40)) {
      console.error(
        `  - ${String(entry.code)} → ${String(entry.key)} (missing in: ${String(entry.absentIn)})`,
      );
    }
    if (missing.length > 40) console.error(`  ... and ${missing.length - 40} more`);
    console.error(
      '  Add both languages, or run `bun scripts/gen-error-locale-skeleton.mjs` to scaffold them.',
    );
  }

  if (orphans.length > 0) {
    console.log(
      `\n  note: ${orphans.length} errorCodes.* key(s) have no engine code (retired or SDK-only):`,
    );
    for (const key of orphans.slice(0, 20)) console.log(`      ${key}`);
    if (orphans.length > 20) console.log(`      ... and ${orphans.length - 20} more`);
  }

  return missing.length === 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
