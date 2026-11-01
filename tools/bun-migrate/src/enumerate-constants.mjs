/**
 * Enumerate constants with their values, not just their names.
 *
 * A key that exists on both sides can still hold a different number, which is
 * worse than a missing key: the code runs, the branch goes the wrong way, and
 * nothing throws. This report captures the values so the diff can compare them.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const TARGETS = [
  ['node:fs', 'constants'],
  ['node:crypto', 'constants'],
  ['node:os', 'constants'],
  ['node:zlib', 'constants'],
  ['node:buffer', 'constants'],
  ['node:http2', 'constants'],
  ['node:path', 'posix'],
  ['node:path', 'win32'],
  ['node:url', 'URL'],
];

const engine = process.argv[2];
const report = { engine, version: engine === 'bun' ? Bun.version : process.version, values: {} };

for (const [moduleName, parentName] of TARGETS) {
  let container;
  try {
    const loaded = require(moduleName);
    container = loaded[parentName];
  } catch (error) {
    report.values[`${moduleName}#${parentName}`] = { load: 'THROWS:' + (error.code ?? 'error') };
    continue;
  }
  if (container === undefined) {
    report.values[`${moduleName}#${parentName}`] = { load: 'MISSING' };
    continue;
  }
  const entries = {};
  for (const key of Object.getOwnPropertyNames(container)) {
    let value;
    try {
      value = container[key];
    } catch {
      entries[key] = { kind: 'throws' };
      continue;
    }
    const type = typeof value;
    if (type === 'number' || type === 'string' || type === 'boolean' || value === null) {
      entries[key] = { kind: 'scalar', type, value };
    } else if (type === 'function') {
      entries[key] = { kind: 'function' };
    } else if (type === 'object') {
      entries[key] = { kind: 'object' };
    } else {
      entries[key] = { kind: 'other', type };
    }
  }
  report.values[`${moduleName}#${parentName}`] = { load: 'ok', entries };
}

process.stdout.write(JSON.stringify(report));
