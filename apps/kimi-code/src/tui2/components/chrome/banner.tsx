/** @jsxImportSource @opentui/solid */
/**
 * Banner -- a highlighted notice shown above the transcript.
 *
 * Replaces `tui/components/chrome/banner.ts`'s `BannerComponent`. The v1
 * implementation was a pi-tui `Component` whose `render(width)` returned
 * ANSI strings; this is an opentui SolidJS component that returns a layout
 * tree. Layout, wrapping and colouring are handled by opentui primitives and
 * the shared `currentTheme` singleton.
 *
 * The component mirrors the v1 visual contract, including the inline tag
 * layout: the tag (`✦ <tag>`, bold primary) shares the first line with the
 * bold main text whenever that leaves the main text at least
 * {@link MIN_INLINE_MAIN_TEXT_WIDTH} cells; continuation lines wrap inside
 * the main-text column (flex row), and the dim subtext hangs indented to
 * align with the tag text. When the tag would squeeze the main text into a
 * too-narrow column, it moves onto its own line.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { For, Show } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { visibleWidth } from '../../utils/width'
import { currentTheme } from '../../theme'
import type { BannerState } from '../../types'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface BannerProps {
  readonly state: BannerState
  /** Terminal width in cells; defaults to the detected stdout width. */
  readonly width?: number
}

const PREFIX_STAR = '✦';
const PADDING = ' ';
const TAG_PREFIX = `${PREFIX_STAR} `;
/**
 * Minimum column count the main text gets next to an inline tag. A long tag
 * (e.g. a full sentence from the remote banner config) can fit on the line
 * yet leave only a sliver for the main text, which then wraps into a narrow,
 * hard-broken column. When that would happen the tag moves onto its own line
 * and the main text uses (nearly) the full width instead. (v1 parity.)
 */
const MIN_INLINE_MAIN_TEXT_WIDTH = 16;
/** Fallback when the terminal width cannot be detected. */
const DEFAULT_BANNER_WIDTH = 80;

/** Layout decision for the tag row — mirrors v1's inline-tag math. */
export interface BannerTagLayout {
  /** Tag renders at all (present and narrower than the terminal). */
  readonly showTag: boolean;
  /** Tag shares the first line with the main text. */
  readonly inlineTag: boolean;
  /** Tag gets its own line (too wide to leave room for the text). */
  readonly tagOnOwnLine: boolean;
  /** Cells of `✦ <tag>` plus one padding space. */
  readonly tagWidth: number;
  /** Cells of the `✦ ` prefix — the hanging-indent width. */
  readonly hangingWidth: number;
}

export function computeBannerTagLayout(tag: string | null, width: number): BannerTagLayout {
  const tagLabel = tag !== null && tag.length > 0 ? `${TAG_PREFIX}${tag}` : '';
  const tagDisplay = tagLabel.length > 0 ? tagLabel + PADDING : '';
  const tagWidth = visibleWidth(tagDisplay);
  const showTag = tagWidth > 0 && tagWidth < width;
  const tagOnOwnLine = showTag && width - tagWidth < MIN_INLINE_MAIN_TEXT_WIDTH;
  return {
    showTag,
    inlineTag: showTag && !tagOnOwnLine,
    tagOnOwnLine,
    tagWidth,
    hangingWidth: visibleWidth(TAG_PREFIX),
  };
}

const readTerminalWidth = (): number => {
  const columns = process.stdout.columns;
  return typeof columns === 'number' && Number.isFinite(columns) ? columns : DEFAULT_BANNER_WIDTH;
};

export const BannerComponent: Component<BannerProps> = (props) => {
  const tag = (): string | null => props.state.tag;
  const main = (): string => props.state.mainText;
  const sub = (): string | null => props.state.subText;
  const subSegments = (): string[] => {
    const value = sub();
    if (value === null || value.length === 0) return [];
    return value.split('\n');
  };

  const layout = (): BannerTagLayout => computeBannerTagLayout(tag(), props.width ?? readTerminalWidth());

  const tagFg = (): ColorInput => currentTheme.color('primary')
  const mainFg = (): ColorInput => currentTheme.color('textStrong')
  const subFg = (): ColorInput => currentTheme.color('textDim')

  return (
    <Box flexDirection="column">
      <Show when={layout().tagOnOwnLine}>
        <Text fg={tagFg()} attributes={currentTheme.attributes('bold')}>
          {`${TAG_PREFIX}${tag() ?? ''}`}
        </Text>
      </Show>
      <Box flexDirection="row">
        <Show when={layout().inlineTag}>
          <Text fg={tagFg()} attributes={currentTheme.attributes('bold')}>
            {`${TAG_PREFIX}${tag() ?? ''}${PADDING}`}
          </Text>
        </Show>
        <Box flexGrow={1}>
          <Text fg={mainFg()} attributes={currentTheme.attributes('bold')} wrapMode="word">
            {main()}
          </Text>
        </Box>
      </Box>
      <Show when={subSegments().length > 0}>
        <For each={subSegments()}>
          {(segment) => (
            <Box paddingLeft={layout().showTag ? layout().hangingWidth : 0}>
              <Text fg={subFg()} wrapMode="word">{segment}</Text>
            </Box>
          )}
        </For>
      </Show>
      {/* Blank separator below the banner so following content keeps its
          breathing room (v1 rendered a trailing empty line). */}
      <Box height={1} />
    </Box>
  )
}
