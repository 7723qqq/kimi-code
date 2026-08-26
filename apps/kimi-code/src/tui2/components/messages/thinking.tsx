/** @jsxImportSource @opentui/solid */
/**
 * TUI2 thinking block view.
 *
 * Replaces `tui/components/messages/thinking.ts`'s `ThinkingComponent` (a
 * pi-tui `Component` with imperative `setText` / `setExpanded` /
 * `handleClick` and a spinner interval) with an opentui SolidJS view.
 *
 * Two modes, mirroring v1:
 *
 * - `live`: a braille-spinner row (`⠋ thinking…`, textDim) plus the tail
 *   of the streaming content (last {@link THINKING_PREVIEW_LINES} lines),
 *   re-rendered on a spinner tick while `mode` stays `live`.
 * - `finalized`: `● ` marker + italic dim content; collapsed content caps
 *   at {@link THINKING_PREVIEW_LINES} lines with a `+N more` hint (the
 *   hint copy matches v1; ctrl+o expansion is owned by the transcript
 *   renderer via `onToggle` + `expanded`).
 *
 * The cap counts *visual* rows, matching v1's cap on pi-tui's wrapped
 * rows: logical lines are folded through {@link wrapToVisualRows}
 * (CJK/emoji width-aware) against the available columns — the `width`
 * prop when provided, else the live terminal width via
 * `resolvePreviewWidth` — so one long line cannot stretch the preview.
 * Navigation focus (`navigated`) paints the header row with the accent
 * background, mirroring v1's `currentTheme.bg`.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { t } from '#/i18n'
import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
  THINKING_PREVIEW_LINES,
} from '../../constant/rendering'
import { STATUS_BULLET } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import { resolvePreviewWidth, wrapToVisualRows } from '../../utils/width'

import { Box } from '../common/box'
import { Clickable } from '../common/clickable'
import { Text } from '../common/text'
import { trimTrailingEmptyLines } from './shell-execution'

export type ThinkingRenderMode = 'live' | 'finalized'

/** Two-cell left margin rendered by the view's `paddingLeft`. */
const PREVIEW_INDENT = 2

export interface ThinkingViewProps {
  readonly content: string
  /** `live` shows the spinner + content tail; `finalized` the bullet view. */
  readonly mode?: ThinkingRenderMode
  readonly showMarker?: boolean
  /** Collapsed (preview capped) vs expanded (full content). */
  readonly expanded?: boolean
  /** Terminal columns available to the view; defaults to the live terminal
   * width via `resolvePreviewWidth` when omitted. Collapsed/live previews
   * fold logical lines into visual rows against this budget minus the
   * two-cell left padding before capping. */
  readonly width?: number
  /** Navigation-mode focus: accent background on the header row. */
  readonly navigated?: boolean
  /** Fired on click (host toggles expansion). */
  readonly onToggle?: () => void
}

export const ThinkingView: Component<ThinkingViewProps> = (props) => {
  const [frame, setFrame] = createSignal(0)

  createEffect(() => {
    if (props.mode !== 'live') return;
    const id = setInterval(
      () => setFrame((f) => (f + 1) % BRAILLE_SPINNER_FRAMES.length),
      BRAILLE_SPINNER_INTERVAL_MS,
    );
    onCleanup(() => clearInterval(id));
  });

  const lines = (): readonly string[] =>
    props.content.length === 0 ? [] : trimTrailingEmptyLines(props.content.split('\n'));
  const collapsed = (): boolean => props.expanded !== true;
  /** Logical lines folded into word-wrapped visual rows against the
   * available columns (left padding excluded) — the unit the preview caps
   * count, so a long single line cannot stretch it. */
  const visualRows = (): readonly string[] => {
    const width = Math.max(1, resolvePreviewWidth(props.width) - PREVIEW_INDENT);
    const rows: string[] = [];
    for (const line of lines()) rows.push(...wrapToVisualRows(line, width));
    return rows;
  };
  const visibleContent = (): string => {
    if (collapsed()) {
      return visualRows().slice(0, THINKING_PREVIEW_LINES).join('\n');
    }
    return props.content;
  };
  const hasMore = (): boolean => visualRows().length > THINKING_PREVIEW_LINES;
  const expandHint = (): string =>
    t('tui.messages.thinking.expandHint', {
      count: visualRows().length - THINKING_PREVIEW_LINES,
    });
  const spinner = (): string => `${BRAILLE_SPINNER_FRAMES[frame()] ?? BRAILLE_SPINNER_FRAMES[0]} `;
  const contentFg = (): ColorInput => currentTheme.color('textDim');
  const contentAttributes = (): number => currentTheme.attributes('italic');
  const headerBackground = (): ColorInput | undefined =>
    props.navigated === true ? currentTheme.color('accent') : undefined;

  return (
    <Clickable onClick={props.onToggle}>
      <Box flexDirection="column" paddingLeft={2}>
        {props.mode === 'live' ? (
          <>
            <Box flexDirection="row" backgroundColor={headerBackground()}>
              <Text fg={contentFg()}>{spinner()}</Text>
              <Text fg={contentFg()}>{t('tui.messages.thinking.liveLabel')}</Text>
            </Box>
            <For each={visualRows().slice(-THINKING_PREVIEW_LINES)}>
              {(line) => (
                <Text fg={contentFg()} attributes={contentAttributes()} wrapMode="word">
                  {line}
                </Text>
              )}
            </For>
          </>
        ) : (
          <>
            <Box flexDirection="row" backgroundColor={headerBackground()}>
              <Show when={props.showMarker !== false}>
                <Text fg={contentFg()}>{STATUS_BULLET}</Text>
              </Show>
              <Text fg={contentFg()} attributes={contentAttributes()} wrapMode="word">
                {visibleContent()}
              </Text>
            </Box>
            <Show when={collapsed() && hasMore()}>
              <Text fg={contentFg()} attributes={currentTheme.attributes('dim')} wrapMode="word">
                {expandHint()}
              </Text>
            </Show>
          </>
        )}
      </Box>
    </Clickable>
  )
}
