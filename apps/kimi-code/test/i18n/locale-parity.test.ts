import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import en from '#/i18n/locales/en';
import zh from '#/i18n/locales/zh';

/**
 * Guard: every translation key defined in the English base (`en`) must also
 * exist in every other locale.
 *
 * Why: the Rust translation engine falls back to the English message whenever
 * a key is missing in the active locale. A missing `zh` key therefore renders
 * silently in English — the exact "part of the UI reverted to English" symptom
 * users report. TypeScript does not catch this today because `zh` is a free
 * object literal, not typed against `typeof en`. This test closes that gap.
 *
 * If this fails, add the listed keys to the offending locale file (translating
 * the value). Do NOT delete keys from `en` to make it pass.
 */

type Nested = { [key: string]: string | Nested };

function flattenKeys(obj: Nested, prefix = '', out: string[] = []): string[] {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') {
      flattenKeys(v, key, out);
    } else {
      out.push(key);
    }
  }
  return out;
}

const LOCALES: Record<string, Nested> = {
  zh: zh as Nested,
};

describe('locale key parity', () => {
  const enKeys = flattenKeys(en as Nested).sort();

  for (const [name, locale] of Object.entries(LOCALES)) {
    it(`${name} defines every key present in en (missing keys fall back to English)`, () => {
      const localeKeys = new Set(flattenKeys(locale));
      const missing = enKeys.filter((k) => !localeKeys.has(k));
      expect(
        missing,
        `Locale "${name}" is missing ${String(missing.length)} key(s) that exist in en; ` +
          `these render in English at runtime. Add them to locales/${name}.ts:\n` +
          missing.map((k) => `  ${k}`).join('\n'),
      ).toEqual([]);
    });

    it(`${name} has no stale keys that no longer exist in en`, () => {
      const enSet = new Set(enKeys);
      const stale = flattenKeys(locale).filter((k) => !enSet.has(k));
      expect(
        stale,
        `Locale "${name}" has ${String(stale.length)} stale key(s) not present in en; ` +
          `remove them from locales/${name}.ts:\n` +
          stale.map((k) => `  ${k}`).join('\n'),
      ).toEqual([]);
    });
  }
});

/**
 * Guard: every literal `t('…')` key in the sources must resolve in `en`.
 *
 * Why: the two parity checks above only compare the locale files against each
 * other. They stay green when a `t()` call names a key no locale defines — for
 * example after a rename touched the call site but not the locale, which left
 * `tui.commands.provider.registryAuthRequired` rendering its raw key at the
 * user. `scripts/check-t-call-coverage.mjs` catches this in CI; this test keeps
 * it caught by the local suite too.
 *
 * Dynamic keys (`t('a.' + x)`) are skipped: their target is not statically
 * knowable, and guessing would produce false failures.
 */
describe('t() call coverage', () => {
  const enKeys = new Set(flattenKeys(en as Nested));

  it('every literal t() key in apps/kimi-code/src resolves in en', () => {
    const srcRoot = fileURLToPath(new URL('../../src', import.meta.url));
    const callRe = /\bt\(\s*'([^'\\]*)'/g;
    const unresolved: string[] = [];

    for (const file of walkTypescript(srcRoot)) {
      const code = readFileSync(file, 'utf8');
      for (const match of code.matchAll(callRe)) {
        const key = match[1];
        if (key === undefined || key.endsWith('.')) continue;
        if (!enKeys.has(key)) unresolved.push(`${key}  (${file.slice(srcRoot.length + 1)})`);
      }
    }

    expect(
      [...new Set(unresolved)].sort(),
      `These t() calls name keys that no locale defines; they render their raw ` +
        `key at the user. Add them to locales/en.ts and locales/zh.ts:\n` +
        unresolved.map((k) => `  ${k}`).join('\n'),
    ).toEqual([]);
  });
});

function* walkTypescript(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      yield* walkTypescript(path);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield path;
    }
  }
}
