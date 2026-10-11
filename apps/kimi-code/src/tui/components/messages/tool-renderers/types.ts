import type { Component } from '@moonshot-ai/pi-tui';

import { RESULT_PREVIEW_LINES } from '#/tui/constant/rendering';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

export interface RendererContext {
  readonly expanded: boolean;
}

export type ResultRenderer = (
  toolCall: ToolCallBlockData,
  result: ToolResultBlockData,
  ctx: RendererContext,
) => Component[];

export const PREVIEW_LINES = RESULT_PREVIEW_LINES;

// The spill envelope's opening line. The persisted form continues with the
// saved file's name; the unpersisted form (the spill file could not be
// written) ends the sentence and drops `output_path` with it.
const SPILL_MARKER = /^Tool output exceeded \d+ characters(?:;| and could not be saved to a file)/;
// The envelope's metadata header: `tool_name`, `tool_call_id`,
// `output_size_chars`, then `output_path`. The preview only starts after a
// blank line, so a handful of lines is always inside the header.
const SPILL_HEADER_LINES = 8;

/**
 * Whether a tool result is the truncation envelope agent-core substitutes for
 * output over its size cap (metadata, `output_path`, and a head/tail preview).
 * Renderers that count or sample result lines must not read it as data.
 *
 * The marker sentence alone is not enough: a command that prints it still
 * produces plain output, so the envelope must also carry its metadata header.
 */
export function isSpilledToolOutput(output: string): boolean {
  if (!SPILL_MARKER.test(output)) return false;
  const header = output.split('\n', SPILL_HEADER_LINES).join('\n');
  // A persisted envelope names the file it spilled to; the unpersisted one has
  // no path and is identified by the call metadata that replaces it.
  return /^output_path: /m.test(header) || /^tool_call_id: /m.test(header);
}

export function strArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

const PER_LINE_SPILL_POINTER = '[Per-line truncation occurred;';
const PER_LINE_SPILL_PATH = 'output_path: ';

/**
 * Drop the pointer agent-core appends when an oversized result kept its
 * shape but had long lines cut: three bracketed lines, `output_path` and
 * `next_step` included, that are metadata rather than output. Counts and
 * outcome rows read the output without it; the expanded body keeps it.
 *
 * The marker must open a line of its own and the `output_path:` line must sit
 * directly under it; output that merely quotes the marker sentence is data and
 * keeps everything behind it.
 */
export function stripSpillPointer(output: string): string {
  const start = pointerLineStart(output);
  if (start < 0) return output;
  const path = lineAfter(output, start);
  return path !== undefined && path.startsWith(PER_LINE_SPILL_PATH)
    ? output.slice(0, start)
    : output;
}

/** Index of the line that starts with the pointer marker, or -1. */
function pointerLineStart(output: string): number {
  if (output.startsWith(PER_LINE_SPILL_POINTER)) return 0;
  const found = output.indexOf(`\n${PER_LINE_SPILL_POINTER}`);
  return found < 0 ? -1 : found + 1;
}

/** The whole line after `lineStart`, or undefined when it is the last one. */
function lineAfter(text: string, lineStart: number): string | undefined {
  const markerEnd = text.indexOf('\n', lineStart);
  if (markerEnd < 0) return undefined;
  const nextEnd = text.indexOf('\n', markerEnd + 1);
  return nextEnd < 0 ? text.slice(markerEnd + 1) : text.slice(markerEnd + 1, nextEnd);
}

const MEMO_LIMIT = 8;

/**
 * A small bounded memo for the parsers: the chip, the glance and the notice
 * probe all re-read the same result during one rebuild, and each parse walks
 * the whole output. The newest entries are kept and the oldest is evicted
 * first; `compute` runs once per key until then.
 */
export function memoizeBounded<T>(cache: Map<string, T>, key: string, compute: () => T): T {
  if (cache.has(key)) {
    const cached = cache.get(key) as T;
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const value = compute();
  cache.set(key, value);
  if (cache.size > MEMO_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}
