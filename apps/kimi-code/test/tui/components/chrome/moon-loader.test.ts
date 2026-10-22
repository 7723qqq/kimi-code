import type { TUI } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it, mock, type Mock } from 'bun:test';

import { createFakeClock, type FakeClock } from '#test/helpers/fake-clock';

import { MoonLoader, type SpinnerStyle } from '#/tui/components/chrome/moon-loader';
import { MOON_SPINNER_INTERVAL_MS } from '#/tui/constant/rendering';

// Ownership contract: a MoonLoader arms no timer in its constructor, so a loader
// a test never starts is inert. Every loader a test does start must be stopped
// again, or its frame timer outlives the test.
const loaders: MoonLoader[] = [];

function createLoader(clock: FakeClock = createFakeClock()): MoonLoader {
  const loader = new MoonLoader(
    { requestRender() {} } as unknown as TUI,
    'moon',
    undefined,
    '',
    clock,
  );
  loaders.push(loader);
  return loader;
}

/** An owned loader whose ui records every repaint the loader asks for. */
function createOwnedLoader(
  clock: FakeClock,
  style: SpinnerStyle = 'moon',
  label = '',
): { loader: MoonLoader; requestRender: Mock<(...args: any[]) => any> } {
  const requestRender = mock();
  const loader = new MoonLoader(
    { requestRender } as unknown as TUI,
    style,
    undefined,
    label,
    clock,
  );
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
  it('does not tick when its owner never starts it', () => {
    const clock = createFakeClock();
    const requestRender = mock();
    const loader = new MoonLoader(
      { requestRender } as unknown as TUI,
      'moon',
      undefined,
      'Working…',
      clock,
    );
    loaders.push(loader);

    clock.advance(MOON_SPINNER_INTERVAL_MS * 10);

    // Constructing a loader arms nothing: no frame timer to leak, no repaint.
    expect(clock.activeTimers).toBe(0);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('animates once its owner starts it', () => {
    const clock = createFakeClock();
    const { loader, requestRender } = createOwnedLoader(clock, 'moon');
    const firstFrame = loader.renderInline();

    clock.advance(MOON_SPINNER_INTERVAL_MS * 3);

    // start() paints the first frame, then one repaint per frame step.
    expect(requestRender).toHaveBeenCalledTimes(1 + 3);
    expect(loader.renderInline()).not.toBe(firstFrame);
  });

  it('stops its frames on dispose()', () => {
    const clock = createFakeClock();
    const { loader, requestRender } = createOwnedLoader(clock, 'moon', 'Working…');
    clock.advance(MOON_SPINNER_INTERVAL_MS);
    const painted = requestRender.mock.calls.length;

    loader.dispose();
    clock.advance(MOON_SPINNER_INTERVAL_MS * 5);

    expect(clock.activeTimers).toBe(0);
    expect(requestRender.mock.calls).toHaveLength(painted);
  });

  it('ignores a second start() instead of stacking frame timers', () => {
    const clock = createFakeClock();
    const { loader, requestRender } = createOwnedLoader(clock, 'moon');
    loader.start();
    loader.start();

    clock.advance(MOON_SPINNER_INTERVAL_MS);

    // Two intervals would advance two frames per step and leak the first one.
    expect(clock.activeTimers).toBe(1);
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it('does not repaint when a setter re-applies the text it already holds', () => {
    const clock = createFakeClock();
    const { loader, requestRender } = createOwnedLoader(clock, 'moon', 'Working…');
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
