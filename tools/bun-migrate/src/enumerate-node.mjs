/**
 * Enumerate every export of every node: module, on both runtimes.
 *
 * The output is the raw comparison that the gap tables are built from. Nothing
 * here decides anything; it only records what exists where, so the tables can be
 * checked against data instead of memory.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const MODULES = [
  'node:assert',
  'node:assert/strict',
  'node:async_hooks',
  'node:buffer',
  'node:child_process',
  'node:cluster',
  'node:console',
  'node:constants',
  'node:crypto',
  'node:dgram',
  'node:diagnostics_channel',
  'node:dns',
  'node:dns/promises',
  'node:domain',
  'node:events',
  'node:fs',
  'node:fs/promises',
  'node:http',
  'node:http2',
  'node:inspector',
  'node:inspector/promises',
  'node:repl',
  'node:wasi',
  'node:trace_events',
  'node:readline/promises',
  'node:https',
  'node:module',
  'node:net',
  'node:os',
  'node:path',
  'node:path/posix',
  'node:path/win32',
  'node:perf_hooks',
  'node:process',
  'node:punycode',
  'node:querystring',
  'node:readline',
  'node:readline/promises',
  'node:repl',
  'node:sqlite',
  'node:stream',
  'node:stream/consumers',
  'node:stream/promises',
  'node:stream/web',
  'node:string_decoder',
  'node:test',
  'node:timers',
  'node:timers/promises',
  'node:tls',
  'node:trace_events',
  'node:tty',
  'node:url',
  'node:util',
  'node:util/types',
  'node:v8',
  'node:vm',
  'node:wasi',
  'node:worker_threads',
  'node:zlib',
];

const engine = process.argv[2];
const report = { engine, version: engine === 'bun' ? Bun.version : process.version, modules: {} };

/**
 * Values worth descending into: plain objects that hold a bag of constants or
 * type predicates. A class prototype is not descended into, because its members
 * are inherited behaviour rather than a comparable surface.
 */
const NESTED_OBJECTS = new Set(['constants', 'types', 'posix', 'win32']);

function describe(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type !== 'object') return type;
  return 'object';
}

for (const name of MODULES) {
  let loaded;
  try {
    loaded = require(name);
  } catch (error) {
    report.modules[name] = { load: 'THROWS:' + (error.code ?? error.message.slice(0, 40)) };
    continue;
  }
  const members = {};
  const nested = {};
  for (const key of Object.getOwnPropertyNames(loaded)) {
    if (key === '__esModule') continue;
    let value;
    try {
      value = loaded[key];
    } catch {
      members[key] = 'throws-on-access';
      continue;
    }
    members[key] = describe(value);
    if (NESTED_OBJECTS.has(key) && value !== null && typeof value === 'object') {
      const inner = {};
      for (const innerKey of Object.getOwnPropertyNames(value)) {
        let innerValue;
        try {
          innerValue = value[innerKey];
        } catch {
          inner[innerKey] = 'throws-on-access';
          continue;
        }
        inner[innerKey] = describe(innerValue);
      }
      nested[key] = inner;
    }
  }
  report.modules[name] = { load: 'ok', members, nested };
}

process.stdout.write(JSON.stringify(report));
