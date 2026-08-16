/**
 * Generate JSON locale files from TypeScript locale sources.
 *
 * Usage: pnpm run generate:locale-json
 *
 * Reads each TS locale file and writes its JSON equivalent so the
 * Rust i18n engine can load them directly without runtime serialization.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// ── Locale source definitions ────────────────────────────────────────────────
// Each entry: { en, zh, out, extract? }
// extract is a function that extracts the locale data from the loaded module.

const LOCALE_SOURCES = [
  // The main i18n package — the single source of truth consumed by all packages at runtime
  {
    en: 'packages/i18n/src/locales/en.ts',
    zh: 'packages/i18n/src/locales/zh.ts',
    out: 'packages/i18n/src/locales',
  },
  // Per-package subsets used for package-level JSON generation
  {
    en: 'apps/kimi-code/src/i18n/locales/en.ts',
    zh: 'apps/kimi-code/src/i18n/locales/zh.ts',
    out: 'apps/kimi-code/src/i18n/locales',
  },
  {
    en: 'packages/kap-server/src/i18n-locales/en.ts',
    zh: 'packages/kap-server/src/i18n-locales/zh.ts',
    out: 'packages/kap-server/src/i18n-locales',
  },
  {
    en: 'apps/kimi-inspect/src/i18n/locales/en.ts',
    zh: 'apps/kimi-inspect/src/i18n/locales/zh.ts',
    out: 'apps/kimi-inspect/src/i18n/locales',
  },
  {
    en: 'apps/vis/web/src/i18n/locales/en.ts',
    zh: 'apps/vis/web/src/i18n/locales/zh.ts',
    out: 'apps/vis/web/src/i18n/locales',
  },
  {
    en: 'apps/vscode/webview-ui/src/i18n/locales/en.ts',
    zh: 'apps/vscode/webview-ui/src/i18n/locales/zh.ts',
    out: 'apps/vscode/webview-ui/src/i18n/locales',
  },
  // kimi-web: index.ts exports { messages: { en: {...}, zh: {...} } }.
  // Its namespace imports are extensionless (Vite convention, see
  // apps/kimi-web/AGENTS.md), which the Node ESM loader cannot resolve, so
  // this entry is loaded via the kimiWeb directory loader below
  // (namespace key == file basename, matching index.ts registrations).
  {
    src: 'apps/kimi-web/src/i18n/locales',
    out: 'apps/kimi-web/src/i18n/locales',
    kimiWeb: true,
  },
];

let generated = 0;

for (const source of LOCALE_SOURCES) {
  // Determine paths based on whether this is a simple or complex entry
  let enPath, zhPath, outDir, extractFn;

  if (source.extract) {
    // Complex entry: single src file, extract function
    enPath = path.resolve(ROOT, source.src);
    zhPath = enPath; // same file
    outDir = path.resolve(ROOT, source.out);
    extractFn = source.extract;
  } else if (source.kimiWeb) {
    // kimi-web entry: src is the locales directory; namespaces are loaded
    // per file below (key == basename), so no module-level require happens.
    outDir = path.resolve(ROOT, source.out);
    extractFn = undefined;
  } else {
    enPath = path.resolve(ROOT, source.en);
    zhPath = path.resolve(ROOT, source.zh);
    outDir = path.resolve(ROOT, source.out);
    extractFn = (mod) => ({ en: mod.default || mod, zh: null }); // will be replaced
  }

  try {
    let enData, zhData;

    if (source.kimiWeb) {
      const loadDir = (locale) => {
        const dir = path.join(outDir, locale);
        const out = {};
        // readdirSync order is filesystem-dependent — sort so generated JSON
        // (and the CI freshness diff) is deterministic across machines.
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()) {
          const name = file.slice(0, -'.ts'.length);
          const mod = require(path.join(dir, file));
          out[name] = mod.default ?? mod;
        }
        return out;
      };
      enData = loadDir('en');
      zhData = loadDir('zh');
    } else {
      const enModule = require(enPath);
      if (source.extract) {
        // Use the extract function to get both en and zh from the same module
        const extracted = extractFn(enModule);
        enData = extracted.en;
        zhData = extracted.zh;
      } else {
        const zhModule = require(zhPath);
        enData = enModule.default || enModule;
        zhData = zhModule.default || zhModule;
      }
    }

    fs.mkdirSync(outDir, { recursive: true });

    fs.writeFileSync(path.resolve(outDir, 'en.json'), JSON.stringify(enData, null, 2) + '\n');
    fs.writeFileSync(path.resolve(outDir, 'zh.json'), JSON.stringify(zhData, null, 2) + '\n');

    const enSize = fs.statSync(path.resolve(outDir, 'en.json')).size;
    const zhSize = fs.statSync(path.resolve(outDir, 'zh.json')).size;
    console.log(`✓ ${source.out}/en.json (${(enSize / 1024).toFixed(0)} KB)`);
    console.log(`✓ ${source.out}/zh.json (${(zhSize / 1024).toFixed(0)} KB)`);
    generated++;
  } catch (error) {
    console.error(`✗ ${source.out}: ${error.message}`);
    if (error.stack) console.error(error.stack.split('\n').slice(0, 3).join('\n'));
  }
}

console.log(`\nDone. Generated ${generated * 2} JSON locale files.`);
