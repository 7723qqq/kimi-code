import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKimiHarness, flushDiagnosticLogs, log } from '#/index';
import { __resetRootLoggerForTest, getRootLogger } from '#/legacy';
import { TEST_IDENTITY } from './test-identity';

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

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
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
  it('a created harness configures the global diagnostic log for the harness home', async () => {
    const homeDir = await makeTempDir('kimi-log-home-');
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    log.warn('untagged event');
    await flushDiagnosticLogs();

    const globalPath = join(homeDir, 'logs', 'kimi-code.log');
    const text = await readFile(globalPath, 'utf-8');
    expect(text).toContain('untagged event');
    await harness.close();
  });

  it('session-tagged entries land in the global log (no per-session SDK sinks anymore)', async () => {
    const homeDir = await makeTempDir('kimi-log-home-');
    const workDir = await makeTempDir('kimi-log-work-');
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    const session = await harness.createSession({ id: 'ses_logging_int', workDir });

    // The v1 per-session log routing is gone with the v1 client: the SDK
    // root logger keeps `sessionId` as context on the global entry.
    log.warn('session diagnostic', { sessionId: session.id });
    await flushDiagnosticLogs();

    const globalPath = join(homeDir, 'logs', 'kimi-code.log');
    const text = await readFile(globalPath, 'utf-8');
    expect(text).toContain('session diagnostic');
    expect(text).toContain('ses_logging_int');
    await harness.close();
  });

  it('multiple KimiHarness constructions in the same process do not throw', async () => {
    const homeDir = await makeTempDir('kimi-log-home-');
    expect(() => createKimiHarness({ identity: TEST_IDENTITY, homeDir })).not.toThrow();
    expect(() => createKimiHarness({ identity: TEST_IDENTITY, homeDir })).not.toThrow();
    expect(() => createKimiHarness({ identity: TEST_IDENTITY, homeDir })).not.toThrow();
  });

  it('uses the latest harness homeDir for global diagnostic logging', async () => {
    const firstHome = await makeTempDir('kimi-log-home-a-');
    const secondHome = await makeTempDir('kimi-log-home-b-');
    const first = createKimiHarness({ identity: TEST_IDENTITY, homeDir: firstHome });
    const second = createKimiHarness({ identity: TEST_IDENTITY, homeDir: secondHome });

    log.warn('second-home-marker');
    await flushDiagnosticLogs();

    const firstLog = await readOptionalFile(join(firstHome, 'logs', 'kimi-code.log'));
    const secondLog = await readFile(join(secondHome, 'logs', 'kimi-code.log'), 'utf-8');
    expect(firstLog).not.toContain('second-home-marker');
    expect(secondLog).toContain('second-home-marker');

    await first.close();
    await second.close();
  });

  it('SDK index exposes the log surface but not the root logger internals', async () => {
    // Type-level check — if these names show up on the SDK index they must
    // be re-exports we forgot to filter. Use string keys so the assertion is
    // structural and survives renames.
    const sdk = await import('#/index');
    const exposed = Object.keys(sdk);
    expect(exposed).toContain('log');
    expect(exposed).toContain('flushDiagnosticLogs');
    expect(exposed).not.toContain('getLogger');
    expect(exposed).not.toContain('getRootLogger');
    expect(exposed).not.toContain('installProcessCrashHandlers');
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

  it('KimiHarness.close() flushes the global log', async () => {
    const homeDir = await makeTempDir('kimi-log-home-');
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    log.warn('untagged before close');
    // No `await flush()` here on purpose — close() must do it.
    await harness.close();
    const globalPath = join(homeDir, 'logs', 'kimi-code.log');
    const text = await readFile(globalPath, 'utf-8');
    expect(text).toContain('untagged before close');
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
