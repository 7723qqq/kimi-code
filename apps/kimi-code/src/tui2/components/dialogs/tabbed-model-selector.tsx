/** @jsxImportSource @opentui/solid */
/**
 * TUI2 tabbed model selector — splits the model list into per-provider tabs
 * (one `ModelSelector` instance per tab).
 *
 * Replaces the v1 `TabbedModelSelectorComponent` (a pi-tui `Container` that
 * owned `ModelSelectorComponent` instances per tab) with an opentui SolidJS
 * view. Tab cycling (`Tab` / `Shift+Tab`) and the keyboard contract are
 * forwarded to the active inner `ModelSelector`. The host does not need to
 * wire anything besides `Esc` and `Tab` at the keymap layer; the inner
 * selector consumes everything else through its own `useKeyboard`.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk'

import { t } from '#/i18n'

import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'

import {
  ModelSelector,
  providerDisplayName,
  type ModelSelection,
} from './model-selector'

const ALL_TAB_ID = 'all'

interface ModelTab {
  readonly id: string
  readonly label: string
  readonly models: Record<string, ModelAlias>
}

export interface TabbedModelSelectorProps {
  readonly models: Record<string, ModelAlias>
  readonly currentValue: string
  readonly selectedValue?: string
  readonly currentThinkingEffort: string
  readonly title?: string
  readonly initialTabId?: string
  readonly warning?: string
  readonly thinkingControl?: boolean
  readonly onSelect: (selection: ModelSelection) => void
  readonly onSessionOnlySelect?: (selection: ModelSelection) => void
  readonly onCancel: () => void
}

function buildTabs(props: TabbedModelSelectorProps): readonly ModelTab[] {
  const entries = Object.entries(props.models)
  const providerIds: string[] = []
  const seen = new Set<string>()
  for (const [, model] of entries) {
    if (!seen.has(model.provider)) {
      seen.add(model.provider)
      providerIds.push(model.provider)
    }
  }
  const tabs: ModelTab[] = [
    { id: ALL_TAB_ID, label: t('tui.dialogs.tabbedModelSelector.allTab'), models: props.models },
  ]
  for (const providerId of providerIds) {
    const subset: Record<string, ModelAlias> = {}
    for (const [alias, model] of entries) {
      if (model.provider === providerId) subset[alias] = model
    }
    tabs.push({
      id: providerId,
      label: providerDisplayName(providerId),
      models: subset,
    })
  }
  return tabs
}

export const TabbedModelSelector: Component<TabbedModelSelectorProps> = (props) => {
  const tabs = createMemo(() => buildTabs(props))
  const [activeIndex, setActiveIndex] = createSignal(
    Math.max(
      props.initialTabId !== undefined
        ? tabs().findIndex((tab) => tab.id === props.initialTabId)
        : -1,
      0,
    ),
  )

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    if (tabs().length > 1 && event.name === 'tab') {
      event.stopPropagation()
      setActiveIndex((i) => (i + 1) % tabs().length)
      return
    }
    if (tabs().length > 1 && event.name === 'backtab') {
      event.stopPropagation()
      setActiveIndex((i) => (i - 1 + tabs().length) % tabs().length)
      return
    }
    // Other keys (↑/↓/Enter/Esc/←/→/typing) are consumed by the inner
    // ModelSelector's own `useKeyboard`. No-op for anything else here.
  }

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const borderFg = (): ColorInput => currentTheme.color('primary')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const textFg = (): ColorInput => currentTheme.color('text')

  return (
    <Box flexDirection="column">
      {/* Tab strip */}
      <Show when={tabs().length > 1}>
        <Box>
          <Text fg={borderFg()}>─</Text>
        </Box>
        <Box>
          <Text fg={titleFg()}>{` ${t('tui.dialogs.tabbedModelSelector.title')}`}</Text>
        </Box>
        <Box flexDirection="row">
          <For each={tabs()}>
            {(tab, i) => {
              const active = (): boolean => i() === activeIndex()
              return (
                <Show
                  when={active()}
                  fallback={
                    <Text fg={currentTheme.color('textMuted')}>{` ${tab.label} `}</Text>
                  }
                >
                  <Text fg={textFg()}>{` ${tab.label} `}</Text>
                </Show>
              )
            }}
          </For>
        </Box>
        <Box>
          <Text>{''}</Text>
        </Box>
      </Show>
      {/* Active inner selector */}
      <Show when={tabs()[activeIndex()] !== undefined}>
        {(() => {
          const active = tabs()[activeIndex()]
          if (active === undefined) return null
          const candidate = props.selectedValue ?? props.currentValue
          const selectedValue =
            active.models[candidate] !== undefined ? candidate : undefined
          return (
            <ModelSelector
              models={active.models}
              currentValue={props.currentValue}
              selectedValue={selectedValue}
              currentThinkingEffort={props.currentThinkingEffort as never}
              title={props.title}
              warning={props.warning}
              thinkingControl={props.thinkingControl}
              providerSwitchHint
              searchable
              onSelect={props.onSelect}
              onSessionOnlySelect={props.onSessionOnlySelect}
              onCancel={props.onCancel}
            />
          )
        })()}
      </Show>
    </Box>
  )
}