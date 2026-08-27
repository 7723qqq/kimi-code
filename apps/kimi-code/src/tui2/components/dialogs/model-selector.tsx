/** @jsxImportSource @opentui/solid */
/**
 * TUI2 model selector — searchable, single-list picker with per-row
 * thinking-effort control.
 *
 * Replaces the v1 `ModelSelectorComponent` (a pi-tui `Container` subclass)
 * with an opentui SolidJS view. The picker owns cursor / query / per-model
 * effort-overrides signals and consumes key events via `useKeyboard`. The
 * thinking-effort toggle under the list mirrors DESIGN.md §8: ←/→ step
 * the active segment within the model's segment list, with a "[ On ] Off"
 * look. The picker is also reused as the body of
 * `tabbed-model-selector` (which adds provider tabs above the list).
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import {
  effectiveModelAlias,
  type ModelAlias,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk'

import { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '../../../constant/app'
import { t } from '#/i18n'

import { getCurrentMark, SELECT_POINTER } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import { createSearchableList } from '../../utils/searchable-list'
import { wrapToVisualRows } from '../../utils/width'
import { effortLabel } from './effort-label'

import { Box } from '../common/box'
import { Clickable } from '../common/clickable'
import { Text } from '../common/text'

interface ModelChoice {
  readonly alias: string
  readonly model: ModelAlias
  readonly name: string
  readonly provider: string
  readonly label: string
}

export interface ModelSelection {
  readonly alias: string
  readonly thinking: ThinkingEffort
}

export function modelDisplayName(alias: string, model: ModelAlias | undefined): string {
  const effective = model === undefined ? undefined : effectiveModelAlias(model)
  return effective?.displayName ?? effective?.model ?? alias
}

export function providerDisplayName(provider: string): string {
  if (provider === DEFAULT_OAUTH_PROVIDER_NAME) return PRODUCT_NAME
  if (provider.startsWith('managed:')) return provider.slice('managed:'.length)
  return provider
}

export function createModelChoices(models: Record<string, ModelAlias>): readonly ModelChoice[] {
  return Object.entries(models).map(([alias, cfg]) => {
    const effective = effectiveModelAlias(cfg)
    const name = modelDisplayName(alias, effective)
    const provider = providerDisplayName(effective.provider)
    return { alias, model: effective, name, provider, label: `${name} (${provider})` }
  })
}

export function thinkingAvailabilityKind(model: ModelAlias): 'toggle' | 'always-on' | 'unsupported' {
  const caps = model.capabilities ?? []
  if (caps.includes('always_thinking')) return 'always-on'
  if (caps.includes('thinking') || model.adaptiveThinking === true) return 'toggle'
  return 'unsupported'
}

export function effortsOf(model: ModelAlias): readonly string[] {
  return model.supportEfforts ?? []
}

export function segmentsFor(model: ModelAlias): readonly string[] {
  const efforts = effortsOf(model)
  const availability = thinkingAvailabilityKind(model)
  if (efforts.length > 0) {
    return availability === 'always-on' ? efforts : ['off', ...efforts]
  }
  if (availability === 'always-on') return ['on']
  if (availability === 'unsupported') return ['off']
  return ['on', 'off']
}

export function defaultThinkingEffortFor(model: ModelAlias): ThinkingEffort {
  if (thinkingAvailabilityKind(model) === 'unsupported') return 'off'
  const efforts = effortsOf(model)
  if (efforts.length > 0) {
    const middle = efforts[Math.floor(efforts.length / 2)]
    return model.defaultEffort ?? middle ?? 'off'
  }
  return 'on'
}

function commitEffort(choice: ModelChoice, draft: ThinkingEffort): ThinkingEffort {
  if (draft === 'on') return defaultThinkingEffortFor(choice.model)
  return draft
}

export interface ModelSelectorProps {
  readonly models: Record<string, ModelAlias>
  readonly currentValue: string
  readonly selectedValue?: string
  readonly currentThinkingEffort: ThinkingEffort
  readonly title?: string
  readonly searchable?: boolean
  readonly pageSize?: number
  readonly providerSwitchHint?: boolean
  readonly warning?: string
  readonly thinkingControl?: boolean
  readonly onSelect: (selection: ModelSelection) => void
  readonly onSessionOnlySelect?: (selection: ModelSelection) => void
  readonly onCancel: () => void
}

function wrapPlain(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width)
  // Fold by visible width (CJK glyphs span two columns) so wrapped
  // description lines stay inside the selector on CJK locales.
  return wrapToVisualRows(text, safeWidth)
}

export const ModelSelector: Component<ModelSelectorProps> = (props) => {
  const choices = createMemo(() => createModelChoices(props.models))
  const [overrides, setOverrides] = createSignal<Map<string, string>>(new Map())
  const list = createSearchableList<ModelChoice>({
    items: choices,
    toSearchText: (c) => c.label,
    pageSize: Math.max(1, props.pageSize ?? 8),
    initialIndex: Math.max(
      choices().findIndex((c) => c.alias === (props.selectedValue ?? props.currentValue)),
      0,
    ),
    searchable: props.searchable,
  })
  const setCursor = list.setCursor
  const query = list.query
  const setQuery = list.setQuery
  const filtered = list.filtered
  const page = list.page
  const selectedIndex = list.selectedIndex
  const visible = list.visible
  const selectedChoice = (): ModelChoice | undefined => list.selected()

  function draftFor(choice: ModelChoice): string {
    const override = overrides().get(choice.alias)
    if (override !== undefined) return override
    if (choice.alias === props.currentValue) return props.currentThinkingEffort
    const efforts = effortsOf(choice.model)
    if (efforts.length > 0) {
      const def = choice.model.defaultEffort ?? efforts[Math.floor(efforts.length / 2)]
      if (def !== undefined && efforts.includes(def)) return def
      return efforts[0]!
    }
    return thinkingAvailabilityKind(choice.model) !== 'unsupported' ? 'on' : 'off'
  }
  function effectiveEffort(choice: ModelChoice): string {
    const draft = draftFor(choice)
    const segments = segmentsFor(choice.model)
    return segments.includes(draft) ? draft : segments[0]!
  }

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
      case 'left':
      case 'right':
        if (props.thinkingControl === false) return
        {
          const selected = selectedChoice()
          if (selected === undefined) return
          const segments = segmentsFor(selected.model)
          if (segments.length < 2) return
          const current = effectiveEffort(selected)
          const idx = segments.indexOf(current)
          let next: number
          if (segments.length === 2) {
            next = idx === 0 ? 1 : 0
          } else {
            const delta = event.name === 'left' ? -1 : 1
            next = Math.max(0, Math.min(segments.length - 1, idx + delta))
          }
          if (next !== idx) {
            const segment = segments[next]
            if (segment !== undefined) {
              setOverrides((prev) => new Map(prev).set(selected.alias, segment))
            }
          }
        }
        return
      case 'up':
      case 'down':
      case 'pageup':
      case 'pagedown':
      case 'backspace':
        list.handleNavigationKey(event)
        return
      case 'return':
      case 'enter': {
        const selected = selectedChoice()
        if (selected === undefined) return
        event.stopPropagation()
        props.onSelect({ alias: selected.alias, thinking: commitEffort(selected, effectiveEffort(selected)) })
        return
      }
    }
    // Alt+S session-only.
    if (
      event.option &&
      (event.name === 's' || event.name === 'S') &&
      props.onSessionOnlySelect !== undefined
    ) {
      const selected = selectedChoice()
      if (selected === undefined) return
      event.stopPropagation()
      props.onSessionOnlySelect({
        alias: selected.alias,
        thinking: commitEffort(selected, effectiveEffort(selected)),
      })
      return
    }
    // Search printable.
    list.handleNavigationKey(event)
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
  const warningFg = (): ColorInput => currentTheme.color('warning')

  const isSearchable = (): boolean => props.searchable === true

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Title */}
      <Box flexDirection="row">
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${props.title ?? t('tui.dialogs.modelSelector.title')}`}</Text>
        <Show when={isSearchable() && query().length === 0}>
          <Text fg={textMutedFg()}>{`  (${t('tui.dialogs.modelSelector.searchHint')})`}</Text>
        </Show>
      </Box>
      {/* Hint */}
      <Box>
        <Text fg={textMutedFg()}>{` ${[
          ...(props.providerSwitchHint === true ? [t('tui.dialogs.modelSelector.hintTab')] : []),
          t('tui.dialogs.modelSelector.hintNavigate'),
          ...(isSearchable() && query().length > 0 ? [t('tui.dialogs.modelSelector.hintBackspace')] : []),
          t('tui.dialogs.modelSelector.hintSelect'),
          ...(props.onSessionOnlySelect !== undefined ? [t('tui.dialogs.modelSelector.hintSessionOnly')] : []),
          t('tui.dialogs.modelSelector.hintCancel'),
        ].join(' · ')}`}</Text>
      </Box>
      {/* Warning */}
      <Show when={props.warning !== undefined && props.warning.length > 0}>
        <For each={wrapPlain(props.warning ?? '', 80)}>
          {(line) => (
            <Box>
              <Text fg={warningFg()}>{` ${line}`}</Text>
            </Box>
          )}
        </For>
      </Show>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Search line */}
      <Show when={isSearchable() && query().length > 0}>
        <Box flexDirection="row">
          <Text fg={titleFg()}>{` ${t('tui.dialogs.modelSelector.searchLabel')}`}</Text>
          <Text fg={textFg()}>{query()}</Text>
        </Box>
      </Show>
      {/* No matches */}
      <Show when={visible().length === 0}>
        <Box>
          <Text fg={textMutedFg()}>{`   ${t('tui.dialogs.modelSelector.noMatches')}`}</Text>
        </Box>
      </Show>
      {/* List */}
      <For each={visible()}>
        {(choice, i) => {
          const realIndex = (): number => page().start + i()
          const selected = (): boolean => realIndex() === selectedIndex()
          const isCurrent = (): boolean => choice.alias === props.currentValue
          return (
            <Clickable
              onClick={() =>
                props.onSelect({
                  alias: choice.alias,
                  thinking: commitEffort(choice, effectiveEffort(choice)),
                })
              }
              onHover={() => setCursor(realIndex())}
            >
              <Box flexDirection="row">
                <Text fg={selected() ? titleFg() : textDimFg()}>{`  ${selected() ? SELECT_POINTER : ' '} `}</Text>
                <Text
                  fg={selected() ? titleFg() : textFg()}
                  attributes={selected() ? titleAttrs() : undefined}
                >
                  {choice.name}
                </Text>
                <Text>{'  '}</Text>
                <Text fg={textMutedFg()}>{choice.provider}</Text>
                <Show when={isCurrent()}>
                  <Text fg={successFg()}>{` ${getCurrentMark()}`}</Text>
                </Show>
              </Box>
            </Clickable>
          )
        }}
      </For>
      {/* Count / paging indicator */}
      <Show when={query().length > 0}>
        <Box>
          <Text>{''}</Text>
        </Box>
        <Box>
          <Text fg={textMutedFg()}>{` ${t('tui.dialogs.modelSelector.count', {
            matches: filtered().length,
            total: Object.keys(props.models).length,
          })}`}</Text>
        </Box>
      </Show>
      <Show when={query().length === 0 && filtered().length > page().end}>
        <Box>
          <Text>{''}</Text>
        </Box>
        <Box>
          <Text fg={textMutedFg()}>{` ${t('tui.dialogs.modelSelector.more', {
            count: filtered().length - page().end,
          })}`}</Text>
        </Box>
      </Show>
      {/* Thinking control */}
      <Show when={selectedChoice() !== undefined && props.thinkingControl !== false}>
        <Box>
          <Text>{''}</Text>
        </Box>
        <Box>
          <Text fg={textMutedFg()}>{(() => {
            const selected = selectedChoice()
            if (selected === undefined) return t('tui.dialogs.modelSelector.thinking')
            const canSwitch = segmentsFor(selected.model).length > 1
            return canSwitch
              ? t('tui.dialogs.modelSelector.thinkingSwitchable')
              : t('tui.dialogs.modelSelector.thinking')
          })()}</Text>
        </Box>
        <Show when={selectedChoice() !== undefined}>
          {(() => {
            const selected = selectedChoice()
            if (selected === undefined) return null
            const efforts = effortsOf(selected.model)
            const availability = thinkingAvailabilityKind(selected.model)
            const segments = segmentsFor(selected.model)
            const active = effectiveEffort(selected)
            return (
              <Box flexDirection="row">
                <Text>{'  '}</Text>
                <For each={segments}>
                  {(segment, i) => {
                    const isActive = (): boolean => segment === active
                    if (efforts.length === 0 && availability === 'always-on' && i() === 1) {
                      return (
                        <Text fg={textMutedFg()}>{`  ${effortLabel(segment)} (${t('tui.dialogs.modelSelector.unsupported')})  `}</Text>
                      )
                    }
                    if (efforts.length === 0 && availability === 'unsupported' && i() === 0) {
                      return (
                        <Text fg={textMutedFg()}>{`  ${effortLabel(segment)} (${t('tui.dialogs.modelSelector.unsupported')})  `}</Text>
                      )
                    }
                    return (
                      <Clickable
                        onClick={() => {
                          setOverrides((prev) => new Map(prev).set(selected.alias, segment))
                        }}
                      >
                        <Text
                          fg={isActive() ? titleFg() : textFg()}
                          attributes={isActive() ? titleAttrs() : undefined}
                        >
                          {isActive() ? `[ ${effortLabel(segment)} ]` : `  ${effortLabel(segment)}  `}
                          {i() < segments.length - 1 ? '  ' : ''}
                        </Text>
                      </Clickable>
                    )
                  }}
                </For>
              </Box>
            )
          })()}
        </Show>
      </Show>
      {/* Bottom border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  )
}