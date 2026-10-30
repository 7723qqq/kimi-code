import { describe, expect, it } from 'bun:test';

import { visibleWidth } from '@moonshot-ai/pi-tui';

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

  it('measures localised text in cells, so a wide row is wrapped rather than clipped', () => {
    // A Chinese character is one code unit but two cells. Measuring code units
    // let a row that "fit" at 38 overflow as 76 cells, and the frame then cut
    // its tail off — the readout ended in `输出 4...` with the numbers gone.
    const region = new StatsRegion(() =>
      groups(
        '2 轮 · 14 步',
        'LLM 4m · 工具调用 1m53s',
        '首 token 平均 1.8s',
        '缓存命中 74%',
        '输入 1.2M tok · 输出 4.8k tok',
        '上下文：13%（120k/977k）',
      ),
    );
    const lines = region.render(context(38, 20));

    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(38);
    const joined = lines.join('\n');
    for (const text of ['4.8k tok', '缓存命中 74%', '上下文：13%（120k/977k）']) {
      expect(joined).toContain(text);
    }
  });

  it('lays the readings out in as many columns as the width has room for', () => {
    const readings = [
      '2 轮 · 14 步',
      'LLM 4m · 工具调用 1m53s',
      '首 token 平均 1.8s',
      '缓存命中 74%',
      '输入 1.2M tok · 输出 4.8k tok',
      '上下文：13%（120k/977k）',
    ];
    const region = new StatsRegion(() => groups(...readings));

    const wide = region.render(context(96, 20));
    const narrow = region.render(context(38, 20));

    // Wide: several cells per row, so the readings share the band instead of
    // trailing off into one long line with the rest of the width unused.
    expect(wide.length).toBeLessThan(narrow.length);
    for (const line of wide) expect(visibleWidth(line)).toBeLessThanOrEqual(96);
    for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(38);
    for (const text of readings) {
      expect(wide.join('\n')).toContain(text);
      expect(narrow.join('\n')).toContain(text);
    }
  });

  it('drops the lowest-priority reading, never the context readout, when rows run out', () => {
    const region = new StatsRegion(
      () =>
        [
          { items: [{ text: '2 轮 · 14 步', priority: 1 }] },
          { items: [{ text: 'LLM 4m', priority: 2 }] },
          { items: [{ text: '首 token 平均 1.8s', priority: 4 }] },
          { items: [{ text: '上下文：13%（120k/977k）', priority: Number.POSITIVE_INFINITY }] },
        ] satisfies SessionStatsGroup[],
    );

    // Six rows of room is enough for one cell per row; three is not.
    const full = region.render(context(38, 6));
    expect(full).toHaveLength(4);

    const tight = region.render(context(38, 2));
    expect(tight.length).toBeLessThanOrEqual(2);
    // The counters rank first to go; the context readout is never dropped,
    // because a later render cannot reconstruct it.
    expect(tight.join('\n')).not.toContain('2 轮 · 14 步');
    expect(tight.join('\n')).toContain('上下文：13%（120k/977k）');
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
