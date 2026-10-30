import { onTestFinished, setSystemTime } from 'bun:test';

import { type TuiMouseEvent } from '@moonshot-ai/pi-tui';

export type MouseAction = 'move' | 'press' | 'release' | 'click' | 'wheel';

/**
 * A pointer event in a dialog's own frame coordinates — the frame the dialog
 * rendered into, not the terminal's.
 */
export function mouse(type: MouseAction, y: number, wheelDelta?: number, x = 4): TuiMouseEvent {
  return {
    type,
    button: type === 'move' || type === 'wheel' ? 'none' : 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width: 80,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta,
  };
}

/** Ages the panel past the click-settling window without touching real time. */
export function pastSettlingWindow(): void {
  setSystemTime(new Date(Date.now() + 1_000));
  onTestFinished(() => {
    setSystemTime();
  });
}
