import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { CLOCK_FILE_ENV, HostClockService } from '#/os/backends/host/hostClockService';

const original = process.env[CLOCK_FILE_ENV];

function restore(): void {
  if (original === undefined) delete process.env[CLOCK_FILE_ENV];
  else process.env[CLOCK_FILE_ENV] = original;
}

describe('HostClockService', () => {
  afterEach(restore);

  it('reads an ISO-8601 time from the clock file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-clock-'));
    try {
      const file = join(dir, 'clock');
      writeFileSync(file, '2026-11-27T00:00:00.000Z', 'utf8');
      process.env[CLOCK_FILE_ENV] = file;
      expect(new HostClockService().now().toISOString()).toBe('2026-11-27T00:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a clock file that is not ISO-8601', () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-clock-'));
    try {
      const file = join(dir, 'clock');
      writeFileSync(file, 'not-a-date', 'utf8');
      process.env[CLOCK_FILE_ENV] = file;
      expect(() => new HostClockService().now()).toThrow(CLOCK_FILE_ENV);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the wall clock when the clock file is unset', () => {
    delete process.env[CLOCK_FILE_ENV];
    const before = Date.now();
    const now = new HostClockService().now().getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
