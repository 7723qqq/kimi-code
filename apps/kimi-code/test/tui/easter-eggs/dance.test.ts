import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';

import {
  DANCE_FLOW_MS,
  DANCE_FRAME_MS,
  getRainbowDanceView,
  installRainbowDance,
  RainbowDance,
  rainbowText,
  setRainbowDance,
  tryHandleDanceCommand,
  type DanceTimers,
} from '#/tui/easter-eggs/dance';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { darkColors } from '#/tui/theme/colors';

const TRUECOLOR_PATTERN = /\[38;2;(\d+);(\d+);(\d+)m/g;

/** Ordered list of "r,g,b" truecolor codes in the order they appear. */
function truecolorCodes(text: string): string[] {
  return [...text.matchAll(TRUECOLOR_PATTERN)].map((m) => `${m[1]},${m[2]},${m[3]}`);
}

interface DanceTimerDriver {
  readonly timers: DanceTimers;
  advance(ms: number): void;
  pending(): number[];
}

function createTimerDriver(): DanceTimerDriver {
  interface Entry {
    readonly id: number;
    readonly fn: () => void;
    readonly ms: number;
    readonly repeat: boolean;
    due: number;
    cleared: boolean;
  }
  const entries: Entry[] = [];
  let now = 0;
  let nextId = 0;

  const schedule = (fn: () => void, ms: number, repeat: boolean): number => {
    nextId += 1;
    entries.push({ id: nextId, fn, ms, repeat, due: now + ms, cleared: false });
    return nextId;
  };
  const cancel = (handle: unknown): void => {
    const entry = entries.find((candidate) => candidate.id === handle);
    if (entry !== undefined) entry.cleared = true;
  };
  const nextDue = (limit: number): Entry | undefined => {
    let next: Entry | undefined;
    for (const entry of entries) {
      if (entry.cleared || entry.due > limit) continue;
      if (next === undefined || entry.due < next.due) next = entry;
    }
    return next;
  };

  return {
    timers: {
      setInterval: (fn, ms) => schedule(fn, ms, true),
      clearInterval: cancel,
      setTimeout: (fn, ms) => schedule(fn, ms, false),
      clearTimeout: cancel,
    },
    advance: (byMs) => {
      const limit = now + byMs;
      let guard = 0;
      for (;;) {
        const entry = nextDue(limit);
        if (entry === undefined) break;
        guard += 1;
        if (guard > 10_000) throw new Error('timer driver fired more than 10000 timers');
        now = entry.due;
        if (entry.repeat) entry.due += entry.ms;
        else entry.cleared = true;
        entry.fn();
      }
      now = limit;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index]?.cleared === true) entries.splice(index, 1);
      }
    },
    pending: () => entries.filter((entry) => !entry.cleared).map((entry) => entry.ms),
  };
}

interface DanceHarness {
  readonly dance: RainbowDance;
  readonly requestRender: Mock<(...args: any[]) => any>;
  readonly driver: DanceTimerDriver;
}

function createDance(): DanceHarness {
  const requestRender = mock();
  const driver = createTimerDriver();
  return { dance: new RainbowDance(requestRender, driver.timers), requestRender, driver };
}

describe('RainbowDance', () => {
  it('starts uncolored — the banner keeps its default look', () => {
    const { dance, driver } = createDance();

    expect(dance.colored).toBe(false);
    expect(dance.phase).toBe(0);
    expect(driver.pending()).toEqual([]);
  });

  it('flows while dancing and requests renders', () => {
    const { dance, requestRender, driver } = createDance();

    dance.start({ hold: false });
    expect(dance.colored).toBe(true);

    const before = dance.phase;
    driver.advance(DANCE_FRAME_MS);
    expect(dance.phase).toBe(before + 1);
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it('fades back to default after the flow when not holding', () => {
    const { dance, driver } = createDance();

    dance.start({ hold: false });
    driver.advance(DANCE_FLOW_MS + DANCE_FRAME_MS);

    expect(dance.colored).toBe(false);
    expect(dance.phase).toBe(0);
    expect(driver.pending()).toEqual([]);
  });

  it('freezes into a static rainbow after the flow when holding', () => {
    const { dance, driver } = createDance();

    dance.start({ hold: true });
    driver.advance(DANCE_FLOW_MS + DANCE_FRAME_MS);

    expect(dance.colored).toBe(true);
    const frozen = dance.phase;
    expect(frozen).toBeGreaterThan(0);

    driver.advance(DANCE_FRAME_MS * 10);
    expect(dance.phase).toBe(frozen);
    expect(driver.pending()).toEqual([]);
  });

  it('stops on demand back to the default colors and clears its timers', () => {
    const { dance, requestRender, driver } = createDance();

    dance.start({ hold: true });
    driver.advance(DANCE_FRAME_MS * 3);
    expect(dance.phase).toBe(3);

    requestRender.mockClear();
    dance.stop();
    expect(dance.colored).toBe(false);
    expect(dance.phase).toBe(0);
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(driver.pending()).toEqual([]);

    requestRender.mockClear();
    driver.advance(DANCE_FRAME_MS * 5);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('dispose clears timers silently, without a final render', () => {
    const { dance, requestRender, driver } = createDance();

    dance.start({ hold: false });
    driver.advance(DANCE_FRAME_MS * 2);
    requestRender.mockClear();

    dance.dispose();
    expect(requestRender).not.toHaveBeenCalled();
    expect(driver.pending()).toEqual([]);

    driver.advance(DANCE_FLOW_MS + DANCE_FRAME_MS * 10);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('restarting replaces the previous timers instead of stacking frames', () => {
    const { dance, driver } = createDance();

    dance.start({ hold: false });
    dance.start({ hold: false });
    expect(driver.pending()).toEqual([DANCE_FRAME_MS, DANCE_FLOW_MS]);

    driver.advance(DANCE_FRAME_MS);
    expect(dance.phase).toBe(1);
  });

  it('advances the phase by one per frame while flowing', () => {
    const { dance, driver } = createDance();

    dance.start({ hold: true });
    driver.advance(DANCE_FRAME_MS * 5);
    expect(dance.phase).toBe(5);

    // Monotonic — the dance state itself has no palette-length cycle.
    driver.advance(DANCE_FRAME_MS * 5);
    expect(dance.phase).toBe(10);
  });

  it('takes its timers from the default argument, so the shipped wiring still works', () => {
    const dance = new RainbowDance(mock());

    dance.start({ hold: false });
    expect(dance.colored).toBe(true);
    dance.dispose();
  });
});

describe('rainbowText', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
  });

  it('assigns each visible character the next palette color', () => {
    const out = rainbowText('abcd', ['#111111', '#226622', '#aa33cc', '#44ddee'], 0);

    expect(truecolorCodes(out)).toEqual([
      '17,17,17',
      '34,102,34',
      '170,51,204',
      '68,221,238',
    ]);
  });

  it('does not consume a palette slot for spaces', () => {
    const out = rainbowText('a b', ['#111111', '#226622'], 0);

    expect(truecolorCodes(out)).toEqual(['17,17,17', '34,102,34']);
  });

  it('starts from the given offset', () => {
    const out = rainbowText('a', ['#111111', '#226622'], 1);

    expect(truecolorCodes(out)).toEqual(['34,102,34']);
  });
});

describe('installRainbowDance', () => {
  afterEach(() => {
    setRainbowDance(undefined);
  });

  it('returns a disposer that clears timers and uninstalls the controller', () => {
    const requestRender = mock();
    const driver = createTimerDriver();
    const dispose = installRainbowDance(requestRender, driver.timers);
    const host = {
      showStatus: mock(),
      state: { theme: { palette: darkColors } },
    } as unknown as SlashCommandHost;

    tryHandleDanceCommand(host, { name: 'dance', args: 'on' });
    driver.advance(DANCE_FRAME_MS * 2);
    expect(requestRender).toHaveBeenCalled();

    requestRender.mockClear();
    dispose();

    expect(requestRender).not.toHaveBeenCalled();
    expect(getRainbowDanceView()).toBeUndefined();
    expect(driver.pending()).toEqual([]);

    driver.advance(DANCE_FLOW_MS + DANCE_FRAME_MS * 10);
    expect(requestRender).not.toHaveBeenCalled();
  });
});

interface DanceCall {
  fn: 'start' | 'stop';
  hold?: boolean;
}

function makeHost(): { host: SlashCommandHost; calls: DanceCall[]; status: string[] } {
  const calls: DanceCall[] = [];
  const status: string[] = [];
  const rainbowDance = {
    colored: false,
    phase: 0,
    start: (opts: { hold: boolean }) => calls.push({ fn: 'start', hold: opts.hold }),
    stop: () => calls.push({ fn: 'stop' }),
    dispose: () => {},
  };
  setRainbowDance(rainbowDance);
  const host = {
    showStatus: (msg: string) => status.push(msg),
    state: { theme: { palette: darkColors } },
  } as unknown as SlashCommandHost;
  return { host, calls, status };
}

describe('tryHandleDanceCommand', () => {
  let host: SlashCommandHost;
  let calls: DanceCall[];
  let status: string[];

  beforeEach(() => {
    ({ host, calls, status } = makeHost());
  });

  afterEach(() => {
    setRainbowDance(undefined);
  });

  it('claims /dance, flowing then fading, and hints at /dance on', () => {
    const handled = tryHandleDanceCommand(host, { name: 'dance', args: '' });

    expect(handled).toBe(true);
    expect(calls).toEqual([{ fn: 'start', hold: false }]);
    expect(status.join(' ')).toContain('/dance on');
  });

  it('holds the rainbow for /dance on and hints at /dance off', () => {
    const handled = tryHandleDanceCommand(host, { name: 'dance', args: 'on' });

    expect(handled).toBe(true);
    expect(calls).toEqual([{ fn: 'start', hold: true }]);
    expect(status.join(' ')).toContain('/dance off');
  });

  it('turns the rainbow off for /dance off', () => {
    const handled = tryHandleDanceCommand(host, { name: 'dance', args: 'off' });

    expect(handled).toBe(true);
    expect(calls).toEqual([{ fn: 'stop' }]);
  });

  it('ignores case and surrounding whitespace in the sub-command', () => {
    tryHandleDanceCommand(host, { name: 'dance', args: '  ON  ' });

    expect(calls).toEqual([{ fn: 'start', hold: true }]);
  });

  it('treats an unknown sub-command as a one-off dance', () => {
    tryHandleDanceCommand(host, { name: 'dance', args: 'wiggle' });

    expect(calls).toEqual([{ fn: 'start', hold: false }]);
  });

  it('does not claim other commands, so they fall through normally', () => {
    const handled = tryHandleDanceCommand(host, { name: 'help', args: '' });

    expect(handled).toBe(false);
    expect(calls).toEqual([]);
  });
});
