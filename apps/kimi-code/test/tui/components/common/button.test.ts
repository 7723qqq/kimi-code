import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TuiButton } from '#/tui/components/common/button';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

describe('TuiButton', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
  });

  it('renders as a bordered label', () => {
    const button = new TuiButton({ label: 'Approve', onClick: () => {} });
    const rendered = button.render(40).map(strip);
    expect(rendered[0]).toContain('[ Approve ]');
  });

  it('fires onClick when clicked', () => {
    const onClick = vi.fn();
    const button = new TuiButton({ label: 'Reject', onClick });
    button.handleClick({ x: 1, y: 0 });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('supports a custom style override', () => {
    const button = new TuiButton({
      label: 'Go',
      onClick: () => {},
      style: (text) => `styled:${text}`,
    });
    const rendered = button.render(40).map(strip);
    expect(rendered[0]).toContain('styled:[ Go ]');
  });

  it('reflects hover state with a background highlight', () => {
    const button = new TuiButton({ label: 'Hover', onClick: () => {} });
    const normal = button.render(40)[0]!;
    expect(normal).not.toContain('\u001B[48');

    button.onHoverChange(true, 0, 0);
    const hovered = button.render(40)[0]!;
    expect(hovered).toContain('\u001B[48');
    expect(strip(hovered)).toBe('[ Hover ]');

    button.onHoverChange(false, 0, 0);
    expect(button.render(40)[0]!).not.toContain('\u001B[48');
  });
});
