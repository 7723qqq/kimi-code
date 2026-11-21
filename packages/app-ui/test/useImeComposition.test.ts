import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';

import { useImeComposition } from '../src/composables/useImeComposition';

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
  else Reflect.deleteProperty(globalThis, 'window');
});

function keyEvent(init: { isComposing?: boolean; keyCode?: number }): KeyboardEvent {
  return init as KeyboardEvent;
}

describe('useImeComposition', () => {
  it('lets a plain Enter through when no IME is active', () => {
    const { isComposingKeyEvent } = useImeComposition();
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
  });

  it('blocks keys while a composition is in progress', () => {
    const { handleCompositionStart, isComposingKeyEvent } = useImeComposition();
    handleCompositionStart();
    expect(isComposingKeyEvent(keyEvent({ isComposing: true, keyCode: 229 }))).toBe(true);
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(true);
  });

  it('keeps blocking the candidate-confirming keydown that follows compositionend', () => {
    const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } =
      useImeComposition();
    handleCompositionStart();
    handleCompositionEnd();
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(true);
  });

  it('blocks a confirming keydown arriving several tasks after compositionend', () => {
    const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } =
      useImeComposition();
    handleCompositionStart();
    handleCompositionEnd();
    jest.advanceTimersByTime(50);
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(true);
  });

  it('lifts the post-composition guard after the window so a real Enter commits', () => {
    const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } =
      useImeComposition();
    handleCompositionStart();
    handleCompositionEnd();
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(true);
    jest.advanceTimersByTime(150);
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
  });

  it('does not guard keys without a recent composition', () => {
    const { isComposingKeyEvent } = useImeComposition();
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
  });

  it('treats legacy keyCode 229 as composing without any composition events', () => {
    const { isComposingKeyEvent } = useImeComposition();
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 229 }))).toBe(true);
  });

  it('recovers via resetComposition when compositionend never fires', () => {
    const { handleCompositionStart, resetComposition, isComposingKeyEvent } = useImeComposition();
    handleCompositionStart();
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(true);
    resetComposition();
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
    jest.advanceTimersByTime(1);
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
  });

  it('self-heals on focus changes when window is available', () => {
    const listeners = new Map<string, () => void>();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
        removeEventListener: () => {},
      },
    });
    const { handleCompositionStart, isComposingKeyEvent } = useImeComposition();
    handleCompositionStart();
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(true);
    listeners.get('focusout')?.();
    expect(isComposingKeyEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
  });
});
