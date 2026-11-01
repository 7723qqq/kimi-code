/**
 * Enumerate function signatures, not just their presence.
 *
 * `fn.length` is the number of declared parameters before the first default or
 * rest. A caller that branches on arity — argument-count checks, curry helpers,
 * proxy wrappers, promisify shims — takes a different path when the count moves.
 * `fn.name` matters for stack traces and for code that introspects a callback.
 *
 * This report captures both for every exported function of every node: module.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const MODULES = [
  'node:assert',
  'node:async_hooks',
  'node:buffer',
  'node:child_process',
  'node:cluster',
  'node:console',
  'node:crypto',
  'node:dgram',
  'node:diagnostics_channel',
  'node:dns',
  'node:dns/promises',
  'node:events',
  'node:fs',
  'node:fs/promises',
  'node:http',
  'node:http2',
  'node:https',
  'node:module',
  'node:net',
  'node:os',
  'node:path',
  'node:perf_hooks',
  'node:querystring',
  'node:readline',
  'node:stream',
  'node:stream/promises',
  'node:stream/web',
  'node:string_decoder',
  'node:timers/promises',
  'node:tls',
  'node:tty',
  'node:url',
  'node:util',
  'node:util/types',
  'node:v8',
  'node:vm',
  'node:worker_threads',
  'node:zlib',
];

const NESTED = new Set(['types', 'promises']);

const engine = process.argv[2];
const report = { engine, version: engine === 'bun' ? Bun.version : process.version, modules: {} };

function signature(fn) {
  return { length: fn.length, name: fn.name };
}

for (const name of MODULES) {
  let loaded;
  try {
    loaded = require(name);
  } catch (error) {
    report.modules[name] = { load: 'THROWS:' + (error.code ?? 'error') };
    continue;
  }
  const functions = {};
  const nested = {};
  for (const key of Object.getOwnPropertyNames(loaded)) {
    if (key === '__esModule' || key.startsWith('_') || key === 'prototype') continue;
    let value;
    try {
      value = loaded[key];
    } catch {
      continue;
    }
    if (typeof value === 'function') {
      functions[key] = signature(value);
      continue;
    }
    if (NESTED.has(key) && value !== null && typeof value === 'object') {
      const inner = {};
      for (const innerKey of Object.getOwnPropertyNames(value)) {
        let innerValue;
        try {
          innerValue = value[innerKey];
        } catch {
          continue;
        }
        if (typeof innerValue === 'function') inner[innerKey] = signature(innerValue);
      }
      nested[key] = inner;
    }
  }
  report.modules[name] = { load: 'ok', functions, nested };
}

process.stdout.write(JSON.stringify(report));
