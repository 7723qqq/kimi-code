/** @jsxImportSource @opentui/solid */
/**
 * TUI2 experiments selector — searchable list of experimental features
 * with per-row toggle (Space) and an Apply button.
 *
 * Replaces the v1 `ExperimentsSelectorComponent` (a pi-tui `Container`
 * built on `SearchableList`) with an opentui SolidJS view. The picker
 * tracks a per-feature "draft" of enabled state; pressing Enter collects
 * every changed feature and hands the diff to `onApply`. Cancel
 * discards the draft.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import type { ExperimentalFeatureState } from '@moonshot-ai/kimi-code-sdk'

import { fuzzyFilter } from '@moonshot-ai/pi-tui'

import { t } from '#/i18n'

import { pageView } from '../../utils/paging'
import { SELECT_POINTER } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import { isPrintableChar, printableChar } from '../../utils/printable-key'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface ExperimentalFeatureDraftChange {
  readonly id: ExperimentalFeatureState['id']
  readonly enabled: boolean
}

export interface ExperimentsSelectorProps {
  readonly features: readonly ExperimentalFeatureState[]
  readonly onApply: (changes: readonly ExperimentalFeatureDraftChange[]) => void
  readonly onCancel: () => void
}

function isLocked(feature: ExperimentalFeatureState): boolean {
  return feature.source === 'env' || feature.source === 'master-env'
}

function sourceLabel(feature: ExperimentalFeatureState): string {
  switch (feature.source) {
    case 'master-env':
      return t('tui.dialogs.experimentsSelector.lockedByMasterEnv')
    case 'env':
      return t('tui.dialogs.experimentsSelector.lockedBy', { env: feature.env })
    case 'config':
      return t('tui.dialogs.experimentsSelector.sourceConfig')
    case 'default':
      return t('tui.dialogs.experimentsSelector.sourceDefault')
  }
}

function featureTitle(feature: ExperimentalFeatureState): string {
  const key = `tui.dialogs.experimentsSelector.features.${feature.id}.title` as const
  const translated = t(key)
  return translated === key ? feature.title : translated
}

function featureDescription(feature: ExperimentalFeatureState): string {
  const key = `tui.dialogs.experimentsSelector.features.${feature.id}.description` as const
  const translated = t(key)
  return translated === key ? feature.description : translated
}

function featureDetail(feature: ExperimentalFeatureState): string {
  const source = sourceLabel(feature)
  const idPart = t('tui.dialogs.experimentsSelector.featureId', { id: feature.id })
  if (feature.source === 'env' || feature.source === 'master-env') {
    return `${idPart} · ${source}`
  }
  return `${idPart} · ${source} · ${feature.env}`
}

export const ExperimentsSelector: Component<ExperimentsSelectorProps> = (props) => {
  const [cursor, setCursor] = createSignal(0)
  const [query, setQuery] = createSignal('')
  const [draft, setDraft] = createSignal(new Map<ExperimentalFeatureState['id'], boolean>())

  function effectiveEnabled(feature: ExperimentalFeatureState): boolean {
    return draft().get(feature.id) ?? feature.enabled
  }
  function isDraftChanged(feature: ExperimentalFeatureState): boolean {
    return effectiveEnabled(feature) !== feature.enabled
  }

  const filtered = createMemo<readonly ExperimentalFeatureState[]>(() => {
    const all = props.features
    const q = query()
    if (q.length === 0) return all
    return fuzzyFilter(
      [...all],
      q,
      (f) => `${featureTitle(f)} ${f.id} ${featureDescription(f)}`,
    )
  })
  const page = createMemo(() => pageView(filtered().length, cursor(), 8))
  const selectedIndex = createMemo(() =>
    Math.min(cursor(), Math.max(0, filtered().length - 1)),
  )
  const visible = createMemo(() => filtered().slice(page().start, page().end))
  const draftChanges = createMemo<ExperimentalFeatureDraftChange[]>(() =>
    props.features
      .filter(isDraftChanged)
      .map((feature) => ({ id: feature.id, enabled: effectiveEnabled(feature) })),
  )

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    switch (event.name) {
      case 'escape':
        if (query().length > 0) {
          setQuery('')
          setCursor(0)
          return
        }
        event.stopPropagation()
        props.onCancel()
        return
      case 'up':
        setCursor((c) => Math.max(0, c - 1))
        return
      case 'down':
        setCursor((c) => Math.min(Math.max(0, filtered().length - 1), c + 1))
        return
      case 'pageup':
        setCursor((c) => Math.max(0, c - 8))
        return
      case 'pagedown':
        setCursor((c) => Math.min(Math.max(0, filtered().length - 1), c + 8))
        return
      case 'return':
      case 'enter': {
        event.stopPropagation()
        const changes = draftChanges()
        props.onApply(changes)
        return
      }
      case 'space':
      case ' ':
        event.stopPropagation()
        toggleSelected()
        return
      case 'backspace':
        if (query().length > 0) {
          setQuery((q) => q.slice(0, -1))
          setCursor(0)
        }
        return
    }
    if (query().length === 0 && event.name !== 'tab') return
    const ch = printableChar(event.sequence ?? event.name)
    if (isPrintableChar(ch)) {
      setQuery((q) => q + ch)
      setCursor(0)
    }
  }

  function toggleSelected(): void {
    const feature = filtered()[selectedIndex()]
    if (feature === undefined || isLocked(feature)) return
    const next = !effectiveEnabled(feature)
    setDraft((prev) => {
      const updated = new Map(prev)
      if (next === feature.enabled) {
        updated.delete(feature.id)
      } else {
        updated.set(feature.id, next)
      }
      return updated
    })
  }

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

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Title + search hint */}
      <Box flexDirection="row">
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.dialogs.experimentsSelector.title')}`}</Text>
        <Show when={query().length === 0}>
          <Text fg={textMutedFg()}>{`  (${t('tui.dialogs.modelSelector.searchHint')})`}</Text>
        </Show>
      </Box>
      {/* Hint */}
      <Box>
        <Text fg={textMutedFg()}>{` ${[
          t('tui.dialogs.experimentsSelector.hintNavigate'),
          t('tui.dialogs.experimentsSelector.hintSpace'),
          t('tui.dialogs.experimentsSelector.hintEnter'),
          t('tui.dialogs.experimentsSelector.hintCancel'),
        ].join(' · ')}`}</Text>
      </Box>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Search line */}
      <Show when={query().length > 0}>
        <Box flexDirection="row">
          <Text fg={titleFg()}>{` ${t('tui.dialogs.modelSelector.searchLabel')}`}</Text>
          <Text fg={textFg()}>{query()}</Text>
        </Box>
      </Show>
      {/* List */}
      <Show
        when={visible().length > 0}
        fallback={
          <Box>
            <Text fg={textMutedFg()}>{`   ${t('tui.dialogs.modelSelector.noMatches')}`}</Text>
          </Box>
        }
      >
        <For each={visible()}>
          {(feature, i) => {
            const realIndex = (): number => page().start + i()
            const selected = (): boolean => realIndex() === selectedIndex()
            const enabled = (): boolean => effectiveEnabled(feature)
            const changed = (): boolean => isDraftChanged(feature)
            return (
              <>
                <Box flexDirection="row">
                  <Text fg={selected() ? titleFg() : textDimFg()}>{`  ${selected() ? SELECT_POINTER : ' '} `}</Text>
                  <Text
                    fg={selected() ? titleFg() : textFg()}
                    attributes={selected() ? titleAttrs() : undefined}
                  >
                    {featureTitle(feature)}
                  </Text>
                  <Text>{'  '}</Text>
                  <Text fg={enabled() ? successFg() : textDimFg()}>
                    {enabled()
                      ? t('tui.dialogs.experimentsSelector.statusEnabled')
                      : t('tui.dialogs.experimentsSelector.statusDisabled')}
                  </Text>
                </Box>
                <Box>
                  <Text fg={textMutedFg()}>{`    ${
                    changed() ? `${featureDetail(feature)}${t('tui.dialogs.experimentsSelector.modifiedSuffix')}` : featureDetail(feature)
                  }`}</Text>
                </Box>
                <Show when={featureDescription(feature).length > 0}>
                  <Box>
                    <Text fg={textMutedFg()} wrapMode="word">{`    ${featureDescription(feature)}`}</Text>
                  </Box>
                </Show>
              </>
            )
          }}
        </For>
      </Show>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Page indicator */}
      <Show when={query().length > 0}>
        <Box>
          <Text fg={textMutedFg()}>{` ${filtered().length} / ${props.features.length}`}</Text>
        </Box>
      </Show>
      <Show
        when={page().pageCount > 1}
        fallback={
          <Show when={page().end < filtered().length}>
            <Box>
              <Text fg={textMutedFg()}>{` ${t('tui.dialogs.experimentsSelector.more', {
                count: filtered().length - page().end,
              })}`}</Text>
            </Box>
          </Show>
        }
      >
        <Box>
          <Text fg={textMutedFg()}>{` ${page().page + 1} / ${page().pageCount}`}</Text>
        </Box>
      </Show>
      {/* Apply button */}
      <Box flexDirection="row">
        <Show
          when={draftChanges().length > 0}
          fallback={
            <>
              <Text fg={textDimFg()}>{` ${t('tui.dialogs.experimentsSelector.applyButton')}`}</Text>
              <Text>{'  '}</Text>
              <Text fg={textMutedFg()}>{t('tui.dialogs.experimentsSelector.noChanges')}</Text>
            </>
          }
        >
          <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.dialogs.experimentsSelector.applyButton')}`}</Text>
          <Text>{'  '}</Text>
          <Text fg={successFg()}>
            {t(
              draftChanges().length === 1
                ? 'tui.dialogs.experimentsSelector.changeCount_one'
                : 'tui.dialogs.experimentsSelector.changeCount_other',
              { count: draftChanges().length },
            )}
          </Text>
        </Show>
      </Box>
      {/* Bottom border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  )
}