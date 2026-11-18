import { afterEach, beforeEach, describe, expect, it, mock, onTestFinished, spyOn, type Mock } from 'bun:test';

import type { TUI } from '@moonshot-ai/pi-tui';

import { MoonLoader, type SpinnerLabel, type SpinnerStyle } from '#/tui/components/chrome/moon-loader';
import { MOON_LOADER_FRAME_MS } from '#/tui/constant/rendering';

// Ownership contract: a MoonLoader arms nothing in its constructor, so a loader
// a test never starts is inert. Every loader a test does start must be stopped
// again, or its animation outlives the test.
const loaders: MoonLoader[] = [];

beforeEach(() => {
  const clock = spyOn(performance, 'now').mockReturnValue(0);
  onTestFinished(() => clock.mockRestore());
});

interface FrameDriver {
  readonly loader: MoonLoader;
  readonly requestRender: Mock<(...args: unknown[]) => unknown>;
  runFrame(clientTimeMs: number): void;
  pendingFrames(): number;
}

function createLoader(
  style: SpinnerStyle = 'moon',
  label: SpinnerLabel = '',
  start = false,
): FrameDriver {
  const queue = new Map<number, (time: number) => void>();
  let nextHandle = 1;
  const requestRender = mock();
  const ui = {
    requestRender,
    requestAnimationFrame: (callback: (time: number) => void): number => {
      const handle = nextHandle++;
      queue.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame: (handle: number): void => {
      queue.delete(handle);
    },
  } as unknown as TUI;
  const loader = new MoonLoader(ui, style, undefined, label);
  loaders.push(loader);
  if (start) loader.start();
  return {
    loader,
    requestRender,
    runFrame: (clientTimeMs: number): void => {
      const pending = [...queue.values()];
      queue.clear();
      for (const callback of pending) callback(clientTimeMs);
    },
    pendingFrames: (): number => queue.size,
  };
}

afterEach(() => {
  for (const loader of loaders) loader.stop();
  loaders.length = 0;
});

describe('MoonLoader', () => {
  it('keeps the tip out of renderInline so it does not squeeze against the swarm progress bar', () => {
    const { loader } = createLoader();
    loader.setTip(' · Tip: ctrl+s: steer mid-turn');
    loader.setAvailableWidth(80);

    const inline = loader.renderInline();
    expect(inline).not.toContain('Tip');
    expect(inline).not.toContain('steer');
    expect(inline.trim().length).toBeGreaterThan(0);
  });

  it('still shows the tip on its own row when width allows', () => {
    const { loader } = createLoader();
    loader.setTip(' · Tip: ctrl+s: steer mid-turn');
    loader.setAvailableWidth(80);

    const row = loader.render(80).join('\n');
    expect(row).toContain('Tip: ctrl+s: steer mid-turn');
  });
});

describe('MoonLoader frame ownership', () => {
  it('does not tick when its owner never starts it', () => {
    const { requestRender, pendingFrames } = createLoader('moon', 'Working…');

    // Constructing a loader arms nothing: no frame request to leak, no repaint.
    expect(pendingFrames()).toBe(0);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('animates once its owner starts it', () => {
    const base = performance.now();
    const { loader, requestRender, runFrame, pendingFrames } = createLoader('moon', '', true);
    const firstFrame = loader.renderInline();
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(pendingFrames()).toBe(1);

    runFrame(base + MOON_LOADER_FRAME_MS + 5);
    expect(requestRender).toHaveBeenCalledTimes(2);
    expect(loader.renderInline()).not.toBe(firstFrame);
    expect(pendingFrames()).toBe(1);
  });

  it('stops its frames on dispose()', () => {
    const base = performance.now();
    const { loader, requestRender, runFrame, pendingFrames } = createLoader(
      'moon',
      'Working…',
      true,
    );
    runFrame(base + MOON_LOADER_FRAME_MS + 5);
    const painted = requestRender.mock.calls.length;

    loader.dispose();
    expect(pendingFrames()).toBe(0);
    runFrame(base + MOON_LOADER_FRAME_MS * 4);

    expect(pendingFrames()).toBe(0);
    expect(requestRender.mock.calls).toHaveLength(painted);
  });

  it('ignores a second start() instead of stacking frame requests', () => {
    const base = performance.now();
    const { loader, requestRender, runFrame, pendingFrames } = createLoader('moon', '', true);
    loader.start();
    loader.start();

    expect(pendingFrames()).toBe(1);
    runFrame(base + MOON_LOADER_FRAME_MS + 5);

    // Two frame chains would advance two frames per tick.
    expect(pendingFrames()).toBe(1);
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it('does not repaint when a setter re-applies the text it already holds', () => {
    const { loader, requestRender } = createLoader('moon', 'Working…', true);
    expect(requestRender).toHaveBeenCalledTimes(1);

    loader.setLabel('Working…');
    loader.setTip(' · Tip: ctrl+s: steer mid-turn');
    loader.setTip(' · Tip: ctrl+s: steer mid-turn');
    loader.setAvailableWidth(80);

    // Only the tip arriving changed any character; the re-applied label, the
    // re-applied tip and the width change that keeps the same text repaint nothing.
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it('evaluates a live label at each animation frame time without a timer of its own', () => {
    const startedAt = performance.now();
    const { loader, runFrame } = createLoader(
      'braille',
      (now) => `Working for ${String(Math.floor((now - startedAt) / 1000))}s`,
      true,
    );
    expect(loader.renderInline()).toBe('⠋ Working for 0s');
    expect(loader.currentLabel).toBe('Working for 0s');

    runFrame(startedAt + 2_000);
    expect(loader.renderInline()).toMatch(/^\S Working for 2s$/u);
    expect(loader.currentLabel).toBe('Working for 2s');

    loader.setLabel('Compacting…');
    expect(loader.renderInline()).toMatch(/^\S Compacting…$/u);
    loader.stop();
  });
});
