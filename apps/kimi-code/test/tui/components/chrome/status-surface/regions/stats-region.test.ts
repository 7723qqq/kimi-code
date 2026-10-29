import { describe, expect, it } from 'bun:test';

import type { RegionRenderContext } from '#/tui/components/chrome/status-surface/region';
import { StatsRegion } from '#/tui/components/chrome/status-surface/regions/stats-region';
import type { SessionStatsGroup } from '#/tui/utils/session-stats';

function groups(...texts: readonly string[]): SessionStatsGroup[] {
  return texts.map((text) => ({ items: [{ text, priority: 1 }] }));
}

function context(width: number, budget = 4): RegionRenderContext {
  return {
    width,
    budget,
    focused: false,
    palette: {} as RegionRenderContext['palette'],
  };
}

describe('StatsRegion', () => {
  it('is empty and occupies no rows before any turn reports numbers', () => {
    const region = new StatsRegion(() => []);
    expect(region.isEmpty()).toBe(true);
    expect(region.render(context(80))).toEqual([]);
  });

  it('spans the whole band when nothing shares it', () => {
    const region = new StatsRegion(() => groups('7 turns · 577 steps'));
    expect(region.placement()).toBe('full');
  });

  it('takes the left column when an updates box is present', () => {
    const region = new StatsRegion(() => groups('7 turns · 577 steps'));
    region.setSiblingProbe(() => true);
    expect(region.placement()).toBe('left');
  });

  it('widens and narrows as the sibling appears and disappears', () => {
    let sibling = false;
    const region = new StatsRegion(() => groups('7 turns · 577 steps'));
    region.setSiblingProbe(() => sibling);
    expect(region.placement()).toBe('full');
    sibling = true;
    expect(region.placement()).toBe('left');
    sibling = false;
    expect(region.placement()).toBe('full');
  });

  it('drops the least important items when the column is narrow', () => {
    const region = new StatsRegion(() =>
      groups('7 turns · 577 steps', 'LLM 12m7s', 'Context: 36% (350k/977k)'),
    );
    const narrow = region.render(context(38)).join(' ');
    const wide = region.render(context(200)).join(' ');
    expect(wide).toContain('7 turns');
    expect(wide).toContain('LLM 12m7s');
    expect(wide).toContain('Context');
    expect(narrow.length).toBeLessThan(wide.length);
  });

  it('honours the row budget the surface grants', () => {
    const region = new StatsRegion(() => groups('a '.repeat(200)));
    expect(region.render(context(20, 2)).length).toBeLessThanOrEqual(2);
  });

  it('never claims keyboard focus and has nothing to page through', () => {
    const region = new StatsRegion(() => groups('7 turns · 577 steps'));
    expect(region.blocking).toBe(false);
    expect(region.handleKey('up')).toBe(false);
    expect(region.handleKey('down')).toBe(false);
  });
});
