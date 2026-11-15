import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import chalk from 'chalk';

import { TitleSweep } from '#/tui/components/messages/running-title';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';

const previousChalkLevel = chalk.level;
beforeEach(() => {
  chalk.level = 3;
});
afterEach(() => {
  chalk.level = previousChalkLevel;
});

function glyphColors(text: string): string[] {
  return [...text.matchAll(/\u001B\[38;2;(\d+);(\d+);(\d+)m([^\u001B]*)/g)].flatMap(
    ([, red, green, blue, segment = '']) => {
      const color = `#${[red, green, blue]
        .map((channel) => Number(channel).toString(16).padStart(2, '0'))
        .join('')}`;
      return Array.from(segment, () => color);
    },
  );
}

function withLightTheme(run: () => void): void {
  const previousPalette = currentTheme.palette;
  const previousResolved = currentTheme.isLight ? 'light' : 'dark';
  currentTheme.setPalette(lightColors, 'light');
  currentTheme.setTerminalBackground('#FFFFFF');
  try {
    run();
  } finally {
    currentTheme.setPalette(previousPalette, previousResolved);
    currentTheme.setTerminalBackground(undefined);
  }
}

const title = 'Read 3 files, ran 2 commands';
const titleColumns = 2 + title.length;

function colorsAt(sweep: TitleSweep, time: number): string[] {
  sweep.advance(time, titleColumns, true);
  return glyphColors(sweep.painter()(title, 2));
}

describe('TitleSweep', () => {
  it('keeps the title at its rest color until the 600 ms start delay', () => {
    const sweep = new TitleSweep();
    sweep.start(0, true);

    expect(colorsAt(sweep, 0)).toEqual(Array.from(title, () => darkColors.textDim.toLowerCase()));
    expect(colorsAt(sweep, 480)).toEqual(
      Array.from(title, () => darkColors.textDim.toLowerCase()),
    );
  });

  it('sweeps a highlight from the rest color up to text and back into the gap', () => {
    const sweep = new TitleSweep();
    sweep.start(0, true);
    const rest = darkColors.textDim.toLowerCase();

    const crossing = colorsAt(sweep, 1_000);
    expect(crossing).toContain(darkColors.text.toLowerCase());
    expect(crossing[0]).not.toBe(rest);
    expect(crossing.at(-1)).toBe(rest);

    expect(colorsAt(sweep, 2_400)).toEqual(Array.from(title, () => rest));
    const nextCycle = colorsAt(sweep, 4_800);
    expect(nextCycle.some((color) => color !== rest)).toBe(true);
  });

  it('fades out within a second of the turn ending on slow animation frames', () => {
    const fadeOutTime = (frameMs: number): number => {
      const sweep = new TitleSweep();
      sweep.start(0, true);
      let time = 0;
      while (sweep.intensity > 0) {
        time += frameMs;
        sweep.advance(time, 20, false);
      }
      return time;
    };

    expect(fadeOutTime(1_000)).toBe(1_000);
    expect(fadeOutTime(500)).toBe(1_000);
    expect(fadeOutTime(120)).toBe(1_080);
  });

  it('lights a running light-theme title on the running gray between the background and text', () => {
    withLightTheme(() => {
      const sweep = new TitleSweep();
      sweep.start(0, true);

      expect(colorsAt(sweep, 0)).toEqual(Array.from(title, () => '#767676'));
      const crossing = colorsAt(sweep, 1_000);
      expect(crossing).toContain(lightColors.text.toLowerCase());
      expect(crossing.at(-1)).toBe('#767676');
    });
  });

  it('sweeps every line of a multi-line title at the same columns', () => {
    const sweep = new TitleSweep();
    sweep.start(0, true);
    sweep.advance(1_000, 20, true);
    const paint = sweep.painter();

    expect(glyphColors(paint('Read a.ts', 2))).toContain(darkColors.text.toLowerCase());
    expect(glyphColors(paint('second line', 2))).toContain(darkColors.text.toLowerCase());
  });

  it('keeps the sweep rhythm when the title changes in the middle of a sweep', () => {
    const sweep = new TitleSweep();
    sweep.start(0, true);
    expect(colorsAt(sweep, 1_000)).toContain(darkColors.text.toLowerCase());

    const longer = 'Read 4 files, ran 2 commands';
    const longerColumns = 2 + longer.length;
    sweep.advance(1_200, longerColumns, true);
    expect(glyphColors(sweep.painter()(longer, 2))).not.toEqual(
      Array.from(longer, () => darkColors.textDim.toLowerCase()),
    );
    const later = colorsAt(sweep, 1_700);
    expect(later.some((color) => color !== darkColors.textDim.toLowerCase())).toBe(true);
  });
});
