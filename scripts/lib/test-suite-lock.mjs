import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

const BYPASS = 'off';
const HEARTBEAT_MS = 5_000;
const STALE_MS = 15_000;

function readOwner(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function lockAgeMs(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function acquireTestSuiteLock(root, command) {
  if (process.env['KIMI_TEST_SUITE_LOCK'] === BYPASS) return () => {};
  const dir = join(root, '.tmp');
  const path = join(dir, 'test-suite.lock');
  mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({
    pid: process.pid,
    command,
    startedAt: new Date().toISOString(),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, payload);
      closeSync(fd);
      const heartbeat = setInterval(() => {
        try {
          const now = new Date();
          utimesSync(path, now, now);
        } catch {}
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        try {
          unlinkSync(path);
        } catch {}
      };
      process.once('exit', release);
      process.once('SIGINT', () => {
        release();
        process.exit(130);
      });
      process.once('SIGTERM', () => {
        release();
        process.exit(143);
      });
      return release;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const age = lockAgeMs(path);
      if (age === undefined) continue;
      if (age < STALE_MS) {
        const owner = readOwner(path);
        process.stderr.write(
          `another test suite is already running (pid ${String(owner?.pid ?? '?')}, ${String(owner?.command ?? '?')}, started ${String(owner?.startedAt ?? '?')}).\n` +
            `lock: ${path} (heartbeat ${Math.round(age / 1000)}s ago)\n` +
            'wait for it to finish. KIMI_TEST_SUITE_LOCK=off bypasses the lock; a lock with no heartbeat for 15s is reclaimed automatically.\n',
        );
        process.exit(1);
      }
      try {
        unlinkSync(path);
      } catch (removeError) {
        if (removeError?.code !== 'ENOENT') throw removeError;
      }
    }
  }
  process.stderr.write(`could not acquire the test suite lock at ${path}\n`);
  process.exit(1);
}
