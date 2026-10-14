import type { TUI } from '@moonshot-ai/pi-tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MoonLoader, type SpinnerStyle } from '#/tui/components/chrome/moon-loader';
import { MOON_SPINNER_INTERVAL_MS } from '#/tui/constant/rendering';

// Ownership contract: a MoonLoader arms no timer in its constructor, so a loader
// a test never starts is inert. Every loader a test does start must be stopped
// again, or its frame timer outlives the test.
const loaders: MoonLoader[] = [];

function createLoader(): MoonLoader {
  const loader = new MoonLoader({ requestRender() {} } as unknown as TUI, 'moon');
  loaders.push(loader);
  return loader;
}

/** An owned loader whose ui records every repaint the loader asks for. */
function createOwnedLoader(
  style: SpinnerStyle = 'moon',
  label = '',
): { loader: MoonLoader; requestRender: ReturnType<typeof vi.fn> } {
  const requestRender = vi.fn();
  const loader = new MoonLoader({ requestRender } as unknown as TUI, style, undefined, label);
  loaders.push(loader);
  loader.start();
  return { loader, requestRender };
}

afterEach(() => {
  for (const loader of loaders) loader.stop();
  loaders.length = 0;
});

describe('MoonLoader', () => {
  it('keeps the tip out of renderInline so it does not squeeze against the swarm progress bar', () => {
    const loader = createLoader();
    loader.setTip(' · Tip: ctrl+s: steer mid-turn');
    loader.setAvailableWidth(80);

    const inline = loader.renderInline();
    expect(inline).not.toContain('Tip');
    expect(inline).not.toContain('steer');
    expect(inline.trim().length).toBeGreaterThan(0);
  });

  it('still shows the tip on its own row when width allows', () => {
    const loader = createLoader();
    loader.setTip(' · Tip: ctrl+s: steer mid-turn');
    loader.setAvailableWidth(80);

    const row = loader.render(80).join('\n');
    expect(row).toContain('Tip: ctrl+s: steer mid-turn');
  });
});

describe('MoonLoader frame-timer ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not tick when its owner never starts it', () => {
    const requestRender = vi.fn();
    const loader = new MoonLoader(
      { requestRender } as unknown as TUI,
      'moon',
      undefined,
      'Working…',
    );
    loaders.push(loader);

    vi.advanceTimersByTime(MOON_SPINNER_INTERVAL_MS * 10);

    // Constructing a loader arms nothing: no frame timer to leak, no repaint.
    expect(vi.getTimerCount()).toBe(0);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('animates once its owner starts it', () => {
    const { loader, requestRender } = createOwnedLoader('moon');
    const firstFrame = loader.renderInline();

    vi.advanceTimersByTime(MOON_SPINNER_INTERVAL_MS * 3);

    // start() paints the first frame, then one repaint per frame step.
    expect(requestRender).toHaveBeenCalledTimes(1 + 3);
    expect(loader.renderInline()).not.toBe(firstFrame);
  });

  it('stops its frames on dispose()', () => {
    const { loader, requestRender } = createOwnedLoader('moon', 'Working…');
    vi.advanceTimersByTime(MOON_SPINNER_INTERVAL_MS);
    const painted = requestRender.mock.calls.length;

    loader.dispose();
    vi.advanceTimersByTime(MOON_SPINNER_INTERVAL_MS * 5);

    expect(vi.getTimerCount()).toBe(0);
    expect(requestRender.mock.calls).toHaveLength(painted);
  });

  it('ignores a second start() instead of stacking frame timers', () => {
    const { loader, requestRender } = createOwnedLoader('moon');
    loader.start();
    loader.start();

    vi.advanceTimersByTime(MOON_SPINNER_INTERVAL_MS);

    // Two intervals would advance two frames per step and leak the first one.
    expect(vi.getTimerCount()).toBe(1);
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it('does not repaint when a setter re-applies the text it already holds', () => {
    const { loader, requestRender } = createOwnedLoader('moon', 'Working…');
    expect(requestRender).toHaveBeenCalledTimes(1);

    loader.setLabel('Working…');
    loader.setTip(' · Tip: ctrl+s: steer mid-turn');
    loader.setTip(' · Tip: ctrl+s: steer mid-turn');
    loader.setAvailableWidth(80);

    // Only the tip arriving changed any character; the re-applied label, the
    // re-applied tip and the width change that keeps the same text repaint nothing.
    expect(requestRender).toHaveBeenCalledTimes(2);
  });
});
