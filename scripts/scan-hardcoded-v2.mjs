#!/usr/bin/env bun
/**
 * scan-hardcoded-v2.mjs — Enhanced hardcoded string scanner.
 *
 * Strategy: Load each module's existing locale file, extract all leaf values
 * (the actual translated text), then search the source code for those exact
 * strings appearing OUTSIDE a t() call. If a string exists in the locale file
 * but is hardcoded in source, it should be replaced with t('key').
 *
 * Also catches common patterns like throw new Error() with user-facing text.
 *
 * Usage:
 *   node scripts/scan-hardcoded-v2.mjs                     # scan all modules
 *   node scripts/scan-hardcoded-v2.mjs --module agent-core  # scan one module
 *   node scripts/scan-hardcoded-v2.mjs --output reports/scan.json
 *
 * Exit code: 0 if no issues found, 1 if any found.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { register } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'target',
  '.vite',
  '.cache',
  'coverage',
  '__snapshots__',
]);

// Module definitions
const MODULES = [
  {
    name: 'kimi-code',
    srcDir: 'apps/kimi-code/src',
    localeDir: 'apps/kimi-code/src/i18n/locales',
    localeEn: 'apps/kimi-code/src/i18n/locales/en.ts',
    localeZh: 'apps/kimi-code/src/i18n/locales/zh.ts',
    tPattern: /\bt\(['"]/,
    importPattern: /from\s+['"]#\/i18n['"]/,
    skipDirs: ['i18n'],
    fileTypes: ['.ts'],
    tImportName: 't',
  },
  {
    name: 'kimi-web',
    srcDir: 'apps/kimi-web/src',
    localeDir: 'apps/kimi-web/src/i18n/locales',
    localeKind: 'dir',
    tPattern: /\$t\(['"]/,
    importPattern: /useI18n/,
    skipDirs: ['i18n'],
    fileTypes: ['.ts', '.tsx', '.vue'],
    tImportName: '$t',
    // Detections 1-3 still run: this tree keeps drifting out of sync, and
    // catching a *translated* string that got hardcoded is still worth it.
    //
    // Detection 4 is off. `apps/kimi-web` is a stale dev sandbox, excluded
    // from the workspace and never rebuilt into the shipped `dist-web` bundle
    // (that comes from the separate code-app repo), so a finding here does not
    // correspond to anything a user can see. Reporting it would train the gate
    // to be ignored, which is how the original blind spot survived.
    untranslatedScan: false,
  },
  {
    name: 'kimi-inspect',
    srcDir: 'apps/kimi-inspect/src',
    localeDir: 'apps/kimi-inspect/src/i18n/locales',
    localeEn: 'apps/kimi-inspect/src/i18n/locales/en.ts',
    localeZh: 'apps/kimi-inspect/src/i18n/locales/zh.ts',
    tPattern: /\bt\(['"]/,
    importPattern: /from\s+['"].*i18n['"]/,
    skipDirs: ['i18n'],
    fileTypes: ['.ts', '.tsx'],
    tImportName: 't',
  },
  {
    name: 'vis-web',
    srcDir: 'apps/vis/web/src',
    localeDir: 'apps/vis/web/src/i18n/locales',
    localeEn: 'apps/vis/web/src/i18n/locales/en.ts',
    localeZh: 'apps/vis/web/src/i18n/locales/zh.ts',
    tPattern: /\bt\(['"]/,
    importPattern: /from\s+['"].*i18n['"]/,
    skipDirs: ['i18n'],
    fileTypes: ['.ts', '.tsx'],
    tImportName: 't',
  },
  {
    name: 'vscode-webview',
    srcDir: 'apps/vscode/webview-ui/src',
    localeDir: 'apps/vscode/webview-ui/src/i18n/locales',
    localeEn: 'apps/vscode/webview-ui/src/i18n/locales/en.ts',
    localeZh: 'apps/vscode/webview-ui/src/i18n/locales/zh.ts',
    tPattern: /\bt\(['"]/,
    importPattern: /from\s+['"].*i18n['"]/,
    skipDirs: ['i18n'],
    fileTypes: ['.ts', '.tsx'],
    tImportName: 't',
  },
];

// ── TS module loader ───────────────────────────────────────────────────────

let tsxRegistered = false;
function ensureTsx() {
  if (tsxRegistered) return;
  try {
    register('tsx/esm', pathToFileURL(import.meta.url));
    tsxRegistered = true;
  } catch {
    // tsx not available
  }
}

async function loadTSModule(p) {
  ensureTsx();
  const fullPath = resolve(ROOT, p);
  const fileUrl = pathToFileURL(fullPath).href;
  try {
    const mod = await import(fileUrl);
    return mod.default || mod;
  } catch (error) {
    throw new Error(`Cannot load ${p}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

// ── Locale key/value extraction ────────────────────────────────────────────

function collectLeaves(obj, prefix = '') {
  const entries = [];
  if (obj === null || typeof obj !== 'object') return entries;
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (value !== null && typeof value === 'object') {
      entries.push(...collectLeaves(value, fullKey));
    } else if (typeof value === 'string') {
      entries.push({ key: fullKey, value });
    }
  }
  return entries;
}

/**
 * Merge every per-section TS locale file under `locales/<lang>/*.ts` into a
 * single object (used by modules whose locales are split into section files,
 * e.g. kimi-web).
 */
async function loadLocaleDir(modInfo, lang) {
  const dir = resolve(ROOT, join(modInfo.localeDir, lang));
  const merged = {};
  // Sections share common keys (title, close, output, ...), so merge order
  // decides which value survives; readdir order differs between node and bun,
  // so sort the entries to keep the merged map runtime-independent.
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const mod = await loadTSModule(join(dir, entry.name));
    const data = mod?.default ?? mod;
    if (data !== null && typeof data === 'object') Object.assign(merged, data);
  }
  return merged;
}

/**
 * Extract locale values from a TS module or JSON file.
 */
async function extractLocaleValues(modInfo) {
  let enData, zhData;

  if (modInfo.localeKind === 'dir') {
    // Directory of per-section TS files — merge the sections.
    enData = await loadLocaleDir(modInfo, 'en');
    zhData = await loadLocaleDir(modInfo, 'zh');
  } else if (modInfo.localeIsJson) {
    // JSON files — load directly
    const enPath = resolve(ROOT, modInfo.localeEn);
    const zhPath = resolve(ROOT, modInfo.localeZh);
    const enContent = readFileSync(enPath, 'utf-8');
    const zhContent = readFileSync(zhPath, 'utf-8');
    enData = JSON.parse(enContent);
    zhData = JSON.parse(zhContent);
  } else {
    // TS module — import via tsx
    enData = await loadTSModule(modInfo.localeEn);
    zhData = await loadTSModule(modInfo.localeZh);
  }

  const enLeaves = enData ? collectLeaves(enData) : [];
  const zhLeaves = zhData ? collectLeaves(zhData) : [];

  // Build a map from leaf value → [keys] (one value might appear under multiple keys)
  const valueToKeys = new Map();
  for (const entry of [...enLeaves, ...zhLeaves]) {
    const normalized = entry.value.trim().replaceAll(/\{\{(\w+)\}\}/g, '*'); // normalize params
    if (!valueToKeys.has(normalized)) {
      valueToKeys.set(normalized, []);
    }
    valueToKeys.get(normalized).push(entry.key);
  }

  // Pre-compile the per-value match regexes once (scanFile runs them against
  // every source line; building a RegExp per line × per value is the scanner's
  // dominant cost on large trees like apps/kimi-code).
  const valueRegexes = new Map();
  for (const normalizedValue of valueToKeys.keys()) {
    const escaped = normalizedValue.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fuzzyPattern = escaped.replaceAll('*', '.+?');
    valueRegexes.set(normalizedValue, {
      value: new RegExp(`['"\`]${fuzzyPattern}['"\`]`),
      tCall: new RegExp(`(?:\\bt\\(|\\$t\\(|t\\()['"\`]${fuzzyPattern}['"\`]`),
    });
  }

  return { enLeaves, zhLeaves, valueToKeys, valueRegexes };
}

// ── Scanner ────────────────────────────────────────────────────────────────

function scanFile(filePath, content, moduleInfo, valueToKeys, valueRegexes) {
  const findings = [];
  const lines = content.split('\n');
  const relPath = relative(ROOT, filePath).replaceAll('\\', '/');

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNum = i + 1;

    // Skip comment-only lines.
    if (/^\s*(\/\/|\*|<!--)/.test(rawLine)) continue;

    // Strip trailing comments so a JSDoc or `//` note that quotes a locale
    // value — `/** Card title, e.g. `Session state`. */ title: string;` — is
    // not mistaken for a hardcoded string. A `//` inside a string literal
    // (a URL) must survive, so only cut at a `//` not preceded by `:`.
    const line = rawLine
      .replace(/\/\*\*?[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/, '$1');
    const trimmed = line.trim();

    // ── Detection 1: Locale value appears hardcoded (not in t() call) ──
    // Only applies to files that already use t() — files without t() imports
    // are expected to have hardcoded strings (they may not be user-facing)

    // Fast path: every value regex requires a quoted literal, so a line
    // without any quote cannot match any of them.
    if (!/['"`]/.test(trimmed)) continue;

    // Look for locale values appearing as string literals
    for (const [normalizedValue, keys] of valueToKeys) {
      // Skip single-word short values that look like identifiers, not display text
      const plainValue = normalizedValue.replaceAll('*', '');
      if (plainValue.length < 5 && !/[\u4E00-\u9FFF]/.test(plainValue)) continue;
      if (/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/.test(plainValue) && plainValue.length < 20) continue;
      // Skip single-word PascalCase values (likely command names or identifiers)
      if (/^[A-Z][a-z]+$/.test(plainValue) && plainValue.length < 15) continue;
      // Skip single words without spaces (likely identifiers, not display text)
      if (
        !plainValue.includes(' ') &&
        plainValue.length < 12 &&
        !/[\u4E00-\u9FFF]/.test(plainValue)
      )
        continue;

      const regexes = valueRegexes.get(normalizedValue);
      if (regexes.value.test(trimmed)) {
        // Check if this string is already wrapped in t() or $t()
        if (regexes.tCall.test(trimmed)) continue; // already using t()

        // Check if this line IS the locale definition itself
        if (relPath.includes(moduleInfo.name === 'kimi-web' ? '/locales/' : '/i18n')) continue;

        // Skip if it's in an import/require
        if (/^(import|require|from|export)/.test(trimmed)) continue;

        // Skip if it's a type/interface property definition
        if (/\w+\??:\s*string/.test(trimmed)) continue;

        findings.push({
          file: relPath,
          line: lineNum,
          type: 'hardcoded_locale_value',
          text: normalizedValue,
          keys,
          context: trimmed.slice(0, 100),
        });
      }
    }

    // ── Detection 2: throw new Error('user-facing message') that should use t() ──
    const errorMatches = trimmed.matchAll(/throw new Error\(['"]([^'"]{8,})['"]\)/g);
    for (const em of errorMatches) {
      const str = em[1].trim();
      // Skip error class names / PascalCase identifiers
      if (/^[A-Z][a-z]+Error$/.test(str)) continue;
      // Check if this string exists in locale values
      const normalized = str.replaceAll(/\{\{(\w+)\}\}/g, '*');
      if (valueToKeys.has(normalized)) {
        findings.push({
          file: relPath,
          line: lineNum,
          type: 'throw_error_with_locale_key',
          text: str,
          keys: valueToKeys.get(normalized),
          context: trimmed.slice(0, 100),
        });
      } else if (looksLikeUserFacing(str)) {
        findings.push({
          file: relPath,
          line: lineNum,
          type: 'throw_error_hardcoded',
          text: str,
          keys: [],
          context: trimmed.slice(0, 100),
        });
      }
    }

    // ── Detection 3: String in chalk output context (kimi-code CLI) ──
    if (moduleInfo.name === 'kimi-code') {
      const chalkMatches = trimmed.matchAll(
        /(?:chalk|dim|bold|italic|hex|gray)\(['"]([^'"]{5,})['"]\)/g,
      );
      for (const cm of chalkMatches) {
        const str = cm[1].trim();
        const normalized = str.replaceAll(/\{\{(\w+)\}\}/g, '*');
        if (!valueToKeys.has(normalized) && looksLikeUserFacing(str)) {
          findings.push({
            file: relPath,
            line: lineNum,
            type: 'chalk_output_no_locale',
            text: str,
            keys: [],
            context: trimmed.slice(0, 100),
          });
        }
      }
    }

    // ── Detection 4: a display slot holding a literal (no locale lookup) ──
    if (moduleInfo.untranslatedScan !== false) {
      for (const slot of scanDisplaySlots(line, relPath)) {
        findings.push({
          file: relPath,
          line: lineNum,
          type: 'untranslated_display_slot',
          text: slot.value,
          keys: [],
          context: trimmed.slice(0, 100),
        });
      }
    }
  }

  return findings;
}

function looksLikeUserFacing(str) {
  if (str.length < 5) return false;
  // Skip internal identifiers
  if (/^[A-Z][A-Z_]+$/.test(str)) return false; // ALL_CAPS
  if (/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/.test(str) && str.length < 24) return false; // snake/kebab
  // Must start with a capital letter (English) or contain Chinese
  return (/^[A-Z]/.test(str) && /[a-z]/.test(str)) || /[一-鿿]/.test(str);
}

// ── Detection 4: untranslated user-facing slots ─────────────────────────────
//
// Detections 1-3 all derive their search patterns from the locale files, so
// they can only catch text that is *already translated* and then hardcoded.
// A user-facing string that was never translated at all — the case this fork
// actually had in the VS Code webview, whose whole welcome carousel was plain
// English — is invisible to all of them. The gate reported zero issues while
// shipping that.
//
// This rule inverts the direction: instead of asking "is this string in the
// locale file?", it asks "is this a display slot holding a literal?". The slot
// is identified by the property it is assigned to, which is the one signal
// available without the locale as a reference.

/**
 * Literals that are legitimately not display text. Values that name a
 * protocol token, a format, a path, a product name or a keyboard key are
 * identical in every locale and translating them is noise.
 */
const ALLOWED_LITERAL = [
  /^\$/, // $-prefixed: env vars, template markers
  /^https?:\/\//i,
  /^wss?:\/\//i,
  /^[a-z][a-z0-9+.-]*:\/\//, // any scheme://
  /^\/[\w./-]*$/, // route or path
  /^\.\.?\/[\w./-]*$/, // relative path
  /^[A-Z0-9_]{2,}$/, // CONSTANT_CASE
  /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/, // kebab/snake/dotted token
  /^[a-z]+$/, // bare lowercase word (css-ish, status-ish)
  /^[A-Z][a-zA-Z0-9]*$/, // PascalCase identifier
  /^[\w.+-]+@[\w.-]+$/, // email
  /^[YMDHms\-:.TZ/+]+$/, // date/time format
  /^[#%][\w#%()-]+$/, // color or format token
  /^MCP_[A-Z0-9_]+$/,
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/, // SCREAMING_SNAKE
  /^\{.*\}$/, // template placeholder
  /^\d+(\.\d+)?$/, // numbers
];

/** Inline `//` allowlist: string value → why it stays hardcoded. */
const ALLOWED_VALUES = new Set([
  'Kimi Code',
  'Kimi',
  'Moonshot',
  'UTF-8',
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
]);

/** Per-file opt-out for components that are intentionally single-language. */
const ALLOWED_FILES = [
  // The vendored upstream shadcn primitives; their strings are re-exported
  // through the app's own locale files where they are user-visible.
  /webview-ui\/src\/components\/ui\//,
  // Wire-format vocabulary that must stay identical across locales.
  /webview-ui\/src\/lib\//,
  // Test fixtures are not rendered; their literals are data under test.
  /\.(?:test|spec)\.[jt]sx?$/,
];

function isAllowlistedLiteral(str) {
  const trimmed = str.trim();
  if (trimmed === '' || ALLOWED_VALUES.has(trimmed)) return true;
  return ALLOWED_LITERAL.some((re) => re.test(trimmed));
}

/**
 * `t('...')` / `$t('...')` anywhere on the line means the author is already
 * localizing; a literal elsewhere on the same line is a separate expression
 * (a key, a comparison target, a test fixture).
 */
function lineIsTranslating(line) {
  return /(?:^|[^\w.$])\$?t\(\s*['"`]/.test(line);
}

function scanDisplaySlots(line, relPath) {
  if (ALLOWED_FILES.some((re) => re.test(relPath))) return [];
  if (lineIsTranslating(line)) return [];

  const findings = [];
  // `label: '...'` / `title="..."` / `placeholder='...'`
  const slotRe = /\b(label|title|message|placeholder|aria-label|description|tooltip|heading|emptyText|emptyMessage|confirmText|cancelText|errorText|helperText|buttonText|actionText|bodyText|subtitle)\s*[:=]\s*(['"`])([^'"`]*)\2/g;
  // A data property earlier on the same line means the line is a record
  // literal, not a display slot: `{ id: 'x', label: 'Y' }` assigns a key, not
  // copy. Matched on the leading `name: '…'` shape so `value: 'Bash'` cannot
  // mask a real `label: 'Bash tool'` on the same line.
  const recordLiteral = /^\s*\{[^}]*\b(?:id|key|value|variant|kind|type|icon|severity|status|transport|role)\s*:\s*['"`]/;

  for (const m of line.matchAll(slotRe)) {
    const [, slot, , value] = m;
    if (!value) continue;
    if (recordLiteral.test(line)) continue;
    if (isAllowlistedLiteral(value)) continue;
    if (!looksLikeUserFacing(value)) continue;
    findings.push({ slot, value: value.trim() });
  }
  return findings;
}

function walkDir(dirPath, moduleInfo, valueToKeys, valueRegexes) {
  const findings = [];
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        if (moduleInfo.skipDirs?.includes(entry.name)) continue;
        findings.push(...walkDir(full, moduleInfo, valueToKeys, valueRegexes));
      } else {
        const ext = entry.name.slice(entry.name.lastIndexOf('.'));
        if (moduleInfo.fileTypes.includes(ext)) {
          try {
            const content = readFileSync(full, 'utf-8');
            findings.push(...scanFile(full, content, moduleInfo, valueToKeys, valueRegexes));
          } catch {
            // skip
          }
        }
      }
    }
  } catch {
    // skip
  }
  return findings;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const moduleFilter = args.find((a) => a.startsWith('--module='))?.split('=')[1];
  const outputFile = args.find((a) => a.startsWith('--output='))?.split('=')[1];

  const modulesToScan = moduleFilter ? MODULES.filter((m) => m.name === moduleFilter) : MODULES;

  if (modulesToScan.length === 0) {
    console.error(`Unknown module: ${moduleFilter}`);
    process.exit(1);
  }

  const allResults = {};

  for (const mod of modulesToScan) {
    const srcDir = join(ROOT, mod.srcDir);
    if (!existsSync(srcDir)) {
      console.log(`[${mod.name}] Source dir not found: ${mod.srcDir}`);
      continue;
    }

    console.log(`\n=== Loading locale files for ${mod.name} ===`);
    let valueToKeys;
    let valueRegexes;
    try {
      const localeData = await extractLocaleValues(mod);
      valueToKeys = localeData.valueToKeys;
      valueRegexes = localeData.valueRegexes;
      console.log(
        `  en: ${localeData.enLeaves.length} keys, zh: ${localeData.zhLeaves.length} keys`,
      );
      console.log(`  ${valueToKeys.size} unique value patterns`);
    } catch (error) {
      console.error(`  Failed to load locales: ${error.message}`);
      continue;
    }

    console.log(`\n=== Scanning ${mod.name} (${mod.srcDir}) ===`);
    const findings = walkDir(srcDir, mod, valueToKeys, valueRegexes);
    console.log(`  Found ${findings.length} issues`);

    // Group by type
    const byType = {};
    for (const f of findings) {
      byType[f.type] = (byType[f.type] || 0) + 1;
    }
    for (const [type, count] of Object.entries(byType)) {
      console.log(`    ${type}: ${Number(count)}`);
    }

    // Show sample findings (up to 100)
    if (findings.length > 0) {
      console.log(`\n  Sample findings (up to 100):`);
      for (const f of findings.slice(0, 100)) {
        const keyInfo = f.keys.length > 0 ? ` → ${f.keys[0]}` : '';
        console.log(`    ${f.file}:${f.line} [${f.type}] "${f.text}"${keyInfo}`);
      }
      if (findings.length > 100) {
        console.log(`    ... and ${findings.length - 100} more`);
      }
    }

    allResults[mod.name] = findings;
  }

  // Save report
  if (outputFile) {
    const outputPath = resolve(ROOT, outputFile);
    writeFileSync(outputPath, JSON.stringify(allResults, null, 2));
    console.log(`\nReport saved to: ${outputFile}`);
  }

  const totalFindings = Object.values(allResults).flat().length;
  console.log(`\nTotal: ${totalFindings} issues across ${Object.keys(allResults).length} modules`);
  process.exit(totalFindings > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
