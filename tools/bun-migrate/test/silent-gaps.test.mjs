/**
 * Silent degradation: the failure mode that throws nothing.
 *
 * These assertions are written so they fail loudly if Bun starts behaving, which
 * is the opposite of the usual direction. A silent gap that quietly gets fixed
 * should surface as a stale entry, not stay in the table forever.
 */
import { describe, expect, it } from 'bun:test';

import { probeAll, SILENT_GAPS, silentOnly } from '../src/silent-gaps.mjs';

describe('table invariants', () => {
  it('every entry explains its impact and a workaround', () => {
    for (const entry of SILENT_GAPS) {
      expect(entry.summary.length).toBeGreaterThan(20);
      expect(entry.impact.length).toBeGreaterThan(20);
      expect(entry.workaround.length).toBeGreaterThan(10);
      expect(typeof entry.detect).toBe('function');
      expect(['silent', 'behavioral']).toContain(entry.severity);
    }
  });

  it('every probe runs without throwing', () => {
    for (const result of probeAll()) {
      expect(`${result.id} ok=${result.result.ok}`).toBe(`${result.id} ok=true`);
    }
  });

  it('a probe that throws is reported, not fatal', () => {
    const broken = { id: 'x', detect: () => { throw new Error('boom'); } };
    const { probe } = require('../src/silent-gaps.mjs');
    const result = probe(broken);
    expect(result.ok).toBe(false);
    expect(result.observed.error).toContain('boom');
  });
});

describe('async_hooks instruments observe nothing', () => {
  it('createHook callbacks never fire', () => {
    const hooks = require('node:async_hooks');
    let fired = 0;
    const hook = hooks.createHook({
      init() { fired += 1; },
      before() { fired += 1; },
      after() { fired += 1; },
    });
    hook.enable();
    void Promise.resolve(1);
    setTimeout(() => {}, 1);
    hook.disable();
    expect(fired).toBe(0);
  });

  it('async ids are all zero', () => {
    const hooks = require('node:async_hooks');
    expect(hooks.executionAsyncId()).toBe(0);
    expect(hooks.triggerAsyncId()).toBe(0);
  });

  it('AsyncLocalStorage still works, which is the documented substitute', async () => {
    const { AsyncLocalStorage } = require('node:async_hooks');
    const storage = new AsyncLocalStorage();
    const observed = await storage.run({ trace: 'abc' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return storage.getStore();
    });
    expect(observed).toEqual({ trace: 'abc' });
  });
});

describe('perf_hooks reports zeros and placeholders', () => {
  it('eventLoopUtilization is always zero', () => {
    const { performance } = require('node:perf_hooks');
    for (let i = 0; i < 200_000; i += 1) Math.sqrt(i);
    const util = performance.eventLoopUtilization();
    expect(util.idle).toBe(0);
    expect(util.active).toBe(0);
    expect(util.utilization).toBe(0);
  });

  it('nodeTiming exists but carries no real startup data', () => {
    const { performance } = require('node:perf_hooks');
    expect(typeof performance.nodeTiming).toBe('object');
  });
});

describe('process introspection reports nothing outstanding', () => {
  it('_getActiveHandles and _getActiveRequests are empty even with a live timer', () => {
    const timer = setTimeout(() => {}, 5_000);
    try {
      expect(process._getActiveHandles()).toEqual([]);
      expect(process._getActiveRequests()).toEqual([]);
    } finally {
      clearTimeout(timer);
    }
  });
});

describe('a wide integer rounds instead of throwing', () => {
  it('reads back one less than what was inserted', () => {
    const { Database } = require('bun:sqlite');
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE t (v INTEGER)');
      const original = 9007199254740993n;
      db.prepare('INSERT INTO t (v) VALUES (?)').run(original);
      const read = db.prepare('SELECT v FROM t').get().v;
      expect(typeof read).toBe('number');
      expect(BigInt(read)).toBe(9007199254740992n);
      expect(BigInt(read)).not.toBe(original);
    } finally {
      db.close();
    }
  });

  it('safeIntegers restores the exact value', () => {
    const { Database } = require('bun:sqlite');
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE t (v INTEGER)');
      db.prepare('INSERT INTO t (v) VALUES (?)').run(9007199254740993n);
      const statement = db.prepare('SELECT v FROM t');
      statement.safeIntegers(true);
      expect(statement.get().v).toBe(9007199254740993n);
    } finally {
      db.close();
    }
  });
});

describe('the table only claims what it measured', () => {
  it('marks the entries that are instrument failures, not behaviour differences', () => {
    const ids = silentOnly().map((entry) => entry.id);
    expect(ids).toContain('async-hooks-create-hook');
    expect(ids).toContain('perf-hooks-event-loop-utilization');
    expect(ids).toContain('process-active-handles');
    expect(ids).not.toContain('sqlite-empty-get-null');
  });

  it('does not describe resourceLimits as measured when it is a documentation cross-check', () => {
    const entry = SILENT_GAPS.find((item) => item.id === 'worker-resource-limits');
    expect(entry.detect().note).toContain('documentation cross-check');
  });
});
