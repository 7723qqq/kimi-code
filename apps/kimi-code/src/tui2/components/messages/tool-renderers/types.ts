/**
 * TUI2 tool result renderer types.
 *
 * Mirrors `tui/components/messages/tool-renderers/types.ts` with the
 * renderer signature adapted to the opentui model: a `ResultRenderer`
 * returns a SolidJS `JSX.Element` (the tui2 `shellExecutionResultRenderer`
 * already follows this shape) instead of pi-tui `Component[]`.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { JSX } from 'solid-js';

import { RESULT_PREVIEW_LINES } from '../../../constant/rendering';
import type { ToolCallBlockData, ToolResultBlockData } from '../../../types';

export interface RendererContext {
  readonly expanded: boolean;
}

export type ResultRenderer = (
  toolCall: ToolCallBlockData,
  result: ToolResultBlockData,
  ctx: RendererContext,
) => JSX.Element;

export const PREVIEW_LINES = RESULT_PREVIEW_LINES;

export function strArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}
