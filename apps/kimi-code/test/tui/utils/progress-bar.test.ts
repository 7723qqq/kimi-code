import { describe, expect, it } from 'vitest';
import chalk from 'chalk';

import { renderBrailleBar, renderStatusBar } from '#/tui/utils/progress-bar';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('renderBrailleBar', () => {
  it('renders a full-width empty bar at 0% and a full bar at 100%', () => {
    expect(strip(renderBrailleBar(0, 4, '#ffffff', '#000000'))).toBe('⣀⣀⣀⣀');
    expect(strip(renderBrailleBar(100, 4, '#ffffff', '#000000'))).toBe('⣿⣿⣿⣿');
  });

  it('fills cells braille-level by level (each cell has 7 dot levels)', () => {
    expect(strip(renderBrailleBar(50, 4, '#ffffff', '#000000'))).toBe('⣿⣿⣀⣀');
    expect(strip(renderBrailleBar(25, 4, '#ffffff', '#000000'))).toBe('⣿⣀⣀⣀');
    expect(strip(renderBrailleBar(30, 4, '#ffffff', '#000000'))).toBe('⣿⣄⣀⣀');
  });

  it('clamps percent outside [0, 100] and width below 1', () => {
    expect(strip(renderBrailleBar(150, 3, '#ffffff', '#000000'))).toBe('⣿⣿⣿');
    expect(strip(renderBrailleBar(-10, 3, '#ffffff', '#000000'))).toBe('⣀⣀⣀');
    expect(strip(renderBrailleBar(50, 0, '#ffffff', '#000000'))).toBe('');
  });

  it('colors filled cells with filledColor and empty cells with emptyColor', () => {
    const previousChalkLevel = chalk.level;
    chalk.level = 3;
    try {
      const bar = renderBrailleBar(50, 2, '#ff0000', '#00ff00');
      expect(bar).toContain('\u001B[38;2;255;0;0m');
      expect(bar).toContain('\u001B[38;2;0;255;0m');
    } finally {
      chalk.level = previousChalkLevel;
    }
  });
});

describe('renderStatusBar', () => {
  it('renders filled/empty segments by rounded cell boundary', () => {
    expect(strip(renderStatusBar(50, 8, '#ffffff', '#000000'))).toBe('━━━━░░░░');
    expect(strip(renderStatusBar(0, 4, '#ffffff', '#000000'))).toBe('░░░░');
    expect(strip(renderStatusBar(100, 4, '#ffffff', '#000000'))).toBe('━━━━');
  });

  it('rounds to nearest cell (75% of 8 = 6 filled)', () => {
    expect(strip(renderStatusBar(75, 8, '#ffffff', '#000000'))).toBe('━━━━━━░░');
  });

  it('clamps inputs', () => {
    expect(strip(renderStatusBar(200, 3, '#ffffff', '#000000'))).toBe('━━━');
    expect(strip(renderStatusBar(-5, 3, '#ffffff', '#000000'))).toBe('░░░');
    expect(strip(renderStatusBar(50, 0, '#ffffff', '#000000'))).toBe('');
  });
});
