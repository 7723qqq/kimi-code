/**
 * The gap table must match a live enumeration, not memory.
 *
 * This test re-enumerates the `node:` surface on both runtimes and checks that
 * every public function Node has and Bun lacks is either recorded with a
 * workaround or explicitly acknowledged. A gap that appears without an entry
 * fails here instead of being discovered in production.
 */
import { describe, expect, it } from 'bun:test';

import { KNOWN_NODE_GAPS, memberExists } from '../src/node-gaps.mjs';

const nodeAvailable = (() => Bun.spawnSync(['node', '--version']).exitCode === 0)();

const MODULES = [
  'node:async_hooks',
  'node:console',
  'node:crypto',
  'node:diagnostics_channel',
  'node:dns',
  'node:dns/promises',
  'node:domain',
  'node:fs',
  'node:fs/promises',
  'node:module',
  'node:os',
  'node:path',
  'node:perf_hooks',
  'node:stream',
  'node:url',
  'node:util',
  'node:v8',
  'node:worker_threads',
  'node:zlib',
  'node:inspector',
  'node:repl',
  'node:wasi',
  'node:trace_events',
  'node:readline/promises',
];

/**
 * Public function exports that Node has, asked of one real Node process.
 *
 * Spawning Node once per module made this case take over five seconds under load
 * for no reason; the enumeration itself is a few hundred milliseconds. One
 * process returns every module's functions in a single pass.
 */
function nodeFunctionsByModule() {
  const script = `
    const modules = ${JSON.stringify(MODULES)};
    const out = {};
    for (const name of modules) {
      try {
        const m = require(name);
        const functions = [];
        for (const key of Object.getOwnPropertyNames(m)) {
          if (key.startsWith('_') || key === 'prototype' || key === '__esModule') continue;
          let type; try { type = typeof m[key]; } catch { type = 'threw'; }
          if (type === 'function') functions.push(key);
        }
        out[name] = functions;
      } catch {
        out[name] = [];
      }
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const result = Bun.spawnSync(['node', '-e', script]);
  if (result.exitCode !== 0) return;
  try {
    return JSON.parse(result.stdout.toString());
  } catch {
    return;
  }
}

describe('gap table matches the enumerated surface', () => {
  it('every public function Node has and Bun lacks is recorded', () => {
    if (!nodeAvailable) {
      throw new Error('node not on PATH: the surface would be unverified, not proven equal');
    }
    const functionsByModule = nodeFunctionsByModule();
    if (functionsByModule === undefined) {
      throw new Error('node enumeration failed: the surface would be unverified');
    }
    const unrecorded = [];
    for (const moduleName of MODULES) {
      for (const member of functionsByModule[moduleName] ?? []) {
        if (memberExists(moduleName, member)) continue;
        const recorded = KNOWN_NODE_GAPS.some(
          (gap) => gap.module === moduleName && gap.member === member,
        );
        if (!recorded) unrecorded.push(`${moduleName}#${member}`);
      }
    }
    expect(JSON.stringify(unrecorded)).toBe('[]');
  });

  it('records at least the gaps found by the enumeration run', () => {
    const expected = [
      'node:module#registerHooks',
      'node:module#stripTypeScriptTypes',
      'node:module#findPackageJSON',
      'node:module#getSourceMapsSupport',
      'node:module#setSourceMapsSupport',
      'node:util#transferableAbortController',
      'node:util#transferableAbortSignal',
      'node:util#diff',
      'node:util#getCallSite',
      'node:console#context',
      'node:console#createTask',
      'node:crypto#encapsulate',
      'node:crypto#decapsulate',
      'node:dns#resolveTlsa',
      'node:domain#Domain',
      'node:v8#queryObjects',
    ];
    const recorded = new Set(KNOWN_NODE_GAPS.map((gap) => `${gap.module}#${gap.member}`));
    for (const key of expected) {
      expect(`${key} recorded=${recorded.has(key)}`).toBe(`${key} recorded=true`);
    }
  });

  it('every recorded entry is still a gap, or says it should be retired', () => {
    for (const gap of KNOWN_NODE_GAPS) {
      if (memberExists(gap.module, gap.member)) {
        process.stdout.write(`NOTE: ${gap.module}#${gap.member} now exists on this Bun; retire the entry\n`);
      }
      expect(typeof gap.workaround).toBe('string');
      expect(gap.workaround.length).toBeGreaterThan(15);
    }
  });

  it('no entry names a private member or a constant', () => {
    for (const gap of KNOWN_NODE_GAPS) {
      expect(`${gap.member} private=${gap.member.startsWith('_')}`).toBe(`${gap.member} private=false`);
      expect(`${gap.member} constant=${/^[A-Z][A-Z0-9_]*$/.test(gap.member)}`).toBe(`${gap.member} constant=false`);
    }
  });
});

describe('the surface diff is reproducible', () => {
  it('runs the enumerator and gets a parseable result for both runtimes', () => {
    const script = `${import.meta.dir}/../src/enumerate-node.mjs`;
    const nodeRun = Bun.spawnSync(['node', script, 'node']);
    const bunRun = Bun.spawnSync(['bun', script, 'bun']);
    expect(nodeRun.exitCode).toBe(0);
    expect(bunRun.exitCode).toBe(0);
    const parse = (buffer) => {
      const firstLine = buffer.toString().trim().split('\n')[0];
      return JSON.parse(firstLine);
    };
    const nodeReport = parse(nodeRun.stdout);
    const bunReport = parse(bunRun.stdout);
    expect(Object.keys(nodeReport.modules).length).toBe(Object.keys(bunReport.modules).length);
    expect(Object.keys(nodeReport.modules).length).toBeGreaterThan(40);
  });

  it('enumerates nested constant objects on both sides', () => {
    const script = `${import.meta.dir}/../src/enumerate-node.mjs`;
    const parse = (buffer) => JSON.parse(buffer.toString().trim().split('\n')[0]);
    const nodeReport = parse(Bun.spawnSync(['node', script, 'node']).stdout);
    const bunReport = parse(Bun.spawnSync(['bun', script, 'bun']).stdout);
    for (const moduleName of ['node:http2', 'node:crypto', 'node:fs', 'node:zlib']) {
      expect(`${moduleName} node nested=${nodeReport.modules[moduleName].nested?.constants !== undefined}`).toBe(
        `${moduleName} node nested=true`,
      );
      expect(`${moduleName} bun nested=${bunReport.modules[moduleName].nested?.constants !== undefined}`).toBe(
        `${moduleName} bun nested=true`,
      );
    }
  });
});

describe('nested constants hide from a naive key listing', () => {
  it('http2 constants are enumerable on Bun and partly hidden on Node', () => {
    if (!nodeAvailable) throw new Error('node must be on PATH: every differential case compares two runtimes, so skipping it would report a pass that proves nothing');
    const script = `
      const c = require('node:http2').constants;
      process.stdout.write(JSON.stringify({
        own: Object.getOwnPropertyNames(c).length,
        enumerable: Object.keys(c).length,
      }));
    `;
    const nodeCounts = JSON.parse(Bun.spawnSync(['node', '-e', script]).stdout.toString());
    const bunConstants = require('node:http2').constants;
    const bunCounts = {
      own: Object.getOwnPropertyNames(bunConstants).length,
      enumerable: Object.keys(bunConstants).length,
    };
    expect(nodeCounts.own).toBeGreaterThan(nodeCounts.enumerable);
    expect(bunCounts.own).toBe(bunCounts.enumerable);
    expect(nodeCounts.own).toBeGreaterThan(bunCounts.own);
  });

  it('the non-enumerable ones are genuinely absent, not merely hidden', () => {
    const constants = require('node:http2').constants;
    for (const name of [
      'NGHTTP2_HCAT_REQUEST',
      'NGHTTP2_HCAT_RESPONSE',
      'NGHTTP2_NV_FLAG_NONE',
      'STREAM_OPTION_EMPTY_PAYLOAD',
      'STREAM_OPTION_GET_TRAILERS',
    ]) {
      expect(`${name}=${constants[name]}`).toBe(`${name}=undefined`);
    }
  });

  it('records both http2 constants in the gap table', () => {
    const recorded = KNOWN_NODE_GAPS.filter((gap) => gap.module === 'node:http2');
    expect(recorded.length).toBeGreaterThan(0);
    for (const gap of recorded) {
      expect(gap.workaround).toContain('constant');
    }
  });
});
