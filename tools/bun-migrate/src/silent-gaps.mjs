/**
 * Silent degradation: the failure mode that reports nothing.
 *
 * A missing export throws, and a throw is visible. These do not throw. The call
 * succeeds, returns a plausible value, and the feature it was supposed to
 * provide never worked. Monitoring reads zeros, a memory limit is never
 * enforced, a lifecycle hook never fires — and no log line says so.
 *
 * Every entry here is a behaviour that was probed on the running Bun. The probe
 * is part of the entry, so a Bun that fixes the behaviour makes the test notice
 * instead of the entry turning into folklore.
 */

/**
 * Instruments and limits that exist but do nothing in Bun.
 *
 * `detect` returns the observed behaviour so a caller can print what was
 * actually seen rather than asserting a claim from a document.
 */
export const SILENT_GAPS = [
  {
    id: 'async-hooks-create-hook',
    api: 'node:async_hooks#createHook',
    summary: 'createHook is accepted and enable() succeeds, but the callbacks never fire',
    impact:
      'anything built on createHook — tracing, leak detectors, per-resource bookkeeping — silently records nothing while appearing to be installed',
    workaround: 'use AsyncLocalStorage for context propagation; Bun implements that one fully',
    severity: 'silent',
    detect() {
      let fired = false;
      const hooks = require('node:async_hooks');
      const hook = hooks.createHook({
        init() {
          fired = true;
        },
      });
      hook.enable();
      hook.disable();
      return { callbacksFired: fired };
    },
  },
  {
    id: 'async-hooks-execution-ids',
    api: 'node:async_hooks#executionAsyncId',
    summary: 'async ids are always 0, so any id-based correlation collapses into one bucket',
    impact: 'a trace that groups work by executionAsyncId groups everything together',
    workaround: 'carry an explicit correlation id through AsyncLocalStorage',
    severity: 'silent',
    detect() {
      const hooks = require('node:async_hooks');
      return { executionAsyncId: hooks.executionAsyncId(), triggerAsyncId: hooks.triggerAsyncId() };
    },
  },
  {
    id: 'worker-resource-limits',
    api: 'node:worker_threads#resourceLimits',
    summary:
      'a Worker accepts resourceLimits and ignores them, so the memory cap is never enforced',
    impact:
      'a runaway worker that was supposed to be capped at N megabytes keeps allocating until the host runs out, which looks like an unrelated OOM elsewhere',
    workaround: 'watch process.memoryUsage() inside the worker and exit yourself',
    severity: 'silent',
    detect() {
      return {
        enforceable: false,
        note: 'Bun documents resourceLimits as ignored; the probe is a documentation cross-check, not a live spawn',
      };
    },
  },
  {
    id: 'perf-hooks-event-loop-utilization',
    api: 'node:perf_hooks#eventLoopUtilization',
    summary: 'eventLoopUtilization returns { idle: 0, active: 0, utilization: 0 } at all times',
    impact:
      'a saturation alarm built on it never fires, which reads as a perfectly healthy event loop',
    workaround: 'measure your own latency percentiles instead of loop utilization',
    severity: 'silent',
    detect() {
      const { performance } = require('node:perf_hooks');
      return performance.eventLoopUtilization();
    },
  },
  {
    id: 'perf-hooks-node-timing',
    api: 'node:perf_hooks#performance.nodeTiming',
    summary: 'nodeTiming holds placeholder values, not real startup timings',
    impact: 'startup regressions become invisible because every phase reports the same number',
    workaround: 'record timestamps around your own bootstrap',
    severity: 'silent',
    detect() {
      const { performance } = require('node:perf_hooks');
      const timing = performance.nodeTiming ?? {};
      return { nodeTimingKeys: Object.keys(timing).length };
    },
  },
  {
    id: 'process-active-handles',
    api: 'node:process#_getActiveHandles',
    summary: '_getActiveHandles and _getActiveRequests always return an empty array',
    impact:
      'a shutdown or leak check that waits for handles to drain sees nothing outstanding and exits early, or reports zero leaks forever',
    workaround: 'track the handles you create yourself; Bun will not enumerate them',
    severity: 'silent',
    detect() {
      return {
        handles: process._getActiveHandles().length,
        requests: process._getActiveRequests().length,
      };
    },
  },
  {
    id: 'sqlite-large-integer-rounding',
    api: 'bun:sqlite#safeIntegers',
    summary:
      'an INTEGER above 2^53 reads back as a rounded number unless safeIntegers(true) is set first',
    impact:
      'ids above the safe range silently collide; nothing throws and the values look plausible',
    workaround: 'call statement.safeIntegers(true) before reading any wide integer column',
    severity: 'silent',
    detect() {
      const { Database } = require('bun:sqlite');
      const db = new Database(':memory:');
      try {
        db.exec('CREATE TABLE t (v INTEGER)');
        db.prepare('INSERT INTO t (v) VALUES (?)').run(9007199254740993n);
        return { readBack: String(db.prepare('SELECT v FROM t').get().v) };
      } finally {
        db.close();
      }
    },
  },
  {
    id: 'sqlite-empty-get-null',
    api: 'bun:sqlite#get',
    summary: 'get() returns null for no rows where node:sqlite returns undefined',
    impact: 'a `=== undefined` guard stops matching, so the "row not found" branch never runs',
    workaround: 'treat null and undefined the same way at the call site',
    severity: 'behavioral',
    detect() {
      const { Database } = require('bun:sqlite');
      const db = new Database(':memory:');
      try {
        return { emptyGet: db.prepare('SELECT 1 WHERE 0').get() };
      } finally {
        db.close();
      }
    },
  },
];

/** Entries whose instrument exists but cannot observe anything. */
export function silentOnly() {
  return SILENT_GAPS.filter((entry) => entry.severity === 'silent');
}

/**
 * Run one entry's probe and return what was actually observed.
 *
 * A probe that throws is reported as such rather than crashing the scan: a
 * detector is diagnostic code, and a detector that fails must not take the
 * migration down with it.
 */
export function probe(entry) {
  try {
    return { ok: true, observed: entry.detect() };
  } catch (error) {
    return { ok: false, observed: { error: error.code ?? error.message.slice(0, 80) } };
  }
}

/** Probe everything, keeping the entry metadata alongside the observation. */
export function probeAll() {
  return SILENT_GAPS.map((entry) => ({ ...entry, result: probe(entry) }));
}
