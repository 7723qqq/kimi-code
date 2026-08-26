/** @jsxImportSource @opentui/solid */
/**
 * TUI2 provider manager — CRUD UI for the `/provider` command.
 *
 * Replaces the v1 `ProviderManagerComponent` (a pi-tui `Container`) with an
 * opentui SolidJS view. Lists configured providers grouped by source
 * (Open Platform / custom-registry / standalone) plus a synthetic
 * `[ Add New Platform ]` row. Kimi Code OAuth is hidden (managed through
 * `/login` / `/logout`).
 *
 * Keyboard: ↑/↓ move highlight, ←/→ · PgUp/PgDn page, Enter on the add row
 * → `onAdd`, `D` deletes with an inline `[y/N]` confirmation. The
 * confirmation substate consumes only `y` / `n` / `Esc` while armed.
 *
 * The component is pure-view: every CRUD side effect goes through
 * callbacks. The host performs the harness / config mutations and pushes
 * a fresh snapshot via `setOptions`.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import {
  getOpenPlatformById,
  isOpenPlatformId,
  type CustomRegistrySource,
} from '@moonshot-ai/kimi-code-oauth'

import type { ProviderConfig } from '@moonshot-ai/kimi-code-sdk'

import { DEFAULT_OAUTH_PROVIDER_NAME } from '../../../constant/app'
import { t } from '#/i18n'

import { getCurrentMark, SELECT_POINTER } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import { printableChar } from '../../utils/printable-key'
import { createSearchableList } from '../../utils/searchable-list'

import { Box } from '../common/box'
import { Text } from '../common/text'

const PAGE_SIZE = 8

interface ConfirmState {
  readonly label: string
  readonly providerIds: readonly string[]
}

export interface ProviderManagerProps {
  readonly providers: Record<string, ProviderConfig>
  readonly activeProviderId?: string
  readonly onAdd: () => void
  readonly onDeleteSource: (providerIds: readonly string[]) => void
  readonly onClose: () => void
}

interface SourceRow {
  readonly kind: 'source'
  readonly id: string
  readonly label: string
  readonly providerIds: readonly string[]
  readonly hasActive: boolean
  readonly baseUrl?: string
}

interface AddRow {
  readonly kind: 'add'
  readonly id: '__add__'
  readonly label: string
}

type Row = SourceRow | AddRow

function readCustomRegistrySource(provider: unknown): CustomRegistrySource | undefined {
  if (typeof provider !== 'object' || provider === null) return undefined
  const source = (provider as { readonly source?: unknown }).source
  if (typeof source !== 'object' || source === null) return undefined
  const candidate = source as {
    readonly kind?: unknown
    readonly url?: unknown
    readonly apiKey?: unknown
  }
  if (candidate.kind !== 'apiJson') return undefined
  if (typeof candidate.url !== 'string' || candidate.url.length === 0) return undefined
  if (typeof candidate.apiKey !== 'string') return undefined
  return { kind: 'apiJson', url: candidate.url, apiKey: candidate.apiKey }
}

function buildRows(props: ProviderManagerProps): readonly Row[] {
  const bySource = new Map<string, SourceRow>()
  for (const [providerId, config] of Object.entries(props.providers)) {
    if (providerId === DEFAULT_OAUTH_PROVIDER_NAME) continue
    if (isOpenPlatformId(providerId)) {
      const def = getOpenPlatformById(providerId)
      const row: SourceRow = {
        kind: 'source',
        id: `open:${providerId}`,
        label: def?.name ?? providerId,
        providerIds: [providerId],
        hasActive: providerId === props.activeProviderId,
      }
      bySource.set(row.id, row)
      continue
    }
    const source = readCustomRegistrySource(config)
    if (source !== undefined) {
      const sourceId = `custom:${source.url}:${source.apiKey}`
      const existing = bySource.get(sourceId)
      if (existing !== undefined) {
        bySource.set(sourceId, {
          ...existing,
          providerIds: [...existing.providerIds, providerId],
          hasActive: existing.hasActive || providerId === props.activeProviderId,
        })
      } else {
        bySource.set(sourceId, {
          kind: 'source',
          id: sourceId,
          label: source.url,
          providerIds: [providerId],
          hasActive: providerId === props.activeProviderId,
          baseUrl: source.url,
        })
      }
      continue
    }
    const row: SourceRow = {
      kind: 'source',
      id: providerId,
      label: providerId,
      providerIds: [providerId],
      hasActive: providerId === props.activeProviderId,
    }
    bySource.set(row.id, row)
  }
  const rows: Row[] = [...bySource.values()]
  rows.push({
    kind: 'add',
    id: '__add__',
    label: t('tui.dialogs.providerManager.addNewPlatform'),
  })
  return rows
}

export const ProviderManager: Component<ProviderManagerProps> = (props) => {
  const [confirmState, setConfirmState] = createSignal<ConfirmState | undefined>(undefined)

  const rows = createMemo(() => buildRows(props))
  const list = createSearchableList<Row>({
    items: rows,
    toSearchText: (row) => row.label,
    pageSize: PAGE_SIZE,
    searchable: false,
  })
  const setCursor = list.setCursor
  const page = list.page
  const selectedIndex = list.selectedIndex
  const visible = list.visible
  const selectedRow = (): Row | undefined => list.selected()

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    // Confirmation substate.
    const confirm = confirmState()
    if (confirm !== undefined) {
      if (event.name === 'escape') {
        event.stopPropagation()
        setConfirmState(undefined)
        return
      }
      const ch = printableChar(event.sequence ?? event.name)
      if (ch === 'y' || ch === 'Y') {
        event.stopPropagation()
        props.onDeleteSource(confirm.providerIds)
        setConfirmState(undefined)
        return
      }
      if (ch === 'n' || ch === 'N') {
        event.stopPropagation()
        setConfirmState(undefined)
      }
      return
    }
    if (event.name === 'escape') {
      event.stopPropagation()
      props.onClose()
      return
    }
    if (event.name === 'up') {
      list.handleNavigationKey(event)
      return
    }
    if (event.name === 'down') {
      list.handleNavigationKey(event)
      return
    }
    if (event.name === 'left') {
      setCursor((c) => Math.max(0, c - PAGE_SIZE))
      return
    }
    if (event.name === 'right') {
      setCursor((c) => Math.min(rows().length - 1, c + PAGE_SIZE))
      return
    }
    if (event.name === 'pageup') {
      list.handleNavigationKey(event)
      return
    }
    if (event.name === 'pagedown') {
      list.handleNavigationKey(event)
      return
    }
    if (event.name === 'return' || event.name === 'enter') {
      const row = selectedRow()
      if (row?.kind === 'add') {
        event.stopPropagation()
        props.onAdd()
      }
      return
    }
    const ch = printableChar(event.sequence ?? event.name)
    if (ch === 'd' || ch === 'D') {
      const row = selectedRow()
      if (row?.kind === 'source') {
        event.stopPropagation()
        setConfirmState({
          label: row.label,
          providerIds: row.providerIds,
        })
      }
    }
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
  const accentFg = (): ColorInput => currentTheme.color('accent')
  const successFg = (): ColorInput => currentTheme.color('success')

  return (
    <Box flexDirection="column">
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      <Box>
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.dialogs.providerManager.title')}`}</Text>
      </Box>
      <Box>
        <Text fg={textMutedFg()}>{` ${t('tui.dialogs.providerManager.navHint')}`}</Text>
      </Box>
      <Box>
        <Text>{''}</Text>
      </Box>
      <Show
        when={rows().length > 0}
        fallback={
          <Box>
            <Text fg={textMutedFg()}>{`  ${t('tui.dialogs.providerManager.empty')}`}</Text>
          </Box>
        }
      >
        <For each={visible()}>
          {(row, vi) => {
            const realIndex = (): number => page().start + vi()
            const selected = (): boolean => realIndex() === selectedIndex()
            // Narrow the discriminated union once; <Show> children cannot see
            // the when-condition narrowing, so the rows that need source-only
            // fields read from this variable.
            const sourceRow = row.kind === 'source' ? row : undefined
            return (
              <>
                <Box flexDirection="row">
                  <Text fg={selected() ? titleFg() : textDimFg()}>{`  ${selected() ? SELECT_POINTER : ' '} `}</Text>
                  <Text
                    fg={selected() ? titleFg() : textFg()}
                    attributes={selected() ? titleAttrs() : undefined}
                  >
                    {row.label}
                  </Text>
                  <Show when={sourceRow !== undefined && sourceRow.hasActive}>
                    <Text fg={successFg()}>{`  ${getCurrentMark()}`}</Text>
                  </Show>
                  <Show when={sourceRow !== undefined && sourceRow.baseUrl !== undefined}>
                    <Text fg={textMutedFg()}>{`  ${sourceRow?.baseUrl ?? ''}`}</Text>
                  </Show>
                  <Show when={row.kind === 'add'}>
                    <Text fg={accentFg()}>{`  ${t('tui.dialogs.providerManager.addHint')}`}</Text>
                  </Show>
                </Box>
                <Show when={sourceRow !== undefined && sourceRow.providerIds.length > 1}>
                  <Box>
                    <Text fg={textMutedFg()}>{`    ${sourceRow ? sourceRow.providerIds.join(', ') : ''}`}</Text>
                  </Box>
                </Show>
              </>
            )
          }}
        </For>
      </Show>
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Footer (confirm or hint) */}
      <Show
        when={confirmState() !== undefined}
        fallback={
          <Box>
            <Text fg={textMutedFg()}>{` ${t('tui.dialogs.providerManager.footerHint')}`}</Text>
          </Box>
        }
      >
        <Box>
          <Text fg={accentFg()} attributes={titleAttrs()}>
            {` ${t('tui.dialogs.providerManager.confirmPrompt', { label: confirmState()?.label ?? '' })} `}
          </Text>
          <Text fg={successFg()}>{` [Y/n] `}</Text>
        </Box>
      </Show>
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  )
}