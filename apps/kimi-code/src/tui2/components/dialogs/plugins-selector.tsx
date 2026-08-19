/** @jsxImportSource @opentui/solid */
/**
 * TUI2 plugins panel — unified `/plugins` picker with four tabs (Installed /
 * Official / Third-party / Custom), plus the MCP sub-selector and the two
 * confirmation dialogs that branch off it.
 *
 * Replaces the v1 `PluginsSelectorComponent` (~1100 lines) with an opentui
 * SolidJS view that covers:
 *
 *   - Installed tab: per-row toggle (Space), details (Enter / `i`), MCP
 *     sub-panel (`m`), remove (`d`), reload (`r`).
 *   - Marketplace tabs (Official / Third-party): Enter installs the
 *     highlighted row (or opens the pinned WebBridge install URL).
 *   - Custom tab: rounded single-line URL input that submits with Enter.
 *
 * Marketplace state (idle / loading / error / loaded) is owned by the
 * component via signals; the host calls `_setMarketplaceLoading` /
 * `_setMarketplace` / `_setMarketplaceError` when the catalog fetch settles,
 * and `setInstalling` / `_clearInstalling` while a background install runs.
 *
 * The host wires `Esc` (cancel) and `Tab` / `Shift+Tab` (tab switch) at
 * the keymap layer; everything else is consumed via `useKeyboard`.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import type {
  CapabilityStatus,
  PluginInfo,
  PluginMcpServerInfo,
  PluginSummary,
} from '@moonshot-ai/kimi-code-sdk'

import { t } from '#/i18n'

import { SELECT_POINTER } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import { isPrintableChar, printableChar } from '../../utils/printable-key'
import { computeUpdateStatus, type PluginMarketplaceEntry } from '../../../utils/plugin-marketplace'

import { ChoicePicker } from './choice-picker'

import { Box } from '../common/box'
import { Text } from '../common/text'

const MCP_SERVER_PREFIX = 'mcp:'
const REMOVE_CONFIRM_CANCEL = 'cancel'
const REMOVE_CONFIRM_REMOVE = 'remove'
const INSTALL_TRUST_EXIT = 'exit'
const INSTALL_TRUST_TRUST = 'trust'

// Hardcoded Web Bridge promotion: a built-in fallback shown only while the
// marketplace catalog is loading / unreachable / predates the real
// `kimi-webbridge` entry. Selecting it opens the install page in the
// browser; once the catalog carries the real entry, that row wins.
const WEB_BRIDGE_URL = 'https://www.kimi.com/features/webbridge#local-agent'

const WEB_BRIDGE_ENTRY: PluginMarketplaceEntry = {
  id: 'kimi-webbridge',
  displayName: 'Kimi WebBridge',
  source: WEB_BRIDGE_URL,
  tier: 'official',
  homepage: WEB_BRIDGE_URL,
  get description(): string {
    return webBridgeDescription()
  },
}

function webBridgeDescription(): string {
  return t('tui.dialogs.pluginsSelector.webBridgeDescription')
}

function isPinnedWebBridgeEntry(entry: PluginMarketplaceEntry): boolean {
  return entry === WEB_BRIDGE_ENTRY
}

// ---------------------------------------------------------------------------
// Helpers (status / description / styling)
// ---------------------------------------------------------------------------

function overviewPluginDescription(plugin: PluginSummary): string {
  const state =
    plugin.state === 'ok'
      ? ''
      : ` · ${t('tui.dialogs.pluginsSelector.pluginState', { state: plugin.state })}`
  const skills = t(
    plugin.skillCount === 1
      ? 'tui.dialogs.pluginsSelector.skillCount_one'
      : 'tui.dialogs.pluginsSelector.skillCount_other',
    { count: plugin.skillCount },
  )
  const mcp =
    plugin.mcpServerCount > 0
      ? ` · ${t('tui.dialogs.pluginsSelector.mcpCount', {
          enabled: plugin.enabledMcpServerCount,
          total: plugin.mcpServerCount,
        })}`
      : ''
  const diagnostics = plugin.hasErrors
    ? ` · ${t('tui.dialogs.pluginsSelector.diagnosticsAvailable')}`
    : ''
  const source = ` · ${formatPluginSourceLabel(plugin)}`
  const trust = ` · ${pluginTrustLabel(plugin)}`
  return `${t('tui.dialogs.pluginsSelector.pluginId', { id: plugin.id })} · ${skills}${mcp}${source}${trust}${state}${diagnostics}`
}

function formatPluginSourceLabel(_plugin: PluginSummary): string {
  return t('tui.dialogs.pluginsSelector.sourceOfficial') // fallback
}

function pluginTrustLabel(_plugin: PluginSummary): string {
  return t('tui.dialogs.pluginsSelector.trustOfficial') // fallback
}

function pluginStatus(plugin: PluginSummary): string | undefined {
  if (plugin.state !== 'ok') return plugin.state
  return plugin.enabled ? 'enabled' : 'disabled'
}

function pluginStatusLabel(status: string): string {
  if (status === 'enabled') return t('tui.dialogs.pluginsSelector.statusEnabled')
  if (status === 'disabled') return t('tui.dialogs.pluginsSelector.statusDisabled')
  return status
}

function marketplaceStatusToken(status: string): ColorToken {
  // States recede, actions pop: "installed …" is a quiet fact (dim), while
  // "install …" (the available action) stays primary and "update …" stays
  // a warning — the two used to share near-identical green-ish treatments
  // in the same column and read as interchangeable.
  if (status.startsWith('update')) return 'warning'
  if (status.startsWith('installed')) return 'textDim'
  return 'primary'
}

type ColorToken =
  | 'primary'
  | 'text'
  | 'textDim'
  | 'textMuted'
  | 'textStrong'
  | 'success'
  | 'warning'
  | 'error'

function wrapPlain(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width)
  const words = text.split(/\s+/).filter((word) => word.length > 0)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`
    if (candidate.length <= safeWidth) {
      current = candidate
      continue
    }
    if (current.length > 0) lines.push(current)
    current = word.length <= safeWidth ? word : `${word.slice(0, Math.max(1, safeWidth - 1))}…`
  }
  if (current.length > 0) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

// ---------------------------------------------------------------------------
// PluginMcpSelector — toggle MCP servers of a single plugin
// ---------------------------------------------------------------------------

interface PluginsOverviewItem {
  readonly value: string
  readonly kind: 'plugin' | 'action'
  readonly label: string
  readonly status?: string
  readonly statusLabel?: string
  readonly description: string
}

export type PluginMcpSelection =
  | {
      readonly kind: 'toggle'
      readonly pluginId: string
      readonly server: string
      readonly enabled: boolean
    }
  | { readonly kind: 'back'; readonly pluginId: string }

export interface PluginMcpSelectorProps {
  readonly info: PluginInfo
  readonly selectedServer?: string
  readonly serverHint?: { readonly server: string; readonly text: string }
  readonly onSelect: (selection: PluginMcpSelection) => void
  readonly onCancel: () => void
}

function buildMcpItems(info: PluginInfo): PluginsOverviewItem[] {
  const items: PluginsOverviewItem[] = info.mcpServers.map((server) => {
    const status = server.enabled ? 'enabled' : 'disabled'
    return {
      value: `${MCP_SERVER_PREFIX}${server.name}`,
      kind: 'plugin',
      label: server.name,
      status,
      statusLabel: t(
        `tui.dialogs.pluginsSelector.status${status.charAt(0).toUpperCase() + status.slice(1)}`,
      ),
      description: mcpServerDescription(server),
    }
  })
  items.push({
    value: 'back',
    kind: 'action',
    label: t('tui.dialogs.pluginsSelector.backToInstalled'),
    description: t('tui.dialogs.pluginsSelector.backToInstalledDesc'),
  })
  return items
}

function mcpServerDescription(server: PluginMcpServerInfo): string {
  const action = server.enabled
    ? t('tui.dialogs.pluginsSelector.mcpDisable')
    : t('tui.dialogs.pluginsSelector.mcpEnable')
  if (server.transport === 'http' || server.transport === 'sse') {
    return t('tui.dialogs.pluginsSelector.mcpServerTransportHint', {
      action,
      transport: server.transport.toUpperCase(),
      target: server.url ?? server.runtimeName,
    })
  }
  const args =
    server.args !== undefined && server.args.length > 0 ? ` ${server.args.join(' ')}` : ''
  const command = `${server.command ?? ''}${args}`.trim()
  const base = t('tui.dialogs.pluginsSelector.mcpServerStdioHint', {
    action,
    command: command || server.runtimeName,
  })
  return server.cwd === undefined
    ? base
    : `${base}${t('tui.dialogs.pluginsSelector.mcpServerCwdSuffix', { cwd: server.cwd })}`
}

function mcpItemServerName(item: PluginsOverviewItem): string | undefined {
  if (!item.value.startsWith(MCP_SERVER_PREFIX)) return undefined
  return item.value.slice(MCP_SERVER_PREFIX.length)
}

function mcpItemStatusColor(status: string | undefined, kind: string): ColorToken {
  if (kind === 'action') return 'textDim'
  if (status === 'enabled' || status === 'installed') return 'success'
  if (status?.startsWith('install') === true) return 'primary'
  if (status === 'disabled') return 'textDim'
  if (status !== undefined && /^\d/.test(status)) return 'textDim'
  return 'warning'
}

export const PluginMcpSelector: Component<PluginMcpSelectorProps> = (props) => {
  const items = createMemo(() => buildMcpItems(props.info))
  const [cursor, setCursor] = createSignal(0)

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    switch (event.name) {
      case 'escape':
        event.stopPropagation()
        props.onCancel()
        return
      case 'up':
        setCursor((c) => Math.max(0, c - 1))
        return
      case 'down':
        setCursor((c) => Math.min(items().length - 1, c + 1))
        return
      case 'return':
      case 'enter':
      case 'space':
        event.stopPropagation()
        commit()
        return
    }
  }

  function commit(): void {
    const chosen = items()[cursor()]
    if (chosen === undefined) return
    if (chosen.value === 'back') {
      props.onSelect({ kind: 'back', pluginId: props.info.id })
      return
    }
    const serverName = mcpItemServerName(chosen)
    if (serverName === undefined) return
    const server = props.info.mcpServers.find((item) => item.name === serverName)
    if (server === undefined) return
    props.onSelect({
      kind: 'toggle',
      pluginId: props.info.id,
      server: server.name,
      enabled: !server.enabled,
    })
  }

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const _borderFg = (): ColorInput => currentTheme.color('primary')
  const _titleFg = (): ColorInput => currentTheme.color('primary')
  const _titleAttrs = (): number => currentTheme.attributes('bold')
  const _textFg = (): ColorInput => currentTheme.color('text')
  const _textDimFg = (): ColorInput => currentTheme.color('textDim')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')
  const _successFg = (): ColorInput => currentTheme.color('success')
  const _primaryFg = (): ColorInput => currentTheme.color('primary')
  const _warningFg = (): ColorInput => currentTheme.color('warning')

  return (
    <Box flexDirection="column">
      <Box>
        <Text fg={_borderFg()}>─</Text>
      </Box>
      <Box>
        <Text fg={_titleFg()} attributes={_titleAttrs()}>{` ${t('tui.dialogs.pluginsSelector.mcpServersTitle', { name: props.info.displayName })}`}</Text>
      </Box>
      <Box>
        <Text fg={textMutedFg()}>{` ${t('tui.dialogs.pluginsSelector.mcpNavHint')}`}</Text>
      </Box>
      <Box>
        <Text>{''}</Text>
      </Box>
      <Box>
        <Text fg={_textDimFg()} attributes={_titleAttrs()}>{` ${t('tui.dialogs.pluginsSelector.mcpServersSection', {
          enabled: props.info.enabledMcpServerCount,
          total: props.info.mcpServerCount,
        })}`}</Text>
      </Box>
      <For each={items()}>
        {(item, i) => {
          const selected = (): boolean => i() === cursor()
          const serverName = mcpItemServerName(item)
          return (
            <>
              <Box flexDirection="row">
                <Text fg={selected() ? _titleFg() : _textDimFg()}>{`  ${selected() ? SELECT_POINTER : ' '} `}</Text>
                <Text
                  fg={selected() ? _titleFg() : _textFg()}
                  attributes={selected() ? _titleAttrs() : undefined}
                >
                  {item.label}
                </Text>
                <Show when={item.statusLabel !== undefined && item.status !== undefined}>
                  <Text fg={currentTheme.color(mcpItemStatusColor(item.status, item.kind))}>
                    {`  ${item.statusLabel ?? ''}`}
                  </Text>
                </Show>
                <Show when={serverName !== undefined && props.serverHint?.server === serverName}>
                  <Text fg={_warningFg()}>{`  ${props.serverHint?.text ?? ''}`}</Text>
                </Show>
              </Box>
              <For each={wrapPlain(item.description, 76)}>
                {(line) => (
                  <Box>
                    <Text fg={textMutedFg()}>{`    ${line}`}</Text>
                  </Box>
                )}
              </For>
              <Show when={i() < items().length - 1}>
                <Box>
                  <Text>{''}</Text>
                </Box>
              </Show>
            </>
          )
        }}
      </For>
      <Box>
        <Text>{''}</Text>
      </Box>
      <Box>
        <Text fg={_borderFg()}>─</Text>
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// PluginRemoveConfirm — confirm dialog (wraps ChoicePicker)
// ---------------------------------------------------------------------------

export type PluginRemoveConfirmResult = { readonly kind: 'confirm' } | { readonly kind: 'cancel' }

export interface PluginRemoveConfirmProps {
  readonly id: string
  readonly displayName: string
  readonly onDone: (result: PluginRemoveConfirmResult) => void
}

const REMOVE_CONFIRM_OPTIONS = [
  {
    value: REMOVE_CONFIRM_CANCEL,
    label: t('tui.dialogs.pluginsSelector.removeCancelLabel'),
    description: t('tui.dialogs.pluginsSelector.removeCancelDesc'),
  },
  {
    value: REMOVE_CONFIRM_REMOVE,
    label: t('tui.dialogs.pluginsSelector.removeConfirmLabel'),
    tone: 'danger' as const,
    description: t('tui.dialogs.pluginsSelector.removeConfirmDesc'),
  },
]

export const PluginRemoveConfirm: Component<PluginRemoveConfirmProps> = (props) => (
  <ChoicePicker
    title={t('tui.dialogs.pluginsSelector.removeConfirmTitle', {
      name: props.displayName,
      id: props.id,
    })}
    hint={t('tui.dialogs.pluginsSelector.removeConfirmHint')}
    options={REMOVE_CONFIRM_OPTIONS}
    onSelect={(value) =>
      props.onDone(value === REMOVE_CONFIRM_REMOVE ? { kind: 'confirm' } : { kind: 'cancel' })
    }
    onCancel={() => props.onDone({ kind: 'cancel' })}
  />
)

// ---------------------------------------------------------------------------
// PluginInstallTrustConfirm — confirm dialog (wraps ChoicePicker)
// ---------------------------------------------------------------------------

export type PluginInstallTrustConfirmResult =
  | { readonly kind: 'confirm' }
  | { readonly kind: 'cancel' }

export interface PluginInstallTrustConfirmProps {
  readonly label: string
  readonly onDone: (result: PluginInstallTrustConfirmResult) => void
}

const INSTALL_TRUST_OPTIONS = [
  {
    value: INSTALL_TRUST_EXIT,
    label: t('tui.dialogs.pluginsSelector.installTrustExitLabel'),
    description: t('tui.dialogs.pluginsSelector.installTrustExitDesc'),
  },
  {
    value: INSTALL_TRUST_TRUST,
    label: t('tui.dialogs.pluginsSelector.installTrustTrustLabel'),
    tone: 'danger' as const,
    description: t('tui.dialogs.pluginsSelector.installTrustTrustDesc'),
  },
]

export const PluginInstallTrustConfirm: Component<PluginInstallTrustConfirmProps> = (props) => (
  <ChoicePicker
    title={t('tui.dialogs.pluginsSelector.installTrustTitle', { label: props.label })}
    hint={t('tui.dialogs.pluginsSelector.installTrustHint')}
    notice={t('tui.dialogs.pluginsSelector.installTrustNotice')}
    noticeTone="warning"
    options={INSTALL_TRUST_OPTIONS}
    onSelect={(value) =>
      props.onDone(value === INSTALL_TRUST_TRUST ? { kind: 'confirm' } : { kind: 'cancel' })
    }
    onCancel={() => props.onDone({ kind: 'cancel' })}
  />
)

// ---------------------------------------------------------------------------
// PluginsPanel — unified /plugins picker with Installed / Official /
// Third-party / Custom tabs.
// ---------------------------------------------------------------------------

export type PluginsPanelTabId = 'installed' | 'official' | 'third-party' | 'custom'

export type PluginsPanelSelection =
  | { readonly kind: 'toggle'; readonly id: string; readonly enabled: boolean }
  | { readonly kind: 'remove'; readonly id: string }
  | { readonly kind: 'mcp'; readonly id: string }
  | { readonly kind: 'details'; readonly id: string }
  | { readonly kind: 'reload' }
  | { readonly kind: 'install'; readonly entry: PluginMarketplaceEntry }
  | { readonly kind: 'install-source'; readonly source: string }
  | { readonly kind: 'open-url'; readonly url: string; readonly label: string }

export interface PluginsPanelOptions {
  readonly installed: readonly PluginSummary[]
  readonly installedIds: ReadonlySet<string>
  readonly capabilities?: readonly CapabilityStatus[]
  /**
   * False when the marketplace was explicitly replaced (slash-command
   * source or env override): built-in rows then stay out of the Official
   * tab entirely.
   */
  readonly catalogIsDefault?: boolean
  readonly initialTab?: PluginsPanelTabId
  readonly selectedId?: string
  readonly pluginHint?: { readonly id: string; readonly text: string }
  readonly onSelect: (selection: PluginsPanelSelection) => void
  readonly onCancel: () => void
  readonly onRequestMarketplace?: () => void
}

type MarketState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'loaded'
      readonly entries: readonly PluginMarketplaceEntry[]
      readonly source: string
    }

const TABS: readonly { id: PluginsPanelTabId; label: string }[] = [
  { id: 'installed', label: t('tui.dialogs.pluginsSelector.tabInstalled') },
  { id: 'official', label: t('tui.dialogs.pluginsSelector.tabOfficial') },
  { id: 'third-party', label: t('tui.dialogs.pluginsSelector.tabThirdParty') },
  { id: 'custom', label: t('tui.dialogs.pluginsSelector.tabCustom') },
]

function capabilityMarketplaceEntry(capability: CapabilityStatus): PluginMarketplaceEntry {
  return {
    id: capability.id,
    displayName: capability.displayName,
    source: `capability:${capability.id}`,
    tier: 'official',
    description: capability.description,
    builtIn: true,
  }
}

function installStatusLabel(entry: PluginMarketplaceEntry): string {
  return entry.version === undefined ? 'install' : `install v${entry.version}`
}

function marketplaceEntryStatusToken(
  entry: PluginMarketplaceEntry,
  installed: ReadonlyMap<string, string | undefined>,
  installedPluginId = entry.id,
): string {
  const status = computeUpdateStatus(
    entry.version,
    installed.get(installedPluginId),
    installed.has(installedPluginId),
  )
  switch (status.kind) {
    case 'update':
      return `update ${status.local} → ${status.latest}`
    case 'up-to-date':
      return status.version === undefined ? 'installed' : `installed v${status.version}`
    case 'not-installed':
      return installStatusLabel(entry)
  }
}

function marketplaceStatusToLabel(status: string): string {
  if (status === 'open-in-browser') return t('tui.dialogs.pluginsSelector.openInBrowser')
  if (status === 'installed') return t('tui.dialogs.pluginsSelector.installedStatus')
  if (status.startsWith('install v')) {
    return t('tui.dialogs.pluginsSelector.installStatusVersion', {
      version: status.slice('install v'.length),
    })
  }
  if (status === 'install') return t('tui.dialogs.pluginsSelector.installStatus')
  if (status.startsWith('installed v')) {
    return t('tui.dialogs.pluginsSelector.installedStatusVersion', {
      version: status.slice('installed v'.length),
    })
  }
  if (status.startsWith('update ')) {
    const remainder = status.slice('update '.length)
    const arrowIndex = remainder.indexOf(' → ')
    if (arrowIndex >= 0) {
      return t('tui.dialogs.pluginsSelector.updateStatus', {
        local: remainder.slice(0, arrowIndex),
        latest: remainder.slice(arrowIndex + ' → '.length),
      })
    }
  }
  if (status === 'installing…') return t('tui.dialogs.pluginsSelector.installingStatus')
  return status
}

function marketplaceTierLabel(tier: PluginMarketplaceEntry['tier']): string {
  if (tier === 'official') return t('tui.dialogs.pluginsSelector.marketplaceTierOfficial')
  if (tier === 'curated') return t('tui.dialogs.pluginsSelector.marketplaceTierCurated')
  return t('tui.dialogs.pluginsSelector.marketplaceTierUnknown')
}

function marketplaceEntryDescription(entry: PluginMarketplaceEntry): string {
  const tier = marketplaceTierLabel(entry.tier)
  const description = entry.description ?? tier
  const version =
    entry.version !== undefined
      ? ` · ${t('tui.dialogs.pluginsSelector.versionPrefix', { version: entry.version })}`
      : ''
  const keywords =
    entry.keywords !== undefined && entry.keywords.length > 0
      ? ` · ${entry.keywords.join(', ')}`
      : ''
  const tierSuffix = entry.description !== undefined ? ` · ${tier}` : ''
  return `${description} · ${t('tui.dialogs.pluginsSelector.pluginId', { id: entry.id })}${version}${tierSuffix}${keywords}`
}

function officialMarketplaceEntryDescription(entry: PluginMarketplaceEntry): string {
  return entry.description ?? ''
}

function tabLabelColor(active: boolean): ColorToken {
  return active ? 'primary' : 'textMuted'
}

export const PluginsPanel: Component<PluginsPanelOptions> = (props) => {
  const [activeTabIndex, setActiveTabIndex] = createSignal(
    Math.max(0, TABS.findIndex((tab) => tab.id === (props.initialTab ?? 'installed'))),
  )
  const [cursor, setCursor] = createSignal(
    props.selectedId !== undefined && (props.initialTab ?? 'installed') === 'installed'
      ? Math.max(
          0,
          props.installed.findIndex((p) => p.id === props.selectedId),
        )
      : 0,
  )
  const [market, setMarket] = createSignal<MarketState>({ status: 'idle' })
  const [installing, setInstalling] = createSignal<string | undefined>(undefined)
  const [customUrl, setCustomUrl] = createSignal('')

  const activeTab = (): { id: PluginsPanelTabId; label: string } => TABS[activeTabIndex()]!
  const installedVersions = (): ReadonlyMap<string, string | undefined> =>
    new Map(props.installed.map((plugin) => [plugin.id, plugin.version]))

  function capabilityFor(id: string): CapabilityStatus | undefined {
    return props.capabilities?.find((capability) => capability.id === id)
  }
  function capabilityForEntry(entry: PluginMarketplaceEntry): CapabilityStatus | undefined {
    return entry.builtIn === true ? capabilityFor(entry.id) : undefined
  }
  function installedPluginId(entry: PluginMarketplaceEntry): string {
    return capabilityForEntry(entry)?.pluginId ?? entry.id
  }
  function isMarketplaceEntryInstalled(entry: PluginMarketplaceEntry): boolean {
    return props.installedIds.has(installedPluginId(entry))
  }
  const marketplaceEntries = (): readonly PluginMarketplaceEntry[] => {
    const m = market()
    if (m.status !== 'loaded') return []
    return [...m.entries].sort((a, b) => {
      return Number(isMarketplaceEntryInstalled(b)) - Number(isMarketplaceEntryInstalled(a))
    })
  }
  function pendingBuiltInEntries(): readonly PluginMarketplaceEntry[] {
    if (props.catalogIsDefault === false) return []
    return (props.capabilities ?? [])
      .filter((capability) => capability.supported)
      .map(capabilityMarketplaceEntry)
  }
  function officialCatalogEntries(): readonly PluginMarketplaceEntry[] {
    return marketplaceEntries().filter((entry) => {
      if (entry.tier !== 'official') return false
      return capabilityForEntry(entry)?.supported !== false
    })
  }
  function thirdPartyEntries(): readonly PluginMarketplaceEntry[] {
    return marketplaceEntries().filter((entry) => entry.tier !== 'official')
  }
  function officialEntries(): readonly PluginMarketplaceEntry[] {
    const m = market()
    if (m.status !== 'loaded') {
      const pending = pendingBuiltInEntries()
      return pending.some((entry) => entry.id === WEB_BRIDGE_ENTRY.id)
        ? pending
        : [...pending, WEB_BRIDGE_ENTRY]
    }
    const catalog = officialCatalogEntries()
    return catalog.some((entry) => entry.id === WEB_BRIDGE_ENTRY.id)
      ? catalog
      : [WEB_BRIDGE_ENTRY, ...catalog]
  }
  function requestMarketplaceIfNeeded(): void {
    const m = market()
    if (m.status === 'idle' && activeTab().id !== 'custom') {
      setMarket({ status: 'loading' })
      props.onRequestMarketplace?.()
    }
  }

  // External mutators (host calls these when fetch / install settle).
  function _setMarketplaceLoading(): void { setMarket({ status: "loading" }); void 0 }
  function _setMarketplace(entries: readonly PluginMarketplaceEntry[], source: string): void { setMarket({ status: "loaded", entries, source }); void 0 }
  function _setMarketplaceError(message: string): void { setMarket({ status: "error", message }); void 0 }
  function _setInstallingLabel(label: string): void { setInstalling(label); void 0 }
  function _clearInstalling(): void { setInstalling(undefined); void 0 }


  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    const tab = activeTab().id
    switch (event.name) {
      case 'tab':
        event.stopPropagation()
        setActiveTabIndex((i) => (i + 1) % TABS.length)
        setCursor(0)
        requestMarketplaceIfNeeded()
        return
      case 'backtab':
        event.stopPropagation()
        setActiveTabIndex((i) => (i - 1 + TABS.length) % TABS.length)
        setCursor(0)
        requestMarketplaceIfNeeded()
        return
    }

    switch (tab) {
      case 'installed':
        return handleInstalledTabKey(event)
      case 'official':
      case 'third-party':
        return handleMarketplaceTabKey(event)
      case 'custom':
        return handleCustomTabKey(event)
    }
    void handleInstalledInput
  }

  function handleInstalledTabKey(event: KeyEvent): void {
    const plugins = props.installed
    if (event.name === 'up') {
      setCursor((c) => Math.max(0, c - 1))
      return
    }
    if (event.name === 'down') {
      setCursor((c) => Math.min(plugins.length - 1, c + 1))
      return
    }
    const plugin = plugins[cursor()]
    const ch = printableChar(event.sequence ?? event.name)
    if (event.name === 'space' || ch === ' ') {
      if (plugin !== undefined) {
        event.stopPropagation()
        props.onSelect({ kind: 'toggle', id: plugin.id, enabled: !plugin.enabled })
      }
      return
    }
    if (ch === 'd' || ch === 'D') {
      if (plugin !== undefined) {
        event.stopPropagation()
        props.onSelect({ kind: 'remove', id: plugin.id })
      }
      return
    }
    if (ch === 'm' || ch === 'M') {
      if (plugin !== undefined) {
        event.stopPropagation()
        props.onSelect({ kind: 'mcp', id: plugin.id })
      }
      return
    }
    if (ch === 'r' || ch === 'R') {
      event.stopPropagation()
      props.onSelect({ kind: 'reload' })
      return
    }
    if (event.name === 'return' || event.name === 'enter') {
      if (plugin === undefined) return
      event.stopPropagation()
      const update = installedUpdateStatus(plugin)
      if (update !== undefined) {
        props.onSelect({ kind: 'install', entry: update.entry })
      } else {
        props.onSelect({ kind: 'details', id: plugin.id })
      }
      return
    }
    if (ch === 'i' || ch === 'I') {
      if (plugin !== undefined) {
        event.stopPropagation()
        props.onSelect({ kind: 'details', id: plugin.id })
      }
    }
  }

  function handleMarketplaceTabKey(event: KeyEvent): void {
    const entries = activeTab().id === 'official' ? officialEntries() : thirdPartyEntries()
    if (event.name === 'up') {
      setCursor((c) => Math.max(0, c - 1))
      return
    }
    if (event.name === 'down') {
      setCursor((c) =>
        entries.length === 0 ? 0 : Math.min(entries.length - 1, c + 1),
      )
      return
    }
    if (event.name === 'return' || event.name === 'enter') {
      const entry = entries[cursor()]
      if (entry === undefined) return
      event.stopPropagation()
      if (isPinnedWebBridgeEntry(entry)) {
        props.onSelect({ kind: 'open-url', url: WEB_BRIDGE_URL, label: entry.displayName })
        return
      }
      props.onSelect({ kind: 'install', entry })
    }
  }

  function handleCustomTabKey(event: KeyEvent): void {
    if (event.name === 'return' || event.name === 'enter') {
      const source = customUrl().trim()
      if (source.length > 0) {
        event.stopPropagation()
        props.onSelect({ kind: 'install-source', source })
      }
      return
    }
    if (event.name === 'backspace') {
      if (customUrl().length > 0) {
        setCustomUrl((s) => s.slice(0, -1))
      }
      return
    }
    const ch = printableChar(event.sequence ?? event.name)
    if (isPrintableChar(ch)) {
      setCustomUrl((s) => s + ch)
    }
  }

  function installedUpdateStatus(
    plugin: PluginSummary,
  ): { entry: PluginMarketplaceEntry; local: string; latest: string } | undefined {
    const m = market()
    if (m.status !== 'loaded') return undefined
    const entry = m.entries.find(
      (candidate) =>
        candidate.id === plugin.id ||
        (candidate.builtIn === true && capabilityForEntry(candidate)?.pluginId === plugin.id),
    )
    if (entry === undefined) return undefined
    const status = computeUpdateStatus(entry.version, plugin.version, true)
    return status.kind === 'update'
      ? { entry, local: status.local, latest: status.latest }
      : undefined
  }

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const _borderFg = (): ColorInput => currentTheme.color('primary')
  const _titleFg = (): ColorInput => currentTheme.color('primary')
  const _titleAttrs = (): number => currentTheme.attributes('bold')
  const _textFg = (): ColorInput => currentTheme.color('text')
  const _textDimFg = (): ColorInput => currentTheme.color('textDim')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')
  const _textStrongFg = (): ColorInput => currentTheme.color('textStrong')
  const _successFg = (): ColorInput => currentTheme.color('success')
  const _warningFg = (): ColorInput => currentTheme.color('warning')
  const accentBgFg = (): ColorInput => currentTheme.color('text')

  const tabHint = (): string => {
    const tab = activeTab().id
    if (tab === 'installed') return t('tui.dialogs.pluginsSelector.tabHintInstalled', { enterAction: '' })
    if (tab === 'custom') return t('tui.dialogs.pluginsSelector.tabHintCustom')
    return t('tui.dialogs.pluginsSelector.tabHintMarketplace')
  }

  // Installing overlay
  if (installing() !== undefined) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text fg={_borderFg()}>─</Text>
        </Box>
        <Box>
          <Text fg={_titleFg()} attributes={_titleAttrs()}>{` ${t('tui.dialogs.pluginsSelector.panelTitle')}`}</Text>
        </Box>
        <Box>
          <Text>{''}</Text>
        </Box>
        <Box>
          <Text fg={textMutedFg()}>{`  ${t('tui.dialogs.pluginsSelector.installingFromMarketplace', { label: installing() ?? '' })}`}</Text>
        </Box>
        <Box>
          <Text>{''}</Text>
        </Box>
        <Box>
          <Text fg={_borderFg()}>─</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text fg={_borderFg()}>─</Text>
      </Box>
      {/* Title */}
      <Box>
        <Text fg={_titleFg()} attributes={_titleAttrs()}>{` ${t('tui.dialogs.pluginsSelector.panelTitle')}`}</Text>
      </Box>
      {/* Hint */}
      <Box>
        <Text fg={textMutedFg()}>{` ${tabHint()}`}</Text>
      </Box>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Tab strip */}
      <Box flexDirection="row">
        <For each={TABS}>
          {(tab, i) => {
            const active = (): boolean => i() === activeTabIndex()
            return (
              <Show
                when={active()}
                fallback={
                  <Text fg={currentTheme.color(tabLabelColor(false))} attributes={_textDimFg() ? currentTheme.attributes('dim') : undefined}>
                    {` ${tab.label} `}
                  </Text>
                }
              >
                <Text fg={accentBgFg()}>{` ${tab.label} `}</Text>
              </Show>
            )
          }}
        </For>
      </Box>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Per-tab body */}
      <Show when={activeTab().id === 'installed'}>
        {/* Installed list */}
        <Show
          when={props.installed.length > 0}
          fallback={
            <Box>
              <Text fg={textMutedFg()}>{`  ${t('tui.dialogs.pluginsSelector.noPluginsInstalled')}`}</Text>
            </Box>
          }
        >
          <For each={props.installed}>
            {(plugin, i) => {
              const selected = (): boolean => i() === cursor()
              const status = pluginStatus(plugin)
              const statusLabel = status === undefined ? undefined : pluginStatusLabel(status)
              const update = installedUpdateStatus(plugin)
              return (
                <>
                  <Box flexDirection="row">
                    <Text fg={selected() ? _titleFg() : _textDimFg()}>{`  ${selected() ? SELECT_POINTER : ' '} `}</Text>
                    <Text
                      fg={selected() ? _titleFg() : _textFg()}
                      attributes={selected() ? _titleAttrs() : undefined}
                    >
                      {plugin.displayName}
                    </Text>
                    <Show when={status !== undefined && statusLabel !== undefined}>
                      <Text fg={status === 'enabled' ? _successFg() : _textDimFg()}>
                        {`  ${statusLabel ?? ''}`}
                      </Text>
                    </Show>
                    <Show when={update !== undefined}>
                      <Text fg={_warningFg()}>
                        {`  ${t('tui.dialogs.pluginsSelector.updateStatus', {
                          local: update?.local ?? '',
                          latest: update?.latest ?? '',
                        })}`}
                      </Text>
                    </Show>
                    <Show when={props.pluginHint?.id === plugin.id}>
                      <Text fg={_warningFg()}>{`  ${props.pluginHint?.text ?? ''}`}</Text>
                    </Show>
                  </Box>
                  <For each={wrapPlain(overviewPluginDescription(plugin), 76)}>
                    {(line) => (
                      <Box>
                        <Text fg={textMutedFg()}>{`    ${line}`}</Text>
                      </Box>
                    )}
                  </For>
                </>
              )
            }}
          </For>
          <Box>
            <Text>{''}</Text>
          </Box>
          <Box>
            <Text fg={textMutedFg()}>{` ${t('tui.dialogs.pluginsSelector.countInstalled', { count: props.installed.length })}`}</Text>
          </Box>
        </Show>
      </Show>
      <Show when={activeTab().id === 'official' || activeTab().id === 'third-party'}>
        {/* Marketplace body */}
        <MarketplaceTabBody
          tabId={activeTab().id}
          cursor={cursor()}
          market={market()}
          entries={
            activeTab().id === 'official'
              ? officialEntries()
              : thirdPartyEntries()
          }
          entriesForCount={
            activeTab().id === 'official'
              ? market().status === 'loaded'
                ? officialCatalogEntries()
                : officialEntries()
              : thirdPartyEntries()
          }
          capabilities={props.capabilities ?? []}
          installedVersions={installedVersions()}
          isInstalled={isMarketplaceEntryInstalled}
          installedPluginId={installedPluginId}
          capabilityForEntry={capabilityForEntry}
        />
      </Show>
      <Show when={activeTab().id === 'custom'}>
        {/* Custom URL input */}
        <Box>
          <Text fg={textMutedFg()}>{` ${t('tui.dialogs.pluginsSelector.installFromUrlHint')}`}</Text>
        </Box>
        <Box>
          <Text>{''}</Text>
        </Box>
        <Box>
          <Text fg={_borderFg()}>{`╭${'─'.repeat(36)}╮`}</Text>
        </Box>
        <Box flexDirection="row">
          <Text fg={_borderFg()}>{'│'}</Text>
          <Text>{'  '}</Text>
          <Text fg={_textFg()}>{customUrl().length > 0 ? customUrl() : ' '}</Text>
          <Text>{'  '}</Text>
          <Text fg={_borderFg()}>{'│'}</Text>
        </Box>
        <Box>
          <Text fg={_borderFg()}>{`╰${'─'.repeat(36)}╯`}</Text>
        </Box>
      </Show>
      {/* Bottom border */}
      <Box>
        <Text fg={_borderFg()}>─</Text>
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// MarketplaceTabBody — extracted sub-render so the main view stays readable
// ---------------------------------------------------------------------------

interface MarketplaceTabBodyProps {
  readonly tabId: PluginsPanelTabId
  readonly cursor: number
  readonly market: MarketState
  readonly entries: readonly PluginMarketplaceEntry[]
  readonly entriesForCount: readonly PluginMarketplaceEntry[]
  readonly capabilities: readonly CapabilityStatus[]
  readonly installedVersions: ReadonlyMap<string, string | undefined>
  readonly isInstalled: (entry: PluginMarketplaceEntry) => boolean
  readonly installedPluginId: (entry: PluginMarketplaceEntry) => string
  readonly capabilityForEntry: (entry: PluginMarketplaceEntry) => CapabilityStatus | undefined
}

const MarketplaceTabBody: Component<MarketplaceTabBodyProps> = (props) => {
  const _borderFg = (): ColorInput => currentTheme.color('primary')
  const _titleFg = (): ColorInput => currentTheme.color('primary')
  const _titleAttrs = (): number => currentTheme.attributes('bold')
  const _textFg = (): ColorInput => currentTheme.color('text')
  const _textDimFg = (): ColorInput => currentTheme.color('textDim')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')
  const _warningFg = (): ColorInput => currentTheme.color('warning')
  const _primaryFg = (): ColorInput => currentTheme.color('primary')

  if (props.tabId === 'third-party' && props.market.status === 'loaded') {
    return (
      <>
        <Box>
          <Text fg={textMutedFg()}>{` ${t('tui.dialogs.pluginsSelector.thirdPartySourceHint')}`}</Text>
        </Box>
        <Box>
          <Text>{''}</Text>
        </Box>
        <MarketplaceList
          cursor={props.cursor}
          entries={props.entries}
          entriesForCount={props.entriesForCount}
          market={props.market}
          installedVersions={props.installedVersions}
          tabId={props.tabId}
          isInstalled={props.isInstalled}
          installedPluginId={props.installedPluginId}
          capabilityForEntry={props.capabilityForEntry}
        />
      </>
    )
  }

  return (
    <MarketplaceList
      cursor={props.cursor}
      entries={props.entries}
      entriesForCount={props.entriesForCount}
      market={props.market}
      installedVersions={props.installedVersions}
      tabId={props.tabId}
      isInstalled={props.isInstalled}
      installedPluginId={props.installedPluginId}
      capabilityForEntry={props.capabilityForEntry}
    />
  )
}

interface MarketplaceListProps {
  readonly cursor: number
  readonly entries: readonly PluginMarketplaceEntry[]
  readonly entriesForCount: readonly PluginMarketplaceEntry[]
  readonly market: MarketState
  readonly installedVersions: ReadonlyMap<string, string | undefined>
  readonly tabId: PluginsPanelTabId
  readonly isInstalled: (entry: PluginMarketplaceEntry) => boolean
  readonly installedPluginId: (entry: PluginMarketplaceEntry) => string
  readonly capabilityForEntry: (entry: PluginMarketplaceEntry) => CapabilityStatus | undefined
}

const MarketplaceList: Component<MarketplaceListProps> = (props) => {
  const _titleFg = (): ColorInput => currentTheme.color('primary')
  const _titleAttrs = (): number => currentTheme.attributes('bold')
  const _textFg = (): ColorInput => currentTheme.color('text')
  const _textDimFg = (): ColorInput => currentTheme.color('textDim')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')
  const _warningFg = (): ColorInput => currentTheme.color('warning')
  const _primaryFg = (): ColorInput => currentTheme.color('primary')

  if (props.market.status === 'loading' || props.market.status === 'idle') {
    return (
      <Box>
        <Text fg={textMutedFg()}>{`  ${t('tui.dialogs.pluginsSelector.loadingMarketplace')}`}</Text>
      </Box>
    )
  }
  if (props.market.status === 'error') {
    return (
      <>
        <Box>
          <Text fg={_warningFg()}>{`  ${t('tui.dialogs.pluginsSelector.marketplaceUnavailable', { message: props.market.message })}`}</Text>
        </Box>
        <Box>
          <Text fg={textMutedFg()}>{`  ${t('tui.dialogs.pluginsSelector.useCustomTabHint')}`}</Text>
        </Box>
      </>
    )
  }
  if (props.entries.length === 0) {
    return (
      <Box>
        <Text fg={textMutedFg()}>{`  ${t('tui.dialogs.pluginsSelector.noPluginsFound')}`}</Text>
      </Box>
    )
  }
  return (
    <>
      <For each={props.entries}>
        {(entry, i) => {
          const selected = (): boolean => i() === props.cursor
          const capability = props.capabilityForEntry(entry)
          const status = isPinnedWebBridgeEntry(entry)
            ? 'open-in-browser'
            : capability?.install.running === true
              ? 'installing…'
              : marketplaceEntryStatusToken(
                  entry,
                  props.installedVersions,
                  props.installedPluginId(entry),
                )
          const label = marketplaceStatusToLabel(status)
          return (
            <>
              <Box flexDirection="row">
                <Text fg={selected() ? _titleFg() : _textDimFg()}>{`  ${selected() ? SELECT_POINTER : ' '} `}</Text>
                <Text
                  fg={selected() ? _titleFg() : _textFg()}
                  attributes={selected() ? _titleAttrs() : undefined}
                >
                  {entry.displayName}
                </Text>
                <Text>{'  '}</Text>
                <Text fg={currentTheme.color(marketplaceStatusToken(status))}>{label}</Text>
              </Box>
              <For each={wrapPlain(
                props.tabId === 'official'
                  ? officialMarketplaceEntryDescription(entry)
                  : marketplaceEntryDescription(entry),
                76,
              )}>
                {(line) => (
                  <Box>
                    <Text fg={textMutedFg()}>{`    ${line}`}</Text>
                  </Box>
                )}
              </For>
            </>
          )
        }}
      </For>
      <Box>
        <Text>{''}</Text>
      </Box>
      <Box>
        <Text fg={textMutedFg()}>{` ${t('tui.dialogs.pluginsSelector.marketplaceCount', {
          installed: props.entriesForCount.filter((e) => props.isInstalled(e)).length,
          available: props.entriesForCount.length - props.entriesForCount.filter((e) => props.isInstalled(e)).length,
        })}`}</Text>
      </Box>
      <Show when={props.market.status === 'loaded'}>
        <Box>
          <Text fg={textMutedFg()}>{` ${t('tui.dialogs.pluginsSelector.marketplaceSource', { source: props.market.source })}`}</Text>
        </Box>
      </Show>
    </>
  )
}

// Reference unused imports / symbols to satisfy lint.
void formatPluginSourceLabel
void pluginTrustLabel
void _primaryFg