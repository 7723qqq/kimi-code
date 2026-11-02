import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SKIP_REASON =
  process.platform !== 'linux'
    ? `pty probe requires Linux script(1); platform is ${process.platform}`
    : Bun.which('script') === null
      ? 'util-linux script(1) is not on PATH'
      : undefined;

if (SKIP_REASON !== undefined) {
  console.log(`ptyResize probe skipped: ${SKIP_REASON}`);
}

const PROBE_SOURCE = `
let resizeCount = 0;
let columnsAtResize = 0;
process.stdout.on('resize', () => {
  resizeCount += 1;
  columnsAtResize = process.stdout.columns ?? 0;
});
setTimeout(() => {
  process.kill(process.pid, 'SIGWINCH');
}, 300);
setTimeout(() => {
  Bun.spawnSync({ cmd: ['stty', 'cols', '137'], stdin: 'inherit', stdout: 'ignore', stderr: 'ignore' });
}, 600);
setTimeout(() => {
  process.stdout.write('PROBE_RESULT:' + JSON.stringify({
    resizeCount,
    columnsAtResize,
    columnsEnd: process.stdout.columns ?? 0,
    isTTY: process.stdout.isTTY === true,
  }) + '\\n');
  process.exit(0);
}, 1200);
`;

describe('SIGWINCH resize delivery', () => {
  it.skipIf(SKIP_REASON !== undefined)(
    'delivers stdout resize for self-sent SIGWINCH and a real pty size change',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'kimi-pty-resize-'));
      try {
        const probePath = join(dir, 'probe.ts');
        writeFileSync(probePath, PROBE_SOURCE);
        const result = Bun.spawnSync({
          cmd: ['script', '-qec', `bun ${probePath}`, '/dev/null'],
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 30_000,
        });
        expect(result.exitCode).toBe(0);
        const output = result.stdout.toString();
        const match = /PROBE_RESULT:(\{[^\n]*\})/.exec(output);
        expect(match, `probe produced no result marker; raw output:\n${output}`).not.toBeNull();
        const report = JSON.parse(match?.[1] ?? '') as {
          resizeCount: number;
          columnsAtResize: number;
          columnsEnd: number;
          isTTY: boolean;
        };
        expect(report.isTTY).toBe(true);
        expect(report.resizeCount).toBeGreaterThanOrEqual(2);
        expect(report.columnsAtResize).toBe(137);
        expect(report.columnsEnd).toBe(137);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
