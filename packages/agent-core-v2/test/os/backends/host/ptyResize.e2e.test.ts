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
const t0 = Date.now();
const events = [];
const initialColumns = process.stdout.columns ?? 0;
process.stdout.on('resize', () => {
  events.push({ at: Date.now() - t0, columns: process.stdout.columns ?? 0 });
});
let phase1Count = -1;
setTimeout(() => {
  process.kill(process.pid, 'SIGWINCH');
}, 300);
setTimeout(() => {
  phase1Count = events.length;
}, 700);
setTimeout(() => {
  Bun.spawnSync({ cmd: ['stty', 'cols', '137'], stdin: 'inherit', stdout: 'ignore', stderr: 'ignore' });
}, 900);
setTimeout(() => {
  process.stdout.write('PROBE_RESULT:' + JSON.stringify({
    initialColumns,
    phase1Count,
    phase2Delta: events.length - phase1Count,
    events,
    finalColumns: process.stdout.columns ?? 0,
    isTTY: process.stdout.isTTY === true,
  }) + '\\n');
  process.exit(0);
}, 1600);
`;

interface PtyProbeReport {
  readonly initialColumns: number;
  readonly phase1Count: number;
  readonly phase2Delta: number;
  readonly events: readonly { readonly at: number; readonly columns: number }[];
  readonly finalColumns: number;
  readonly isTTY: boolean;
}

describe('SIGWINCH resize delivery', () => {
  it.skipIf(SKIP_REASON !== undefined)(
    'delivers stdout resize with updated columns when the pty size actually changes',
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
        const report = JSON.parse(match?.[1] ?? '') as PtyProbeReport;
        console.log(`pty probe report: ${JSON.stringify(report)}`);
        expect(report.isTTY).toBe(true);
        expect(report.phase2Delta).toBeGreaterThanOrEqual(1);
        expect(report.finalColumns).toBe(137);
        expect(report.events.at(-1)?.columns).toBe(137);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
