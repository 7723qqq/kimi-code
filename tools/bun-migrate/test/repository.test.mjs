/**
 * Whole-repository regression: run the tool against this repository and check
 * that the conclusions hold up on real code, not just on fixtures.
 *
 * kimi-code is already migrated, so the expected result is a small, explainable
 * set of source rewrites. If the tool suddenly wants to rewrite hundreds of
 * files here, a rule has become too aggressive.
 */
import { beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { join } from 'node:path';

setDefaultTimeout(120_000);

const CLI = join(import.meta.dir, '..', 'src', 'cli.mjs');
const REPO = join(import.meta.dir, '..', '..', '..');

let report;
let beforeStatus;
let afterStatus;

function gitStatus() {
  return Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: REPO }).stdout.toString();
}

/**
 * One scan for the whole suite.
 *
 * Each assertion used to spawn its own scan (three full-repository passes plus
 * two more for the write check). The scan is the expensive part, and its output
 * is immutable for the duration of the file, so the suite pays for it once.
 */
beforeAll(() => {
  beforeStatus = gitStatus();
  const result = Bun.spawnSync(
    ['bun', CLI, 'scan', '--root', REPO, '--json', '--only', 'config,tests,source'],
    { cwd: REPO },
  );
  if (result.exitCode !== 0) {
    throw new Error(`scan failed: ${result.stderr.toString().slice(0, 400)}`);
  }
  report = JSON.parse(result.stdout.toString());
  afterStatus = gitStatus();
});

function layerOf(name) {
  return report.layers.find((item) => item.name === name);
}

describe('scanning this repository', () => {
  it('finds nothing to rewrite in the already-migrated test layer', () => {
    const layer = layerOf('tests');
    expect(layer).toBeDefined();
    expect(layer.changes.length).toBe(0);
  });

  it('proposes a bounded, non-empty set of source rewrites', () => {
    const layer = layerOf('source');
    expect(layer).toBeDefined();
    expect(layer.changes.length).toBeGreaterThan(0);
    expect(layer.changes.length).toBeLessThan(200);
    for (const change of layer.changes) {
      expect(change.detail).toBeTruthy();
    }
  });

  it('skips build output, temporary directories and the tool itself', () => {
    const layer = layerOf('source');
    const banned = ['dist-native/', 'dist-web/', 'node_modules/'];
    const bannedPrefixes = ['.tmp/', 'tools/bun-migrate/test/', 'tools/bun-migrate/src/'];
    const offenders = layer.changes
      .map((change) => change.file)
      .filter(
        (file) =>
          banned.some((segment) => file.includes(segment)) ||
          bannedPrefixes.some((prefix) => file.startsWith(prefix)),
      );
    expect(JSON.stringify(offenders)).toBe('[]');
  });

  it('never touches a package that must run outside Bun', () => {
    const layer = layerOf('source');
    const denied = [
      'packages/pi-tui',
      'packages/transcript',
      'packages/i18n-shared',
      'apps/vscode',
      'apps/vis',
    ];
    const offenders = layer.changes
      .map((change) => change.file)
      .filter((file) => denied.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)));
    expect(JSON.stringify(offenders)).toBe('[]');
    expect(layer.changes.length).toBeGreaterThan(0);
  });

  it('leaves the working tree unchanged because scan writes nothing', () => {
    expect(afterStatus).toBe(beforeStatus);
  });

  it('reports the rule mix it would apply across the repository', () => {
    const layer = layerOf('source');
    const counts = new Map();
    for (const change of layer.changes) {
      for (const match of change.detail.matchAll(/([a-z]+-[A-Za-z]+)/g)) {
        const id = match[1];
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    expect(counts.size).toBeGreaterThan(0);
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    expect(total).toBeGreaterThanOrEqual(layer.changes.length);
  });
});
