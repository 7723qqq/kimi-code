/**
 * Meta-tests: prove the suite itself is Bun-native and cannot quietly stop
 * testing what it claims to test.
 *
 * A tool that migrates Node to Bun, whose own tests run on a Node framework,
 * would be unable to observe the differences it exists to find. This file reads
 * its own source tree and fails if that ever becomes true.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { parse, ts } from '../src/ast.mjs';

const TEST_DIR = import.meta.dir;
const SRC_DIR = join(TEST_DIR, '..', 'src');

function readAll(directory) {
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      out.push(...readAll(full));
      continue;
    }
    if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.ts')) continue;
    out.push({ path: full, name: entry.name, text: readFileSync(full, 'utf8') });
  }
  return out;
}

const TEST_FILES = readAll(TEST_DIR);
const SRC_FILES = readAll(SRC_DIR);

/** Package specifiers this file really imports as statements, not as text. */
function npmSpecifiersOf(text) {
  const sourceFile = parse('probe.mjs', text);
  const specifiers = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    specifiers.push(statement.moduleSpecifier.text);
  }
  return specifiers;
}

describe('the suite is Bun-native', () => {
  it('imports every assertion helper from bun:test', () => {
    const frameworks = new Set(['bun:test', 'vitest', 'jest', '@jest/globals', 'node:test', 'tap', 'mocha']);
    const offenders = [];
    for (const file of TEST_FILES) {
      if (!file.name.endsWith('.test.mjs')) continue;
      const seen = npmSpecifiersOf(file.text).filter((name) => frameworks.has(name));
      if (seen.length === 0) {
        offenders.push(`${file.name}: no framework import`);
        continue;
      }
      const bad = seen.filter((name) => name !== 'bun:test');
      if (bad.length > 0) offenders.push(`${file.name}: ${bad.join(', ')}`);
    }
    expect(JSON.stringify(offenders)).toBe('[]');
  });

  it('names no other test framework anywhere in a real import', () => {
    const offenders = [];
    const banned = new Set(['vitest', 'jest', '@jest/globals', 'node:test', 'tap', 'mocha', 'chai', 'sinon']);
    for (const file of TEST_FILES) {
      for (const specifier of npmSpecifiersOf(file.text)) {
        if (banned.has(specifier)) offenders.push(`${file.name}: ${specifier}`);
      }
    }
    expect(JSON.stringify(offenders)).toBe('[]');
  });

  it('does not rely on vi or jest globals in test bodies', () => {
    for (const file of TEST_FILES) {
      const offenders = [];
      const lines = file.text.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!/\b(vi\.(fn|spyOn|mock|useFakeTimers)|jest\.(fn|spyOn|mock))\s*\(/.test(line)) continue;
        const quoted = /['"`]vitest['"`]/.test(line);
        const startsString = /^\s*['"`]/.test(line) || /[+]\s*['"`]/.test(line);
        if (quoted || startsString) continue;
        offenders.push(`${file.name}:${index + 1}: ${line.trim()}`);
      }
      expect(`${file.name} real vi/jest usage: ${JSON.stringify(offenders)}`).toBe(
        `${file.name} real vi/jest usage: []`,
      );
    }
  });

  it('uses Bun APIs rather than Node shims for the things it measures', () => {
    const propertyFile = TEST_FILES.find((file) => file.name === 'properties.test.mjs');
    expect(propertyFile).toBeDefined();
    expect(propertyFile.text).toContain('new Bun.CryptoHasher');
    expect(propertyFile.text).toContain('Bun.gzipSync');
    expect(propertyFile.text).toContain('Bun.stripANSI');
    expect(propertyFile.text).toContain('Bun.deepEquals');
    expect(propertyFile.text).toContain('Bun.fileURLToPath');
  });

  it('runs the differential comparison through both runtimes', () => {
    const differential = TEST_FILES.find((file) => file.name === 'differential.test.mjs');
    expect(differential).toBeDefined();
    expect(differential.text).toContain("run('node'");
    expect(differential.text).toContain("run('bun'");
  });
});

describe('the source has no test-framework coupling', () => {
  it('imports nothing from vitest or jest', () => {
    const offenders = [];
    const banned = new Set(['vitest', 'jest', '@jest/globals', 'node:test', 'tap', 'mocha', 'chai', 'sinon']);
    for (const file of SRC_FILES) {
      for (const match of file.text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        if (banned.has(match[1])) offenders.push(`${file.name}: ${match[1]}`);
      }
    }
    expect(JSON.stringify(offenders)).toBe('[]');
  });

  it('carries no vitest call syntax in the migration tables', () => {
    const testsLayer = SRC_FILES.find((file) => file.name === 'tests.mjs');
    expect(testsLayer).toBeDefined();
    expect(testsLayer.text).toContain("'bun:test'");
    expect(/from\s+['"]vitest['"]/.test(testsLayer.text)).toBe(false);
  });
});
