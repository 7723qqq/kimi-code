import { createRequire } from 'node:module';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { createKimiHarness, flushDiagnosticLogs, log } from '#/index';
import { __resetRootLoggerForTest, getRootLogger, RotatingFileSink } from '#/logging/index';

import { TEST_IDENTITY } from './test-identity';

// A transparent `open()` wrapper: real file handles everywhere, except that an
// append whose payload contains `sinkFault.failOn` rejects with EIO. Lets the
// sink tests simulate a mid-batch disk failure (ENOSPC/EIO) without touching
// the fs layer the harness tests in this file depend on. `attempts` counts
// every append, which is the file-level work one drain performs.
const sinkFault: { failOn: string | undefined; attempts: number } = {
  failOn: undefined,
  attempts: 0,
};

const SINK_FAULT_MARKER = '@@sink-fault@@';

// Bun calls the factory with no arguments and a module cannot import the
// specifier it is replacing, so the real namespace comes from `createRequire`.
void mock.module('node:fs/promises', () => {
  const actual = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const original = handle.appendFile.bind(handle) as (
        data: string | Uint8Array,
        ...rest: unknown[]
      ) => Promise<void>;
      (handle as unknown as { appendFile: unknown }).appendFile = async (
        data: string | Uint8Array,
        ...rest: unknown[]
      ): Promise<void> => {
        const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8');
        const marker = sinkFault.failOn;
        sinkFault.attempts++;
        if (marker !== undefined && text.includes(marker)) {
          throw Object.assign(new Error('EIO: simulated append failure'), { code: 'EIO' });
        }
        await original(data, ...rest);
      };
      return handle;
    },
  };
});

const tempDirs: string[] = [];

const LOG_ENV_KEYS = [
  'KIMI_LOG_LEVEL',
  'KIMI_LOG_GLOBAL_MAX_BYTES',
  'KIMI_LOG_GLOBAL_FILES',
  'KIMI_LOG_SESSION_MAX_BYTES',
  'KIMI_LOG_SESSION_FILES',
] as const;

beforeEach(async () => {
  process.env['KIMI_LOG_LEVEL'] = 'info';
  await __resetRootLoggerForTest();
});

afterEach(async () => {
  await __resetRootLoggerForTest();
  process.env['KIMI_LOG_LEVEL'] = 'off';
  for (const dir of tempDirs.splice(0)) {
    // Retry like session-runtime-helpers.removeTempDir: an engine's async
    // wire flush can recreate a file while the tree is being removed.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function snapshotLogEnv(): Record<(typeof LOG_ENV_KEYS)[number], string | undefined> {
  return Object.fromEntries(LOG_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof LOG_ENV_KEYS)[number],
    string | undefined
  >;
}

function restoreLogEnv(snapshot: Record<(typeof LOG_ENV_KEYS)[number], string | undefined>): void {
  for (const key of LOG_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('Local logging — harness integration', () => {
  it('multiple KimiHarness constructions in the same process do not throw', async () => {
    const homeDir = await makeTempDir('kimi-log-home-');
    expect(() => createKimiHarness({ identity: TEST_IDENTITY, homeDir })).not.toThrow();
    expect(() => createKimiHarness({ identity: TEST_IDENTITY, homeDir })).not.toThrow();
    expect(() => createKimiHarness({ identity: TEST_IDENTITY, homeDir })).not.toThrow();
  });

  it('SDK index exposes the log surface but not the root logger internals', async () => {
    // Type-level check — if these names show up on the SDK index they must
    // be re-exports we forgot to filter. Use string keys so the assertion is
    // structural and survives renames.
    const sdk = await import('#/index');
    const exposed = Object.keys(sdk);
    expect(exposed).toContain('log');
    expect(exposed).toContain('flushDiagnosticLogs');
    expect(exposed).toContain('configureDiagnosticLogging');
    expect(exposed).not.toContain('getLogger');
    expect(exposed).not.toContain('getRootLogger');
    expect(exposed).not.toContain('installProcessCrashHandlers');
  });

  it('writes host-side log lines after harness construction without a manual configure', async () => {
    const homeDir = await makeTempDir('kimi-log-home-');
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    try {
      log.error('boom');
      await flushDiagnosticLogs();
      const text = await readFile(join(homeDir, 'logs', 'kimi-code.log'), 'utf-8');
      expect(text).toContain('boom');
    } finally {
      await harness.close();
    }
  });

  it('checks that an empty session log directory does not get a log file', async () => {
    // Sanity: if level is off, no log files should be created
    const env = snapshotLogEnv();
    process.env['KIMI_LOG_LEVEL'] = 'off';
    try {
      const homeDir = await makeTempDir('kimi-log-home-');
      const workDir = await makeTempDir('kimi-log-work-');
      const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
      await harness.createSession({ id: 'ses_off', workDir });
      log.error('this should not write');
      let logsDir: string[] = [];
      try {
        logsDir = await readdir(join(homeDir, 'logs'));
      } catch {
        // intentional — directory may not exist when level=off
      }
      expect(logsDir).not.toContain('kimi-code.log');
      await harness.close();
    } finally {
      restoreLogEnv(env);
    }
  });
});

describe('Local logging — port unit behavior', () => {
  it('formats entries with redaction and context pairs', async () => {
    const homeDir = await makeTempDir('kimi-log-home-');
    const root = getRootLogger();
    await root.configure({
      level: 'info',
      globalLogPath: join(homeDir, 'logs', 'kimi-code.log'),
      globalMaxBytes: 1 << 20,
      globalFiles: 2,
      sessionMaxBytes: 1 << 20,
      sessionFiles: 2,
    });

    log.warn('secret leak', { apiKey: 'sk-super-secret', sessionId: 'ses_1' });
    await flushDiagnosticLogs();

    const text = await readFile(join(homeDir, 'logs', 'kimi-code.log'), 'utf-8');
    expect(text).toContain('WARN ');
    expect(text).toContain('secret leak');
    expect(text).toContain('sessionId=ses_1');
    expect(text).not.toContain('sk-super-secret');
    expect(text).toContain('[REDACTED]');
    await __resetRootLoggerForTest();
  });

  it('level filtering drops entries below the configured threshold', async () => {
    const homeDir = await makeTempDir('kimi-log-home-');
    await getRootLogger().configure({
      level: 'warn',
      globalLogPath: join(homeDir, 'logs', 'kimi-code.log'),
      globalMaxBytes: 1 << 20,
      globalFiles: 2,
      sessionMaxBytes: 1 << 20,
      sessionFiles: 2,
    });

    log.info('info should be filtered');
    log.warn('warn should land');
    await flushDiagnosticLogs();

    const text = await readFile(join(homeDir, 'logs', 'kimi-code.log'), 'utf-8');
    expect(text).toContain('warn should land');
    expect(text).not.toContain('info should be filtered');
    await __resetRootLoggerForTest();
  });
});


describe('RotatingFileSink — partial drain recovery', () => {
  // One line per chunk: small enough that a failure on the second chunk means
  // the first one was already written (and rotated) to disk.
  const SINK_MAX_BYTES = 64;
  const SINK_FILES = 5;

  function makeSink(path: string, now?: () => number): RotatingFileSink {
    return new RotatingFileSink({ path, maxBytes: SINK_MAX_BYTES, files: SINK_FILES, now });
  }

  // Rotation moves `kimi-code.log` to `.1`, `.2`, …; a line's fate can only be
  // judged against the whole tree.
  async function readLogTree(logPath: string): Promise<string> {
    const dir = dirname(logPath);
    const name = basename(logPath);
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return '';
    }
    const parts: string[] = [];
    for (const file of names.filter((n) => n === name || n.startsWith(`${name}.`)).sort()) {
      parts.push(await readFile(join(dir, file), 'utf-8'));
    }
    return parts.join('');
  }

  // The drain waits on fs work that hops through the threadpool; under the Bun
  // runtime `setImmediate` does not join those callbacks, so wait on real
  // timers. The retry clock is injected into the sink, never faked here, so
  // `setTimeout` still elapses.
  async function settle(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }

  beforeEach(() => {
    sinkFault.failOn = undefined;
    sinkFault.attempts = 0;
  });

  afterEach(() => {
    sinkFault.failOn = undefined;
    sinkFault.attempts = 0;
  });

  it('does not rewrite a chunk that already reached the file when a later chunk fails', async () => {
    const homeDir = await makeTempDir('kimi-log-sink-');
    const logPath = join(homeDir, 'logs', 'kimi-code.log');
    const sink = makeSink(logPath);
    const first = `first-chunk-${'p'.repeat(40)}\n`;
    const second = `second-chunk-${SINK_FAULT_MARKER}\n`;
    const third = `third-chunk-${'p'.repeat(40)}\n`;

    // The fault is armed before the first line is queued, so the drain the
    // sink schedules from `enqueue` (a microtask) fails too — the failing
    // path is what is under test, not a lucky successful write.
    sinkFault.failOn = SINK_FAULT_MARKER;
    sink.enqueue(first);
    sink.enqueue(second);
    sink.enqueue(third);
    expect(await sink.flush()).toBe(false);

    sinkFault.failOn = undefined;
    expect(await sink.flush()).toBe(true);

    const text = await readLogTree(logPath);
    // The first chunk landed before the failure; re-queuing the whole batch
    // wrote it a second time.
    expect(text.split(first).length - 1).toBe(1);
    expect(text).toContain('second-chunk-');
    expect(text).toContain('third-chunk-');
  });

  it('reports buffered entries dropped on close when the final drain still fails', async () => {
    const homeDir = await makeTempDir('kimi-log-sink-');
    const logPath = join(homeDir, 'logs', 'kimi-code.log');
    const sink = makeSink(logPath);
    sinkFault.failOn = SINK_FAULT_MARKER;
    sink.enqueue(`doomed-a-${SINK_FAULT_MARKER}\n`);
    sink.enqueue(`doomed-b-${SINK_FAULT_MARKER}\n`);

    const stderrChunks: string[] = [];
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    try {
      await sink.close();
    } finally {
      writeSpy.mockRestore();
      sinkFault.failOn = undefined;
    }

    const dropped = stderrChunks.find((chunk) => chunk.includes('dropped'));
    expect(dropped).toBeDefined();
    expect(dropped).toContain('2');
  });

  it('rate-limits automatic retries of a permanently failing sink, but never an explicit flush', async () => {
    const homeDir = await makeTempDir('kimi-log-sink-');
    const logPath = join(homeDir, 'logs', 'kimi-code.log');
    // A clock the test drives: the retry deadline set by the first failure
    // stays in the future until the test advances it, so this measures the
    // gate, not the scheduler, while real timers keep `settle` working.
    let clock = Date.now();
    const sink = makeSink(logPath, () => clock);
    const now = clock;
    sinkFault.failOn = SINK_FAULT_MARKER;

    // A synchronous burst — every `enqueue` queues its own drain microtask.
    // Ungated this is one append attempt per line; the burst itself may cost a
    // couple of attempts before the deadline is set, so allow that slack and
    // still fail hard on per-line amplification.
    for (let i = 0; i < 100; i++) {
      sink.enqueue(`burst-${i}-${SINK_FAULT_MARKER}\n`);
    }
    await settle();
    const afterBurst = sinkFault.attempts;
    expect(afterBurst).toBeGreaterThan(0);
    expect(afterBurst).toBeLessThanOrEqual(3);

    // Lines written inside the backoff window must not re-drive the batch.
    for (let i = 0; i < 100; i++) {
      sink.enqueue(`window-${i}-${SINK_FAULT_MARKER}\n`);
    }
    await settle();
    expect(sinkFault.attempts).toBe(afterBurst);

    // Shutdown paths are not gated: an explicit flush still attempts now.
    expect(await sink.flush()).toBe(false);
    expect(sinkFault.attempts).toBe(afterBurst + 1);

    // Past the deadline the sink retries on its own again, without a flush.
    clock = now + 60_000;
    sink.enqueue(`after-deadline-${SINK_FAULT_MARKER}\n`);
    await settle();
    expect(sinkFault.attempts).toBe(afterBurst + 2);
  });
});
