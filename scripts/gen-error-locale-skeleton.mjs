#!/usr/bin/env bun
/**
 * Scaffold `errorCodes.*` locale entries for engine error codes that lack them.
 *
 * `scripts/check-t-call-coverage.mjs` fails when an engine code has no locale
 * entry, because `formatLocalizedError` would otherwise show the raw English
 * sentence the engine threw. This script is the "make the right thing cheap"
 * half of that gate: it reads the engine registry, finds the missing codes in
 * each locale tree, and prints the entries to paste — or applies them with
 * `--write`, inserting a clearly marked block so a human still reviews the
 * English and the Chinese.
 *
 * Generated values are derived from the code itself (`provider.api_error` →
 * "Provider API error"), which is a starting point, not a translation. Rewrite
 * them before committing; the gate only checks presence, the reviewer checks
 * the words.
 *
 * Usage:
 *   bun scripts/gen-error-locale-skeleton.mjs           # print missing entries
 *   bun scripts/gen-error-locale-skeleton.mjs --write   # insert them, then review
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const LOCALES = {
  en: 'apps/kimi-code/src/i18n/locales/en.ts',
  zh: 'apps/kimi-code/src/i18n/locales/zh.ts',
};
const MARKER = '// ── errorCodes: generated skeleton ───────────────────────────────────────────';

const camelCaseCode = (code) =>
  code
    .split(/[._]/)
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');

const ACRONYMS = new Map([
  ['api', 'API'],
  ['lsp', 'LSP'],
  ['mcp', 'MCP'],
  ['ui', 'UI'],
  ['id', 'ID'],
  ['url', 'URL'],
  ['fs', 'filesystem'],
  ['os', 'system'],
  ['llm', 'model'],
  ['json', 'JSON'],
]);

/** Derive a readable English phrase from a code, e.g. `lsp.server_failed` → "Language server failed". */
function englishFromCode(code) {
  const parts = code.split('.');
  const domain = parts[0] ?? code;
  const rest = parts.slice(1);
  const domainLabel = {
    agent: 'Agent',
    attachment: 'Attachment',
    capability: 'Capability',
    debug: 'Debug',
    lsp: 'Language server',
    session_query: 'Session query',
    provider: 'Provider',
    state: 'State',
    wire: 'Wire',
    event: 'Event',
    storage: 'Storage',
    goal: 'Goal',
    model: 'Model',
    plugin: 'Plugin',
    skill: 'Skill',
    prompt_optimizer: 'Prompt optimizer',
    cron: 'Cron',
    file: 'File',
    fs: 'Filesystem',
    os: 'System',
    tool: 'Tool',
    team: 'Team',
    tower: 'Tower',
    spec: 'Spec',
    plan: 'Plan',
  }[domain];
  if (rest.length === 0) return `${domainLabel ?? domain} error`;
  const detail = rest
    .join(' ')
    .split(/[\s_]/)
    .filter((word) => word.length > 0)
    .map((word) => ACRONYMS.get(word.toLowerCase()) ?? word)
    .join(' ');
  const head = domainLabel ?? domain.replaceAll('_', ' ');
  return `${head} ${detail}`.trim();
}

async function loadLocaleKeys(localeFile) {
  const mod = await import(pathToFileURL(resolve(ROOT, localeFile)).href);
  const data = mod.default || mod;
  const keys = new Set();
  const walk = (obj, prefix = '') => {
    for (const key of Object.keys(obj)) {
      const full = prefix ? `${prefix}.${key}` : key;
      const value = obj[key];
      if (value !== null && typeof value === 'object') walk(value, full);
      else keys.add(full);
    }
  };
  walk(data);
  return keys;
}

function insertEntries(file, lines) {
  const path = resolve(ROOT, LOCALES[file]);
  const source = readFileSync(path, 'utf8');
  if (source.includes(MARKER)) {
    const updated = source.replace(MARKER, `${MARKER}\n${lines}`);
    writeFileSync(path, updated);
    return 'merged';
  }
  const anchor = '  errorCodes: {';
  const anchorIndex = source.indexOf(anchor);
  if (anchorIndex === -1) throw new Error(`no errorCodes block in ${LOCALES[file]}`);
  const insertAt = anchorIndex + anchor.length;
  const block = `\n    ${MARKER}\n${lines}`;
  writeFileSync(path, source.slice(0, insertAt) + block + source.slice(insertAt));
  return 'inserted';
}

const args = process.argv.slice(2);
const write = args.includes('--write');

const { ErrorCodes } = await import(
  pathToFileURL(resolve(ROOT, 'packages/agent-core-v2/src/errors.ts')).href
);
const codes = [...new Set(Object.values(ErrorCodes))].sort((a, b) => a.localeCompare(b));

const keysByLocale = {
  en: await loadLocaleKeys(LOCALES.en),
  zh: await loadLocaleKeys(LOCALES.zh),
};

const missing = codes.filter((code) =>
  ['en', 'zh'].some((lang) => !keysByLocale[lang].has(`errorCodes.${camelCaseCode(code)}`)),
);

if (missing.length === 0) {
  console.log('gen-error-locale-skeleton: every engine error code already has en+zh entries.');
  process.exit(0);
}

const linesFor = () =>
  missing
    .map((code) => {
      const key = camelCaseCode(code);
      const value = englishFromCode(code);
      return `    ${key}: '${value}',`;
    })
    .join('\n');

if (!write) {
  console.log(`gen-error-locale-skeleton: ${missing.length} code(s) missing.\n`);
  for (const lang of ['en', 'zh']) {
    console.log(`--- ${LOCALES[lang]} ---`);
    console.log(linesFor());
    console.log('');
  }
  console.log('Re-run with --write to insert them (review the wording before committing).');
  process.exit(0);
}

for (const lang of Object.keys(LOCALES)) {
  if (!existsSync(resolve(ROOT, LOCALES[lang]))) continue;
  const action = insertEntries(lang, linesFor());
  console.log(`gen-error-locale-skeleton: ${lang} ${action} (${missing.length} entries)`);
}
console.log('Review both trees: the generated English/Chinese are starting points.');
