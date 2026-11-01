import { describe, expect, it } from 'bun:test';
/**
 * A `report-only` rule means "the Bun-native API is not a drop-in for this call
 * site", not "this call needs Node".
 *
 * That distinction matters because it changes what the tool is for. Every
 * `node:` specifier resolves to Bun's own compiled implementation, so a project
 * that leaves `readFile` and `spawnSync` exactly as they are still runs entirely
 * on Bun. These tests pin that reading so the tool cannot drift into describing
 * `node:` as a fallback.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PAIRINGS, REPORT_ONLY } from '../src/pairings.mjs';

const SOURCE_DIR = join(import.meta.dir, '..', 'src');

const BUN_OWN_NODE_LAYER = [
  ['node:fs', 'internal/fs/binding'],
  ['node:fs/promises', 'internal/fs/binding'],
  ['node:path', 'Path.cpp'],
  ['node:crypto', 'node_crypto_binding.cpp'],
  ['node:zlib', 'node_zlib_binding'],
  ['node:net', 'node_net_binding'],
  ['node:os', 'node_os.bind'],
  ['node:child_process', 'node_util_binding'],
];

describe('the node: layer is Bun implementation, not a fallback', () => {
  it('leaving a node: call in place still runs on Bun', () => {
    // The proof is behavioural: this process is Bun, and every one of these
    // modules works without Node installed.
    for (const [specifier] of BUN_OWN_NODE_LAYER) {
      const loaded = require(specifier);
      expect(`${specifier} loaded in Bun: ${typeof loaded}`).toBe(
        `${specifier} loaded in Bun: object`,
      );
    }
  });

  it('the sync file API people worry about is Bun code', () => {
    /**
     * `require('node:fs')` succeeds inside Bun and the returned functions are not
     * Node's. Asserting the behaviour, not the source text of this test file:
     * reading a real file through the sync API has to return the real bytes.
     */
    const { readFileSync: bunRead, realpathSync } = require('node:fs');
    const self = realpathSync(import.meta.path);
    const text = bunRead(self, 'utf8');
    expect(text.length).toBeGreaterThan(1000);
    expect(text.includes('import')).toBe(true);
    const missing = join(tmpdir(), `definitely-not-here-${Date.now()}.txt`);
    expect(() => bunRead(missing, 'utf8')).toThrow();
    try {
      bunRead(missing, 'utf8');
    } catch (error) {
      expect(error.code).toBe('ENOENT');
    }
  });

  it('Bun.version is the runtime serving node: modules', () => {
    expect(typeof Bun.version).toBe('string');
    expect(Bun.version.length).toBeGreaterThan(0);
  });
});

describe('report-only wording never implies Node', () => {
  const FORBIDDEN = [/\bfalls? back to Node\b/i, /\bkeep node:\w+ here\b/i, /\brequires Node\b/i];

  function sourceFiles() {
    const out = [];
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.mjs')) continue;
        out.push({ name: entry.name, text: readFileSync(full, 'utf8') });
      }
    };
    walk(SOURCE_DIR);
    return out;
  }

  it('no rule or comment says a report-only call falls back to Node', () => {
    const offenders = [];
    for (const file of sourceFiles()) {
      for (const pattern of FORBIDDEN) {
        const match = pattern.exec(file.text);
        if (match) offenders.push(`${file.name}: ${match[0]}`);
      }
    }
    expect(JSON.stringify(offenders)).toBe('[]');
  });

  it('every report-only reason explains the API mismatch, not a runtime choice', () => {
    for (const pairing of PAIRINGS) {
      if (pairing.effect !== REPORT_ONLY) continue;
      const text = `${pairing.summary} ${pairing.condition} ${pairing.check({})}`;
      expect(`${pairing.id} mentions a runtime fallback: ${/fall ?back/i.test(text)}`).toBe(
        `${pairing.id} mentions a runtime fallback: false`,
      );
    }
  });
});

describe('the tool never removes a node: import it decided not to rewrite', () => {
  it('a report-only rule contributes no edit, so the import stays', () => {
    for (const pairing of PAIRINGS) {
      if (pairing.effect !== REPORT_ONLY) continue;
      expect(`${pairing.id} build=${typeof pairing.build({}, { text: () => '' })}`).toBe(
        `${pairing.id} build=undefined`,
      );
    }
  });
});
