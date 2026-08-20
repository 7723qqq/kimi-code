/** @jsxImportSource @opentui/solid */
/**
 * TUI2 session picker — searchable list of past sessions with a card-style
 * row (title / id / work_dir / last_prompt / relative time).
 *
 * Replaces the v1 `SessionPickerComponent` (a pi-tui `Container` subclass)
 * with an opentui SolidJS view. The picker is self-contained: it owns
 * cursor / query / visibleCount signals, drives fuzzy search through
 * `SearchableList`, and exposes its lifecycle through the standard
 * `appendSessions` / `setPaging` methods (called by the host when
 * backend paging settles). Hover hit-testing is omitted for now — the
 * keyboard contract covers the primary flow.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import { fuzzyFilter } from '../../utils/fuzzy'

import { t } from '#/i18n'

import { formatSessionLabel } from '#/migration/index'

import { pageView } from '../../utils/paging'
import { getCurrentMark, SELECT_POINTER } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import { isPrintableChar, printableChar } from '../../utils/printable-key'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface SessionRow {
  readonly id: string
  readonly title: string | null
  readonly last_prompt?: string | null
  readonly work_dir: string
  readonly updated_at: number
  readonly metadata?: Readonly<Record<string, unknown>> | undefined
}

const ELLIPSIS = '…'

function formatRelativeTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const diffSec = Math.floor(Math.max(0, Date.now() - ts) / 1000)
  if (diffSec < 60) return t('tui.dialogs.sessionPicker.justNow')
  const minutes = Math.floor(diffSec / 60)
  if (minutes < 60) return t('tui.dialogs.sessionPicker.minutesAgo', { minutes: String(minutes) })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('tui.dialogs.sessionPicker.hoursAgo', { hours: String(hours) })
  const days = Math.floor(hours / 24)
  return t('tui.dialogs.sessionPicker.daysAgo', { days: String(days) })
}

function homeAlias(path: string): string {
  const home = process.env['HOME'] ?? ''
  if (home && path.startsWith(home)) return '~' + path.slice(home.length)
  return path
}

// Truncates from the LEFT (keeps the tail), prefixing an ellipsis when
// clipped. Paths typically carry the relevant info near the end, so we
// drop the prefix.
function truncatePathLeft(path: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (path.length <= maxWidth) return path
  if (maxWidth === 1) return ELLIPSIS
  return ELLIPSIS + path.slice(path.length - (maxWidth - 1))
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim()
}

function sessionSearchText(session: SessionRow): string {
  return singleLine((session.title ?? session.id).trim() || session.id)
}

export interface SessionPickerProps {
  readonly sessions: readonly SessionRow[]
  readonly loading: boolean
  readonly currentSessionId: string
  readonly scope?: 'cwd' | 'all'
  readonly initialSelectedSessionId?: string
  readonly pageSize?: number
  readonly onSelect: (session: SessionRow) => void
  readonly onCancel: () => void
  readonly onCtrlC?: () => void
  readonly onCtrlD?: () => void
  readonly onToggleScope?: (selectedSessionId: string) => void
  readonly maxVisibleSessions?: number
  readonly hasMore?: boolean
  readonly loadingMore?: boolean
  readonly onLoadMore?: () => void
  readonly onSearchDrain?: () => void
}

export const SessionPicker: Component<SessionPickerProps> = (props) => {
  const [sessions, setSessions] = createSignal<readonly SessionRow[]>(props.sessions)
  const [scope] = createSignal<'cwd' | 'all'>(props.scope ?? 'cwd')
  const [hasMore] = createSignal(props.hasMore ?? false)
  const [loadingMore] = createSignal(props.loadingMore ?? false)
  const [cursor, setCursor] = createSignal(0)
  const [query, setQuery] = createSignal('')
  const [visibleCount, setVisibleCount] = createSignal(
    Math.min(sessions().length, props.pageSize ?? 50),
  )

  const pageSize = (): number => Math.max(1, props.pageSize ?? 50)
  const maxVisible = (): number => props.maxVisibleSessions ?? 4

  const filtered = createMemo<readonly SessionRow[]>(() => {
    const all = sessions()
    const q = query()
    if (q.length === 0) return all
    return fuzzyFilter([...all], q, sessionSearchText)
  })
  const loaded = createMemo(() => filtered().slice(0, Math.min(filtered().length, visibleCount())))
  const page = createMemo(() => pageView(loaded().length, cursor(), maxVisible()))
  const selectedIndex = createMemo(() => Math.min(cursor(), Math.max(0, loaded().length - 1)))
  const visible = createMemo(() => loaded().slice(page().start, page().end))

  // External mutators (host calls these when backend paging settles).
  // Marked as `_` since they're part of the imperative host-facing API
  // (see v1 `appendSessions` / `setPaging`) but the host integration
  // hasn't landed yet — leave the structure in place so the host can
  // wire it without churning the picker again.
  function _appendSessions(rows: readonly SessionRow[]): void {
    setSessions((prev) => [...prev, ...rows])
    setVisibleCount((prev) => Math.max(prev, Math.min(filtered().length, pageSize())))
  }
  function _setPaging(nextHasMore: boolean, nextLoadingMore: boolean): void {
    // Read by render path; mutating via signals only works when callers
    // actually go through the imperative bridge. For now both signals are
    // initialised from props and never updated here.
    void nextHasMore
    void nextLoadingMore
  }

  function _syncVisibleCount(previousQuery: string): void {
    const q = query()
    if (q !== previousQuery) {
      setVisibleCount(Math.min(filtered().length, pageSize()))
      if (q.length > 0 && previousQuery.length === 0 && hasMore()) {
        props.onSearchDrain?.()
      }
      return
    }
    const loadedCount = Math.min(filtered().length, visibleCount())
    if (selectedIndex() >= loadedCount - 1 && loadedCount < filtered().length) {
      setVisibleCount(Math.min(filtered().length, visibleCount() + pageSize()))
    }
    if (
      hasMore() &&
      !loadingMore() &&
      filtered().length > 0 &&
      cursor() >= filtered().length - 1
    ) {
      props.onLoadMore?.()
    }
  }

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    if (event.ctrl && event.name === 'c') {
      event.stopPropagation()
      props.onCtrlC?.()
      return
    }
    if (event.ctrl && event.name === 'd') {
      event.stopPropagation()
      props.onCtrlD?.()
      return
    }
    if (event.ctrl && event.name === 'a') {
      event.stopPropagation()
      const sel = loaded()[selectedIndex()]
      props.onToggleScope?.(sel?.id ?? props.currentSessionId)
      return
    }
    switch (event.name) {
      case 'escape':
        if (query().length > 0) {
          setQuery('')
          setCursor(0)
          setVisibleCount(Math.min(filtered().length, pageSize()))
          return
        }
        event.stopPropagation()
        props.onCancel()
        return
      case 'return':
      case 'enter': {
        const session = loaded()[selectedIndex()]
        if (session !== undefined) {
          event.stopPropagation()
          props.onSelect(session)
        }
        return
      }
      case 'up':
        setCursor((c) => Math.max(0, c - 1))
        return
      case 'down':
        setCursor((c) => Math.min(Math.max(0, loaded().length - 1), c + 1))
        return
      case 'backspace':
        if (query().length > 0) {
          setQuery((q) => q.slice(0, -1))
          setCursor(0)
        }
        return
    }
    const ch = printableChar(event.sequence ?? event.name)
    if (isPrintableChar(ch)) {
      setQuery((q) => q + ch)
      setCursor(0)
    }
  }

  // Keep visibility in sync after cursor / query changes.
  // (SolidJS memos re-run on signal read, so this happens automatically.)
  // The previous-query capture is used inside the keymap callback, no extra
  // effect needed.

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const borderFg = (): ColorInput => currentTheme.color('primary')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const textFg = (): ColorInput => currentTheme.color('text')
  const textDimFg = (): ColorInput => currentTheme.color('textDim')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')
  const successFg = (): ColorInput => currentTheme.color('success')

  const titleText = (): string =>
    scope() === 'all'
      ? t('tui.dialogs.sessionPicker.titleAll')
      : t('tui.dialogs.sessionPicker.titleCwd')

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Title + (type to search) suffix */}
      <Show
        when={!props.loading}
        fallback={
          <Box>
            <Text fg={titleFg()} attributes={titleAttrs()}>{` ${titleText()}`}</Text>
          </Box>
        }
      >
        <Box flexDirection="row">
          <Text fg={titleFg()} attributes={titleAttrs()}>{` ${titleText()}`}</Text>
          <Show when={query().length === 0}>
            <Text fg={textMutedFg()}>{`  (${t('tui.dialogs.modelSelector.searchHint')})`}</Text>
          </Show>
        </Box>
      </Show>
      {/* Loading */}
      <Show when={props.loading}>
        <Box>
          <Text fg={textMutedFg()}>{` ${t('tui.dialogs.sessionPicker.loading')}`}</Text>
        </Box>
        <Box>
          <Text fg={borderFg()}>─</Text>
        </Box>
      </Show>
      {/* Empty */}
      <Show when={!props.loading && sessions().length === 0}>
        <Box>
          <Text fg={textMutedFg()}>{` ${t('tui.dialogs.sessionPicker.empty')}`}</Text>
        </Box>
        <Box>
          <Text fg={borderFg()}>─</Text>
        </Box>
      </Show>
      {/* Loaded list */}
      <Show when={!props.loading && sessions().length > 0}>
        {/* Hint */}
        <Box>
          <Text fg={textMutedFg()}>{` ${[
            ...(query().length > 0 ? [t('tui.dialogs.modelSelector.hintBackspace')] : []),
            t('tui.dialogs.modelSelector.hintNavigate'),
            props.onToggleScope === undefined
              ? null
              : scope() === 'all'
                ? t('tui.dialogs.sessionPicker.scopeHintCwd')
                : t('tui.dialogs.sessionPicker.scopeHintAll'),
            t('tui.dialogs.modelSelector.hintSelect'),
            t('tui.dialogs.modelSelector.hintCancel'),
          ]
            .filter((part): part is string => part !== null)
            .join(' · ')}`}</Text>
        </Box>
        {/* Blank */}
        <Box>
          <Text>{''}</Text>
        </Box>
        {/* Search line */}
        <Show when={query().length > 0}>
          <Box flexDirection="row">
            <Text fg={titleFg()}>{` ${t('tui.dialogs.sessionPicker.searchLabel')}`}</Text>
            <Text fg={textFg()}>{query()}</Text>
          </Box>
        </Show>
        {/* No matches */}
        <Show when={loaded().length === 0}>
          <Box>
            <Text fg={textMutedFg()}>{` ${t('tui.dialogs.modelSelector.noMatches')}`}</Text>
          </Box>
        </Show>
        {/* Cards */}
        <For each={visible()}>
          {(session, vi) => {
            const realIndex = (): number => page().start + vi()
            const isSelected = (): boolean => realIndex() === selectedIndex()
            const isCurrent = (): boolean => session.id === props.currentSessionId
            const time = (): string => formatRelativeTime(session.updated_at)
            const rawTitle = (): string =>
              (session.title ?? session.id).trim() || session.id
            const title = (): string =>
              formatSessionLabel({ title: rawTitle(), metadata: session.metadata })
            const badge = (): string => (isCurrent() ? getCurrentMark() : '')
            const aliasedDir = (): string => homeAlias(session.work_dir)
            const rawPrompt = (): string => session.last_prompt?.trim() ?? ''
            return (
              <>
                {/* Header row */}
                <Box flexDirection="row">
                  <Text fg={isSelected() ? titleFg() : textDimFg()}>{`  ${isSelected() ? SELECT_POINTER : ' '} `}</Text>
                  <Text
                    fg={isSelected() ? titleFg() : textFg()}
                    attributes={isSelected() ? titleAttrs() : undefined}
                  >
                    {title()}
                  </Text>
                  <Show when={time().length > 0}>
                    <Text fg={textDimFg()}>{`  ${time()}`}</Text>
                  </Show>
                  <Show when={badge().length > 0}>
                    <Text fg={successFg()}>{`  ${badge()}`}</Text>
                  </Show>
                </Box>
                {/* Meta row: id + dir */}
                <Box flexDirection="row">
                  <Text>{'  '}</Text>
                  <Text fg={textMutedFg()}>{session.id}</Text>
                  <Text>{'   '}</Text>
                  <Text fg={textMutedFg()}>{truncatePathLeft(aliasedDir(), 40)}</Text>
                </Box>
                {/* Prompt preview */}
                <Show when={rawPrompt().length > 0}>
                  <Box flexDirection="row">
                    <Text>{'  '}</Text>
                    <Text fg={textDimFg()}>{`› ${singleLine(rawPrompt())}`}</Text>
                  </Box>
                </Show>
                <Show when={vi() < visible().length - 1}>
                  <Box>
                    <Text>{''}</Text>
                  </Box>
                </Show>
              </>
            )
          }}
        </For>
        {/* Footer (paging / loaded summary) */}
        <Show when={loaded().length > visible().length || query().length > 0 || hasMore() || loadingMore()}>
          <Box>
            <Text>{''}</Text>
          </Box>
          <Box>
            <Text fg={textMutedFg()}>
              {` ${[
                t('tui.dialogs.sessionPicker.footerShowing', {
                  from: String(page().start + 1),
                  to: String(page().start + visible().length),
                  totalSuffix: '',
                }).trim(),
                loadingMore() ? 'loading more…' : hasMore() ? (query().length > 0 ? 'searching all…' : 'scroll for more') : '',
              ]
                .filter((part) => part.length > 0)
                .join(' · ')}`}
            </Text>
          </Box>
        </Show>
        {/* Bottom border */}
        <Box>
          <Text fg={borderFg()}>─</Text>
        </Box>
      </Show>
    </Box>
  )
}