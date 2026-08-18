import { describe, expect, it, vi } from 'vitest';

import { Clickable } from '#/tui/components/common/clickable';

describe('Clickable', () => {
  it('renders its content lines', () => {
    const clickable = new Clickable({ content: ['Line A', 'Line B'] });
    expect(clickable.render(100)).toEqual(['Line A', 'Line B']);
  });

  it('fires onClick with relative coordinates', () => {
    const onClick = vi.fn();
    const clickable = new Clickable({ content: ['Line A'], onClick });
    clickable.handleClick({ x: 2, y: 0 });
    expect(onClick).toHaveBeenCalledWith(2, 0);
  });

  it('reports hover enter/leave', () => {
    const onHover = vi.fn();
    const clickable = new Clickable({ content: ['Line A'], onHover });
    clickable.onHoverChange(true, 0, 0);
    clickable.onHoverChange(false, 0, 0);
    expect(onHover).toHaveBeenNthCalledWith(1, true);
    expect(onHover).toHaveBeenNthCalledWith(2, false);
  });

  it('truncates overwide lines', () => {
    const clickable = new Clickable({ content: ['1234567890'] });
    expect(clickable.render(5)).toEqual(['12345']);
  });
});
