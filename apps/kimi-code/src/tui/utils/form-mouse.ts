/**
 * Pointer forwarding for form dialogs.
 *
 * A form draws its `Input` inside a box, so the input's own frame starts after
 * the border and the padding. `Input.handleMouse` answers only a press on its
 * own row, so the dialog shifts the event into that frame here instead of
 * repeating the same arithmetic in every form.
 */

import type { Input, TuiMouseEvent, TuiMouseEventResult } from '@moonshot-ai/pi-tui';

export interface InputFrame {
  /** Row the input line was rendered on, in the dialog's own frame. */
  readonly row: number;
  /** Column the input's own frame starts at. */
  readonly column: number;
}

/** Where the pointer landed on an input line, if it did. */
export function inputPressAt(
  input: Input,
  event: TuiMouseEvent,
  frame: InputFrame,
): TuiMouseEventResult | undefined {
  if (event.type !== 'press' && event.type !== 'click') return undefined;
  if (event.y !== frame.row || event.x < frame.column) return undefined;
  // `Input.handleMouse` answers presses only. A click is the same point, and
  // placing the caret twice is harmless, so both arrive as a press.
  return input.handleMouse({ ...event, type: 'press', x: event.x - frame.column, y: 0 });
}
