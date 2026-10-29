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

  it('wraps the groups onto more rows instead of dropping them', () => {
    const region = new StatsRegion(() =>
      groups('7 turns · 577 steps', 'LLM 12m7s', 'Context: 36% (350k/977k)'),
    );
    const narrow = region.render(context(30));
    const wide = region.render(context(200));

    for (const text of ['7 turns · 577 steps', 'LLM 12m7s', 'Context: 36% (350k/977k)']) {
      expect(narrow.join(' ')).toContain(text);
      expect(wide.join(' ')).toContain(text);
    }
    expect(narrow.length).toBeGreaterThan(wide.length);
  });

  it('honours the row budget the surface grants', () => {
    const region = new StatsRegion(() => groups('a '.repeat(200)));
    expect(region.render(context(20, 2)).length).toBeLessThanOrEqual(2);
  });

  it('reports hidden rows only when unfolding would reveal them', () => {
    const short = new StatsRegion(() => groups('7 turns · 577 steps'));
    short.render(context(200));
    expect(short.hasHiddenContent()).toBe(false);

    const long = new StatsRegion(() =>
      groups(
        '7 turns · 577 steps',
        'LLM 12m7s · tools 25m12s',
        'first token avg 2.9s',
        'in 115.9M tok · out 137k tok',
        'Context: 36% (350k/977k)',
      ),
    );
    long.render(context(38));
    expect(long.hasHiddenContent()).toBe(true);

    const empty = new StatsRegion(() => []);
    expect(empty.hasHiddenContent()).toBe(false);
  });

  it('collapses to a stub and keeps a way back open', () => {
    const region = new StatsRegion(() =>
      groups('7 turns · 577 steps', 'LLM 12m7s', 'Context: 36% (350k/977k)'),
    );
    region.render(context(24));
    region.setExpanded(false);
    const folded = region.render(context(24));
    expect(folded.length).toBeLessThanOrEqual(region.minRows);
    expect(region.isExpanded()).toBe(false);
    expect(region.hasHiddenContent()).toBe(true);
  });

  it('never claims keyboard focus and has nothing to page through', () => {
    const region = new StatsRegion(() => groups('7 turns · 577 steps'));
    expect(region.blocking).toBe(false);
    expect(region.handleKey('up')).toBe(false);
    expect(region.handleKey('down')).toBe(false);
  });
});
