/**
 * Enumerate the Bun-only surface: exports with no Node counterpart.
 *
 * The value here is not the list itself but the classification. A shared package
 * needs to know which Bun APIs would break it on Node, and "Bun.file exists"
 * alone does not answer that — "Bun.file replaces node:fs/promises readFile" does.
 */
const NODE_BASELINE = [
  'node:assert', 'node:async_hooks', 'node:buffer', 'node:child_process', 'node:cluster',
  'node:console', 'node:crypto', 'node:dgram', 'node:diagnostics_channel', 'node:dns',
  'node:events', 'node:fs', 'node:fs/promises', 'node:http', 'node:http2', 'node:https',
  'node:module', 'node:net', 'node:os', 'node:path', 'node:perf_hooks', 'node:querystring',
  'node:readline', 'node:stream', 'node:string_decoder', 'node:timers', 'node:tls', 'node:tty',
  'node:url', 'node:util', 'node:v8', 'node:vm', 'node:worker_threads', 'node:zlib',
];

const engine = process.argv[2];
const report = { engine, version: engine === 'bun' ? Bun.version : process.version, bunOnly: {}, nodeOnly: {} };

if (engine === 'bun') {
  const bunKeys = Object.keys(Bun).toSorted();
  for (const key of bunKeys) {
    const value = Bun[key];
    const type = typeof value;
    if (type === 'function') report.bunOnly[key] = { type: 'function', arity: value.length };
    else if (type === 'object' && value !== null) report.bunOnly[key] = { type: 'object', members: Object.keys(value).length };
    else report.bunOnly[key] = { type };
  }
} else {
  // 记录 Node 的等价能力，用于判断每个 Bun API 有没有对应物
  for (const name of NODE_BASELINE) {
    try {
      const loaded = require(name);
      report.nodeOnly[name] = Object.getOwnPropertyNames(loaded).filter((k) => !k.startsWith('_'));
    } catch {
      report.nodeOnly[name] = [];
    }
  }
}

process.stdout.write(JSON.stringify(report));
