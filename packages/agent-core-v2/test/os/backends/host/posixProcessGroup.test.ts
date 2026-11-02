import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

import { HostProcessService } from '#/os/backends/host/hostProcessService';
import { waitForAssertion } from '#test/helpers/waitFor';

const SKIP = process.platform === 'win32';
const MARKER_A = 'sleep 311';
const MARKER_B = 'sleep 312';

function findByCmdline(marker: string): number[] {
  const found: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (cmdline.replaceAll('\0', ' ').includes(marker)) found.push(Number(entry));
  }
  return found;
}

describe('posix process group kill', () => {
  it.skipIf(SKIP)('kills a detached process group including grandchildren via negative pid', async () => {
    const service = new HostProcessService();
    const proc = await service.spawn('sh', ['-c', `${MARKER_A} & ${MARKER_B} & wait`]);
    try {
      await waitForAssertion(
        () => {
          expect(findByCmdline(MARKER_A).length).toBeGreaterThan(0);
          expect(findByCmdline(MARKER_B).length).toBeGreaterThan(0);
        },
        { timeout: 5_000 },
      );
      await expect(proc.kill()).resolves.toBeUndefined();
      await waitForAssertion(
        () => {
          expect(findByCmdline(MARKER_A)).toEqual([]);
          expect(findByCmdline(MARKER_B)).toEqual([]);
        },
        { timeout: 5_000 },
      );
      await expect(proc.kill()).resolves.toBeUndefined();
    } finally {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {}
      await proc.dispose();
    }
  });
});
