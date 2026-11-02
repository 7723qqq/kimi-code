import { afterEach, describe, expect, it } from 'bun:test';

import type { StdinBufferTimerHandle, StdinBufferTimers } from '../src/stdin-buffer.ts';
import { ProcessTerminal } from '../src/terminal.ts';

const NOOP_TIMERS: StdinBufferTimers = {
  setTimeout: (): StdinBufferTimerHandle => ({ unref: () => {} }),
  clearTimeout: () => {},
};

type IoOverrides = {
  columns: number;
  rows: number;
};

let restores: Array<() => void> = [];

function overrideIo({ columns, rows }: IoOverrides): void {
  const stdout = process.stdout as unknown as Record<string, unknown>;
  const stdin = process.stdin as unknown as Record<string, unknown>;

  for (const key of ['columns', 'rows'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
    Object.defineProperty(process.stdout, key, {
      value: key === 'columns' ? columns : rows,
      configurable: true,
      writable: true,
    });
    restores.push(() => {
      if (descriptor !== undefined) {
        Object.defineProperty(process.stdout, key, descriptor);
      }
    });
  }

  const savedStdoutWrite = stdout['write'];
  const savedStdoutOn = stdout['on'];
  const savedStdinIsRaw = stdin['isRaw'];
  const savedSetRawMode = stdin['setRawMode'];
  const savedSetEncoding = stdin['setEncoding'];
  const savedResume = stdin['resume'];
  const savedStdinOn = stdin['on'];

  stdout['write'] = () => true;
  stdout['on'] = () => process.stdout;
  stdin['isRaw'] = false;
  stdin['setRawMode'] = () => process.stdin;
  stdin['setEncoding'] = () => process.stdin;
  stdin['resume'] = () => process.stdin;
  stdin['on'] = () => process.stdin;

  restores.push(() => {
    stdout['write'] = savedStdoutWrite;
    stdout['on'] = savedStdoutOn;
    stdin['isRaw'] = savedStdinIsRaw;
    stdin['setRawMode'] = savedSetRawMode;
    stdin['setEncoding'] = savedSetEncoding;
    stdin['resume'] = savedResume;
    stdin['on'] = savedStdinOn;
  });
}

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

describe('ProcessTerminal resume refresh', () => {
  it('does not invoke the resize handler on the first start (no baseline)', () => {
    overrideIo({ columns: 100, rows: 40 });
    let resizeCount = 0;
    new ProcessTerminal(NOOP_TIMERS).start(
      () => {},
      () => {
        resizeCount += 1;
      },
    );
    expect(resizeCount).toBe(0);
  });

  it('invokes the resize handler on resume when columns changed while suspended', () => {
    overrideIo({ columns: 100, rows: 40 });
    let resizeCount = 0;
    const terminal = new ProcessTerminal(NOOP_TIMERS);
    terminal.start(
      () => {},
      () => {
        resizeCount += 1;
      },
    );
    Object.defineProperty(process.stdout, 'columns', { value: 137, configurable: true, writable: true });
    terminal.start(
      () => {},
      () => {
        resizeCount += 1;
      },
    );
    expect(resizeCount).toBe(1);
  });

  it('invokes the resize handler when only rows changed', () => {
    overrideIo({ columns: 100, rows: 40 });
    let resizeCount = 0;
    const terminal = new ProcessTerminal(NOOP_TIMERS);
    terminal.start(
      () => {},
      () => {
        resizeCount += 1;
      },
    );
    Object.defineProperty(process.stdout, 'rows', { value: 50, configurable: true, writable: true });
    terminal.start(
      () => {},
      () => {
        resizeCount += 1;
      },
    );
    expect(resizeCount).toBe(1);
  });

  it('does nothing on resume when dimensions are unchanged', () => {
    overrideIo({ columns: 100, rows: 40 });
    let resizeCount = 0;
    const terminal = new ProcessTerminal(NOOP_TIMERS);
    const onResize = () => {
      resizeCount += 1;
    };
    terminal.start(() => {}, onResize);
    terminal.start(() => {}, onResize);
    expect(resizeCount).toBe(0);
  });
});
