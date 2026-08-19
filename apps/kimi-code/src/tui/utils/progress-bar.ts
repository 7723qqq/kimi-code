import chalk from 'chalk';

const BRAILLE_LEVELS = ['⣀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿'] as const;
const STATUS_FILLED = '━';
const STATUS_EMPTY = '░';

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

export function renderBrailleBar(
  percent: number,
  width: number,
  filledColor: string,
  emptyColor: string,
): string {
  const cells = Math.max(0, Math.floor(width));
  if (cells === 0) return '';
  const levels = BRAILLE_LEVELS.length;
  const totalTicks = cells * levels;
  const filledTicks = Math.round((clampPercent(percent) / 100) * totalTicks);
  let out = '';
  for (let cell = 0; cell < cells; cell += 1) {
    const cellTicks = Math.max(0, Math.min(levels - 1, filledTicks - cell * levels));
    const glyph = BRAILLE_LEVELS[cellTicks];
    out += chalk.hex(cellTicks > 0 ? filledColor : emptyColor)(glyph);
  }
  return out;
}

export function renderStatusBar(
  percent: number,
  width: number,
  filledColor: string,
  emptyColor: string,
): string {
  const cells = Math.max(0, Math.floor(width));
  if (cells === 0) return '';
  const filled = Math.round((clampPercent(percent) / 100) * cells);
  const filledPart = filled > 0 ? chalk.hex(filledColor)(STATUS_FILLED.repeat(filled)) : '';
  const emptyPart =
    cells - filled > 0 ? chalk.hex(emptyColor)(STATUS_EMPTY.repeat(cells - filled)) : '';
  return filledPart + emptyPart;
}
