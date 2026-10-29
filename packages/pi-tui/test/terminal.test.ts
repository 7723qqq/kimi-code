import { expect, describe, it } from 'bun:test';

import { setKittyProtocolActive } from '../src/keys.ts';
import type { StdinBufferTimerHandle, StdinBufferTimers } from '../src/stdin-buffer.ts';
import {
  normalizeAppleTerminalInput,
  normalizeNativeShiftEnterInput,
  ProcessTerminal,
  resolveEscapeTimeoutMs,
} from '../src/terminal.ts';

describe('resolveEscapeTimeoutMs', () => {
  it('uses PI_TUI_ESC_TIMEOUT when configured', () => {
    expect(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: '80' })).toBe(80);
    expect(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: '80', SSH_TTY: '/dev/pts/1' })).toBe(80);
  });

  it('ignores invalid PI_TUI_ESC_TIMEOUT values', () => {
    expect(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: 'abc' })).toBe(10);
    expect(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: '0' })).toBe(10);
    expect(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: '-5' })).toBe(10);
    expect(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: '' })).toBe(10);
  });

  it('defaults to 100ms over SSH', () => {
    expect(resolveEscapeTimeoutMs({ SSH_CONNECTION: '10.0.0.1 22' })).toBe(100);
    expect(resolveEscapeTimeoutMs({ SSH_TTY: '/dev/pts/1' })).toBe(100);
  });

  it('defaults to 10ms otherwise', () => {
    expect(resolveEscapeTimeoutMs({})).toBe(10);
  });
});

describe('normalizeNativeShiftEnterInput', () => {
  it('rewrites Return to CSI-u Shift+Enter when native Shift detection is enabled and Shift is pressed', () => {
    expect(normalizeNativeShiftEnterInput('\r', true, true)).toBe('\x1b[13;2u');
  });

  it('leaves Return unchanged when native Shift detection is disabled', () => {
    expect(normalizeNativeShiftEnterInput('\r', false, true)).toBe('\r');
  });

  it('leaves Return unchanged when Shift is not pressed', () => {
    expect(normalizeNativeShiftEnterInput('\r', true, false)).toBe('\r');
  });

  it('leaves non-Return input unchanged', () => {
    expect(normalizeNativeShiftEnterInput('\x1b[13;2u', true, true)).toBe('\x1b[13;2u');
    expect(normalizeNativeShiftEnterInput('a', true, true)).toBe('a');
  });
});

describe('normalizeAppleTerminalInput', () => {
  it('rewrites Apple Terminal Return to CSI-u Shift+Enter when Shift is pressed', () => {
    expect(normalizeAppleTerminalInput('\r', true, true)).toBe('\x1b[13;2u');
  });

  it('leaves Apple Terminal Return unchanged when Shift is not pressed', () => {
    expect(normalizeAppleTerminalInput('\r', true, false)).toBe('\r');
  });

  it('leaves non-Apple Terminal Return unchanged when Shift is pressed', () => {
    expect(normalizeAppleTerminalInput('\r', false, true)).toBe('\r');
  });

  it('leaves non-Return input unchanged', () => {
    expect(normalizeAppleTerminalInput('\x1b[13;2u', true, true)).toBe('\x1b[13;2u');
    expect(normalizeAppleTerminalInput('a', true, true)).toBe('a');
  });
});

describe('ProcessTerminal setTitle', () => {
  function captureSetTitle(title: string): string[] {
    const writes: string[] = [];
    const previousWrite = process.stdout.write;

    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      new ProcessTerminal().setTitle(title);
    } finally {
      process.stdout.write = previousWrite;
    }

    return writes;
  }

  it('keeps printable titles verbatim', () => {
    expect(captureSetTitle('标题 A')).toStrictEqual(['\x1b]0;标题 A\x07']);
  });

  it('sanitizes control bytes in setTitle', () => {
    const output = captureSetTitle('x\x07\x1b]52;c;b64\x07').join('');

    expect(!output.includes('\x1b]52'), 'no injected OSC 52 sequence').toBeTruthy();
    expect(output.indexOf('\x1b]0;')).toBe(0);
    expect(output.match(/\x1b\]/g)!.length).toBe(1);
    expect(output.endsWith('\x07')).toBeTruthy();
    expect(output).toBe('\x1b]0;x]52;c;b64\x07');
  });

  it('does not produce a CSI sequence for control-byte titles', () => {
    const output = captureSetTitle('\x1b[2J').join('');

    expect(!output.includes('\x1b['), 'no CSI sequence is produced').toBeTruthy();
    expect(output).toBe('\x1b]0;[2J\x07');
  });

  it('writes nothing for an empty title', () => {
    expect(captureSetTitle('')).toStrictEqual([]);
  });

  it('normalises layout characters in titles', () => {
    expect(captureSetTitle('  a\nb\tc  ')).toStrictEqual(['\x1b]0;a b c\x07']);
  });
});

describe('ProcessTerminal Kitty keyboard protocol negotiation', () => {
  type NegotiationHarness = {
    terminal: ProcessTerminal;
    writes: string[];
    send(data: string): void;
    getInput(): string | undefined;
    cleanup(): void;
  };

  // Same source as `createFakeClock` in apps/kimi-code, narrowed to the one
  // timer this terminal needs: the escape-sequence reassembly window.
  type FakeTimers = StdinBufferTimers & { advance(byMs: number): void };

  interface ScheduledTimer {
    due: number;
    readonly callback: () => void;
    cancelled: boolean;
  }

  function createFakeTimers(): FakeTimers {
    let nowMs = 0;
    const timers: ScheduledTimer[] = [];
    return {
      setTimeout: (callback, delayMs) => {
        const timer: ScheduledTimer = { due: nowMs + delayMs, callback, cancelled: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle: StdinBufferTimerHandle): void => {
        (handle as ScheduledTimer).cancelled = true;
      },
      advance: (byMs) => {
        const limit = nowMs + byMs;
        for (;;) {
          let next: ScheduledTimer | undefined;
          for (const timer of timers) {
            if (timer.cancelled || timer.due > limit) continue;
            if (next === undefined || timer.due < next.due) next = timer;
          }
          if (next === undefined) break;
          nowMs = next.due;
          next.cancelled = true;
          next.callback();
        }
        nowMs = limit;
      },
    };
  }

  function setupNegotiation(timers?: StdinBufferTimers): NegotiationHarness {
    const terminal = new ProcessTerminal(timers);
    const writes: string[] = [];
    let input: string | undefined;
    let dataHandler: ((data: string) => void) | undefined;
    let cleaned = false;
    const previousWrite = process.stdout.write;
    const previousOn = process.stdin.on;

    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stdin.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === 'data') dataHandler = listener as (data: string) => void;
      return process.stdin;
    }) as typeof process.stdin.on;

    (
      terminal as unknown as {
        inputHandler?: (data: string) => void;
        queryAndEnableKittyProtocol(): void;
      }
    ).inputHandler = (data) => {
      input = data;
    };
    (terminal as unknown as { queryAndEnableKittyProtocol(): void }).queryAndEnableKittyProtocol();

    return {
      terminal,
      writes,
      send(data: string): void {
        dataHandler?.(data);
      },
      getInput(): string | undefined {
        return input;
      },
      cleanup(): void {
        if (cleaned) return;
        cleaned = true;
        try {
          terminal.stop();
        } finally {
          process.stdout.write = previousWrite;
          process.stdin.on = previousOn;
          setKittyProtocolActive(false);
        }
      },
    };
  }

  it('queries Kitty mode before enabling modifyOtherKeys fallback', () => {
    const harness = setupNegotiation();
    try {
      expect(harness.writes[0]).toBe('\x1b[>7u\x1b[?u\x1b]7501;?\x1b\\\x1b[c');
      expect(harness.writes.includes('\x1b[>4;2m')).toBe(false);
      expect(harness.terminal.kittyProtocolActive).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it('skips the program status query under PI_PROGRAM_STATUS=0 and multiplexers', () => {
    const saved = {
      override: process.env['PI_PROGRAM_STATUS'],
      tmux: process.env['TMUX'],
    };
    try {
      process.env['PI_PROGRAM_STATUS'] = '0';
      delete process.env['TMUX'];
      const optedOut = setupNegotiation();
      try {
        expect(optedOut.writes[0]).toBe('\x1b[>7u\x1b[?u\x1b[c');
      } finally {
        optedOut.cleanup();
      }

      delete process.env['PI_PROGRAM_STATUS'];
      process.env['TMUX'] = '1.0';
      const inMultiplexer = setupNegotiation();
      try {
        expect(inMultiplexer.writes[0]).toBe('\x1b[>7u\x1b[?u\x1b[c');
      } finally {
        inMultiplexer.cleanup();
      }
    } finally {
      if (saved.override === undefined) delete process.env['PI_PROGRAM_STATUS'];
      else process.env['PI_PROGRAM_STATUS'] = saved.override;
      if (saved.tmux === undefined) delete process.env['TMUX'];
      else process.env['TMUX'] = saved.tmux;
    }
  });

  it('treats device attributes as unsupported and stops waiting for a status reply', () => {
    const harness = setupNegotiation();
    try {
      harness.send('\x1b[?1;2c');
      expect(
        (harness.terminal as unknown as { programStatusQueryPending: boolean })
          .programStatusQueryPending,
      ).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it('activates Kitty mode for non-zero negotiated flags', () => {
    const harness = setupNegotiation();
    try {
      harness.send('\x1b[?7u');

      expect(harness.getInput()).toBe(undefined);
      expect(harness.terminal.kittyProtocolActive).toBe(true);
      expect(harness.writes.includes('\x1b[>4;2m')).toBe(false);
      expect(harness.writes.includes('\x1b[>4;0m')).toBe(false);

      harness.cleanup();
      expect(harness.writes.filter((write) => write === '\x1b[<u').length).toBe(1);
      expect(harness.writes.includes('\x1b[>4;0m')).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it('falls back to modifyOtherKeys for zero Kitty flags', () => {
    const harness = setupNegotiation();
    try {
      harness.send('\x1b[?0u');

      expect(harness.getInput()).toBe(undefined);
      expect(harness.terminal.kittyProtocolActive).toBe(false);
      expect(harness.writes.filter((write) => write === '\x1b[>4;2m').length).toBe(1);

      harness.cleanup();
      expect(harness.writes.filter((write) => write === '\x1b[>4;0m').length).toBe(1);
    } finally {
      harness.cleanup();
    }
  });

  it('falls back to modifyOtherKeys for device attributes without Kitty flags', () => {
    const harness = setupNegotiation();
    try {
      harness.send('\x1b[?62;4;52c');

      expect(harness.getInput()).toBe(undefined);
      expect(harness.terminal.kittyProtocolActive).toBe(false);
      expect(harness.writes.filter((write) => write === '\x1b[>4;2m').length).toBe(1);
    } finally {
      harness.cleanup();
    }
  });

  it('forwards normal input while waiting for Kitty response', () => {
    const harness = setupNegotiation();
    try {
      harness.send('a');

      expect(harness.getInput()).toBe('a');
      expect(harness.terminal.kittyProtocolActive).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it('tracks split Kitty confirmation', () => {
    const timers = createFakeTimers();
    const harness = setupNegotiation(timers);
    try {
      harness.send('\x1b[?7');
      timers.advance(10);

      expect(harness.getInput()).toBe(undefined);

      harness.send('u');

      expect(harness.terminal.kittyProtocolActive).toBe(true);
      expect(harness.writes.includes('\x1b[>4;2m')).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it('replays buffered CSI-prefix input when it is not a Kitty response', () => {
    const timers = createFakeTimers();
    const harness = setupNegotiation(timers);
    try {
      harness.send('\x1b[');
      timers.advance(50); // StdinBuffer sequence timeout, not the lone-ESC timeout

      expect(harness.getInput()).toBe(undefined);

      timers.advance(150);

      expect(harness.getInput()).toBe('\x1b[');
    } finally {
      harness.cleanup();
    }
  });
});

describe('ProcessTerminal progress', () => {
  it('writes a valid OSC 9;4 clear sequence', () => {
    const terminal = new ProcessTerminal();
    const writes: string[] = [];
    const previousWrite = process.stdout.write;

    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      terminal.setProgress(false);
      expect(writes).toStrictEqual(['\x1b]9;4;0\x07']);
    } finally {
      process.stdout.write = previousWrite;
    }
  });
});

describe('ProcessTerminal program status records', () => {
  function setup() {
    const terminal = new ProcessTerminal();
    const writes: string[] = [];
    const previousWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const internals = terminal as unknown as {
      programStatuses: Map<string | undefined, unknown>;
      programStatusSupported: boolean;
      confirmProgramStatusSupport(): void;
    };
    let cleaned = false;
    return {
      terminal,
      writes,
      internals,
      cleanup(): void {
        if (cleaned) return;
        cleaned = true;
        try {
          terminal.stop();
        } finally {
          process.stdout.write = previousWrite;
        }
      },
    };
  }

  it('drops a child record when it is cleared and keeps the root record', () => {
    const { terminal, internals, cleanup } = setup();
    try {
      internals.programStatusSupported = true;
      for (let index = 0; index < 100; index += 1) {
        terminal.setProgramStatus({ state: 'working', id: `agent-${String(index)}` });
      }
      terminal.setProgramStatus({ state: 'idle', app: 'kimi-code' });
      expect(internals.programStatuses.size).toBe(101);

      for (let index = 0; index < 100; index += 1) {
        terminal.setProgramStatus({ state: 'clear', id: `agent-${String(index)}` });
      }

      expect(internals.programStatuses.size).toBe(1);
      expect(internals.programStatuses.has(undefined)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('does not replay a cleared child when support is confirmed late', () => {
    const { terminal, writes, internals, cleanup } = setup();
    try {
      internals.programStatusSupported = false;
      terminal.setProgramStatus({ state: 'working', id: 'agent-1' });
      terminal.setProgramStatus({ state: 'clear', id: 'agent-1' });
      writes.length = 0;

      internals.confirmProgramStatusSupport();

      expect(writes).toStrictEqual([]);
      expect(internals.programStatuses.size).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('clears every record on stop', () => {
    const { terminal, internals, cleanup } = setup();
    try {
      internals.programStatusSupported = true;
      terminal.setProgramStatus({ state: 'working', id: 'agent-1' });
      terminal.setProgramStatus({ state: 'idle', app: 'kimi-code' });
      expect(internals.programStatuses.size).toBe(2);

      cleanup();

      expect(internals.programStatuses.size).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('writes nothing while support is unknown and replays once confirmed', () => {
    const { terminal, writes, internals, cleanup } = setup();
    try {
      internals.programStatusSupported = false;
      terminal.setProgramStatus({ state: 'working', app: 'kimi-code' });
      expect(writes).toStrictEqual([]);
      expect(internals.programStatuses.size).toBe(1);

      internals.confirmProgramStatusSupport();

      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain('\x1b]7501;state=working:app=kimi-code\x1b\\');
    } finally {
      cleanup();
    }
  });

  it('wraps the record in a tmux passthrough when TMUX is set', () => {
    const previousTmux = process.env['TMUX'];
    const { terminal, writes, internals, cleanup } = setup();
    try {
      process.env['TMUX'] = '1';
      internals.programStatusSupported = true;
      terminal.setProgramStatus({ state: 'idle', app: 'kimi-code' });

      expect(writes).toHaveLength(1);
      expect(writes[0]).toStartWith('\x1bPtmux;');
      expect(writes[0]).toContain('\x1b\x1b]7501;state=idle:app=kimi-code\x1b\x1b\\');
    } finally {
      cleanup();
      if (previousTmux === undefined) delete process.env['TMUX'];
      else process.env['TMUX'] = previousTmux;
    }
  });
});

describe('ProcessTerminal dimensions', () => {
  it('falls back to COLUMNS and LINES before default dimensions', () => {
    const previousColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const previousRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    const previousColumns = process.env.COLUMNS;
    const previousLines = process.env.LINES;

    try {
      Object.defineProperty(process.stdout, 'columns', { value: undefined, configurable: true });
      Object.defineProperty(process.stdout, 'rows', { value: undefined, configurable: true });
      process.env.COLUMNS = '123';
      process.env.LINES = '45';

      const terminal = new ProcessTerminal();

      expect(terminal.columns).toBe(123);
      expect(terminal.rows).toBe(45);
    } finally {
      if (previousColumnsDescriptor) {
        Object.defineProperty(process.stdout, 'columns', previousColumnsDescriptor);
      } else {
        Reflect.deleteProperty(process.stdout, 'columns');
      }
      if (previousRowsDescriptor) {
        Object.defineProperty(process.stdout, 'rows', previousRowsDescriptor);
      } else {
        Reflect.deleteProperty(process.stdout, 'rows');
      }
      if (previousColumns === undefined) {
        delete process.env.COLUMNS;
      } else {
        process.env.COLUMNS = previousColumns;
      }
      if (previousLines === undefined) {
        delete process.env.LINES;
      } else {
        process.env.LINES = previousLines;
      }
    }
  });
});
