import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import {
  marketplaceEntryVisibleOnHost,
  type CapabilityStatus,
  type PluginInfo,
  type PluginMcpServerInfo,
  type PluginSummary,
} from '@moonshot-ai/kimi-code-sdk';
import chalk from 'chalk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import {
  capabilityIdForMarketplaceEntry,
  dedupeCapabilityMarketplaceEntries,
  installedPluginForMarketplaceEntry,
} from '#/tui/utils/capability-marketplace';
import { formatPluginSourceLabel, pluginTrustLabel } from '#/tui/utils/plugin-source-label';
import { printableChar } from '#/tui/utils/printable-key';
import { renderTabStrip } from '#/tui/utils/tab-strip';
import { computeUpdateStatus, pluginMarketplaceCliDescription, type PluginMarketplaceEntry } from '#/utils/plugin-marketplace';

import { ChoicePickerComponent } from './choice-picker';
import { t } from '#/i18n';

const MCP_SERVER_PREFIX = 'mcp:';

const REMOVE_CONFIRM_CANCEL = 'cancel';
const REMOVE_CONFIRM_REMOVE = 'remove';
const INSTALL_TRUST_EXIT = 'exit';
const INSTALL_TRUST_TRUST = 'trust';
const ELLIPSIS = '…';

interface PluginsOverviewItem {
  readonly value: string;
  readonly kind: 'plugin' | 'action';
  readonly label: string;
  readonly status?: string;
  readonly description: string;
}

export type PluginMcpSelection =
  | { readonly kind: 'toggle'; readonly pluginId: string; readonly server: string; readonly enabled: boolean }
  | { readonly kind: 'back'; readonly pluginId: string };

export interface PluginMcpSelectorOptions {
  readonly info: PluginInfo;
  readonly selectedServer?: string;
  readonly serverHint?: {
    readonly server: string;
    readonly text: string;
  };
  readonly onSelect: (selection: PluginMcpSelection) => void;
  readonly onCancel: () => void;
}

export class PluginMcpSelectorComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: PluginMcpSelectorOptions;
  private readonly items: readonly PluginsOverviewItem[];
  private selectedIndex = 0;

  constructor(opts: PluginMcpSelectorOptions) {
    super();
    this.opts = opts;
    this.items = buildMcpItems(opts.info);
    const selectedIndex = this.items.findIndex(
      (item) => item.value === `${MCP_SERVER_PREFIX}${opts.selectedServer}`,
    );
    this.selectedIndex = Math.max(0, selectedIndex);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || printableChar(data) === ' ') {
      const chosen = this.items[this.selectedIndex];
      if (chosen === undefined) return;
      if (chosen.value === 'back') {
        this.opts.onSelect({ kind: 'back', pluginId: this.opts.info.id });
        return;
      }
      const serverName = mcpItemServerName(chosen);
      if (serverName === undefined) return;
      const server = this.opts.info.mcpServers.find((item) => item.name === serverName);
      if (server === undefined) return;
      this.opts.onSelect({
        kind: 'toggle',
        pluginId: this.opts.info.id,
        server: server.name,
        enabled: !server.enabled,
      });
    }
  }

  override render(width: number): string[] {
    const { info } = this.opts;
    const colors = currentTheme.palette;
    const serverItems = this.items.filter((item) => item.kind === 'plugin');
    const actionItems = this.items.filter((item) => item.kind === 'action');
    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(t('tui.dialogs.pluginsSelector.mcpServersTitle', { name: info.displayName })),
      mutedHintLine(t('tui.dialogs.pluginsSelector.mcpNavHint'), colors),
      '',
      sectionLabel(t('tui.dialogs.pluginsSelector.mcpServersSection', { enabled: info.enabledMcpServerCount, total: info.mcpServerCount }), colors),
    ];

    if (serverItems.length === 0) {
      lines.push(chalk.hex(colors.textMuted)(t('tui.dialogs.pluginsSelector.noMcpServers')));
    } else {
      for (let i = 0; i < serverItems.length; i++) {
        lines.push(...this.renderItem(serverItems[i]!, i, width));
      }
    }

    lines.push('');
    lines.push(sectionLabel(t('tui.dialogs.pluginsSelector.actionsSection'), colors));
    for (let i = 0; i < actionItems.length; i++) {
      lines.push(...this.renderItem(actionItems[i]!, serverItems.length + i, width));
    }

    lines.push('');
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  private renderItem(item: PluginsOverviewItem, index: number, width: number): string[] {
    const colors = currentTheme.palette;
    const selected = index === this.selectedIndex;
    const pointer = selected ? SELECT_POINTER : ' ';
    const labelStyle = selected ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
    const prefix = chalk.hex(selected ? colors.primary : colors.textDim)(`  ${pointer} `);
    let line = prefix + labelStyle(item.label);
    if (item.status !== undefined) {
      line += '  ' + statusStyle(item, colors)(item.status);
    }
    const serverName = mcpItemServerName(item);
    if (serverName !== undefined && this.opts.serverHint?.server === serverName) {
      line += '  ' + chalk.hex(colors.warning)(this.opts.serverHint.text);
    }
    const descriptionWidth = Math.max(1, width - 4);
    const lines = [line];
    for (const descLine of wrapOverviewDescription(item.description, descriptionWidth)) {
      lines.push(mutedHintLine(`    ${descLine}`, colors));
    }
    return lines;
  }
}

export type PluginRemoveConfirmResult =
  | { readonly kind: 'confirm' }
  | { readonly kind: 'cancel' };

export interface PluginRemoveConfirmOptions {
  readonly id: string;
  readonly displayName: string;
  readonly onDone: (result: PluginRemoveConfirmResult) => void;
}

export class PluginRemoveConfirmComponent extends ChoicePickerComponent {
  constructor(opts: PluginRemoveConfirmOptions) {
    super({
      title: `Remove ${opts.displayName} (${opts.id})?`,
      hint: t('tui.dialogs.pluginsSelector.removeConfirmHint'),
      formatHint: mutedHintLine,
      options: [
        {
          value: REMOVE_CONFIRM_CANCEL,
          label: t('tui.dialogs.pluginsSelector.removeCancelLabel'),
          description: t('tui.dialogs.pluginsSelector.removeCancelDesc'),
        },
        {
          value: REMOVE_CONFIRM_REMOVE,
          label: t('tui.dialogs.pluginsSelector.removeConfirmLabel'),
          tone: 'danger',
          description: t('tui.dialogs.pluginsSelector.removeConfirmDesc'),
        },
      ],
      onSelect: (value) => {
        opts.onDone(value === REMOVE_CONFIRM_REMOVE ? { kind: 'confirm' } : { kind: 'cancel' });
      },
      onCancel: () => {
        opts.onDone({ kind: 'cancel' });
      },
    });
  }
}

export type PluginInstallTrustConfirmResult =
  | { readonly kind: 'confirm' }
  | { readonly kind: 'cancel' };

export interface PluginInstallTrustConfirmOptions {
  readonly label: string;
  readonly onDone: (result: PluginInstallTrustConfirmResult) => void;
}

export class PluginInstallTrustConfirmComponent extends ChoicePickerComponent {
  constructor(opts: PluginInstallTrustConfirmOptions) {
    super({
      title: t('tui.dialogs.pluginsSelector.installTrustTitle', { label: opts.label }),
      hint: t('tui.dialogs.pluginsSelector.installTrustHint'),
      formatHint: mutedHintLine,
      notice:
        '⚠️ This is a third-party plugin that Kimi has not reviewed. It can bundle MCP servers, ' +
        'skills, or files that run code and access your workspace. Install it only if you ' +
        'trust the source.',
      noticeTone: 'warning',
      options: [
        {
          value: INSTALL_TRUST_EXIT,
          label: t('tui.dialogs.pluginsSelector.installTrustExitLabel'),
          description: t('tui.dialogs.pluginsSelector.installTrustExitDesc'),
        },
        {
          value: INSTALL_TRUST_TRUST,
          label: t('tui.dialogs.pluginsSelector.installTrustTrustLabel'),
          tone: 'danger',
          description: t('tui.dialogs.pluginsSelector.installTrustTrustDesc'),
        },
      ],
      onSelect: (value) => {
        opts.onDone(value === INSTALL_TRUST_TRUST ? { kind: 'confirm' } : { kind: 'cancel' });
      },
      onCancel: () => {
        opts.onDone({ kind: 'cancel' });
      },
    });
  }
}

export class PluginStopProcessesConfirmComponent extends ChoicePickerComponent {
  constructor(opts: { readonly label: string; readonly onDone: (confirmed: boolean) => void }) {
    super({
      title: t('tui.dialogs.pluginsSelector.stopProcessesTitle', { label: opts.label }),
      hint: t('tui.dialogs.pluginsSelector.stopProcessesHint'),
      formatHint: mutedHintLine,
      notice:
        t('tui.dialogs.pluginsSelector.stopProcessesNotice'),
      noticeTone: 'warning',
      spaceSelect: false,
      options: [
        { value: 'cancel', label: t('tui.dialogs.pluginsSelector.stopProcessesCancel'), description: t('tui.dialogs.pluginsSelector.stopProcessesCancelDesc') },
        { value: 'confirm', label: t('tui.dialogs.pluginsSelector.stopProcessesConfirm'), tone: 'danger' },
      ],
      onSelect: (value) => {
        opts.onDone(value === 'confirm');
      },
      onCancel: () => {
        opts.onDone(false);
      },
    });
  }
}

function overviewPluginDescription(plugin: PluginSummary): string {
  const state = plugin.state === 'ok' ? '' : ` · state ${plugin.state}`;
  const skills = `${plugin.skillCount} skill${plugin.skillCount === 1 ? '' : 's'}`;
  const mcp =
    plugin.mcpServerCount > 0
      ? ` · MCP ${plugin.enabledMcpServerCount}/${plugin.mcpServerCount}`
      : '';
  const diagnostics = plugin.hasErrors ? ' · diagnostics available' : '';
  const source = ` · ${formatPluginSourceLabel(plugin)}`;
  const trust = ` · ${pluginTrustLabel(plugin)}`;
  return `id ${plugin.id} · ${skills}${mcp}${source}${trust}${state}${diagnostics}`;
}

function pluginStatus(plugin: PluginSummary): string | undefined {
  if (plugin.state !== 'ok') return plugin.state;
  return plugin.enabled ? 'enabled' : 'disabled';
}

function marketplaceStatusStyle(status: string, colors: ColorPalette): (text: string) => string {
  if (status.startsWith('update')) return chalk.hex(colors.warning);
  if (status.startsWith('installed') || status === 'cloud only') {
    return chalk.hex(colors.textDim);
  }
  return chalk.hex(colors.primary);
}

function renderUrlInputBox(
  input: Input,
  focused: boolean,
  width: number,
  colors: ColorPalette,
): string[] {
  input.focused = focused;
  const border = (s: string): string => chalk.hex(colors.primary)(s);
  const boxWidth = Math.max(24, width - 2);
  const innerWidth = Math.max(10, boxWidth - 4);
  const inputLine = input.render(innerWidth)[0] ?? '';
  const rightPad = Math.max(0, innerWidth - visibleWidth(inputLine));
  return [
    ' ' + border('╭' + '─'.repeat(boxWidth - 2) + '╮'),
    ' ' + border('│') + '  ' + inputLine + ' '.repeat(rightPad) + border('│'),
    ' ' + border('╰' + '─'.repeat(boxWidth - 2) + '╯'),
  ];
}

export type PluginsPanelTabId = 'installed' | 'official' | 'third-party' | 'custom';

export type PluginsPanelSelection =
  | { readonly kind: 'toggle'; readonly id: string; readonly enabled: boolean }
  | { readonly kind: 'remove'; readonly id: string }
  | { readonly kind: 'mcp'; readonly id: string }
  | { readonly kind: 'details'; readonly id: string }
  | { readonly kind: 'reload' }
  | { readonly kind: 'install'; readonly entry: PluginMarketplaceEntry }
  | { readonly kind: 'install-source'; readonly source: string };

export interface PluginsPanelOptions {
  installed: readonly PluginSummary[];
  readonly capabilities?: readonly CapabilityStatus[];
  readonly catalogIsDefault?: boolean;
  readonly initialTab?: PluginsPanelTabId;
  readonly selectedId?: string;
  readonly pluginHint?: { readonly id: string; readonly text: string };
  readonly onSelect: (selection: PluginsPanelSelection) => void;
  readonly onCancel: () => void;
  readonly onRequestMarketplace?: () => void;
}

type MarketState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'loaded'; readonly entries: readonly PluginMarketplaceEntry[]; readonly source: string };

const PLUGINS_PANEL_TABS: readonly { id: PluginsPanelTabId; label: string }[] = [
  { id: 'installed', label: t('tui.dialogs.pluginsSelector.tabInstalled') },
  { id: 'official', label: t('tui.dialogs.pluginsSelector.tabOfficial') },
  { id: 'third-party', label: t('tui.dialogs.pluginsSelector.tabThirdParty') },
  { id: 'custom', label: t('tui.dialogs.pluginsSelector.tabCustom') },
];

export class PluginsPanelComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: PluginsPanelOptions;
  private readonly customInput = new Input();
  private activeTabIndex: number;
  private selectedIndex = 0;
  private market: MarketState = { status: 'idle' };
  private installing: string | undefined;
  private catalogVersions = new Map<string, string | undefined>();

  constructor(opts: PluginsPanelOptions) {
    super();
    this.opts = opts;
    this.activeTabIndex = Math.max(
      0,
      PLUGINS_PANEL_TABS.findIndex((tab) => tab.id === (opts.initialTab ?? 'installed')),
    );
    if (opts.selectedId !== undefined && this.activeTab.id === 'installed') {
      const idx = opts.installed.findIndex((p) => p.id === opts.selectedId);
      if (idx >= 0) this.selectedIndex = idx;
    }
    this.customInput.onSubmit = (value) => {
      const source = value.trim();
      if (source.length > 0) this.opts.onSelect({ kind: 'install-source', source });
    };
  }

  marketplaceStatus(): MarketState['status'] {
    return this.market.status;
  }

  marketplaceSource(): string | undefined {
    return this.market.status === 'loaded' ? this.market.source : undefined;
  }

  setMarketplaceLoading(): void {
    this.market = { status: 'loading' };
  }

  setInstalled(plugins: readonly PluginSummary[]): void {
    this.opts.installed = plugins;
  }

  setMarketplace(entries: readonly PluginMarketplaceEntry[], source: string): void {
    this.market = { status: 'loaded', entries, source };
  }

  setMarketplaceCatalogVersions(entries: readonly PluginMarketplaceEntry[]): void {
    this.catalogVersions = new Map(entries.map((entry) => [entry.id, entry.version]));
  }

  expectedMarketplaceVersion(entry: PluginMarketplaceEntry): string | undefined {
    if (this.catalogVersions.has(entry.id)) return this.catalogVersions.get(entry.id);
    return entry.version;
  }

  setMarketplaceError(message: string): void {
    this.market = { status: 'error', message };
  }

  setInstalling(label: string): void {
    this.installing = label;
    this.invalidate();
  }

  clearInstalling(): void {
    this.installing = undefined;
    this.invalidate();
  }

  private get activeTab(): (typeof PLUGINS_PANEL_TABS)[number] {
    return PLUGINS_PANEL_TABS[this.activeTabIndex]!;
  }

  private get marketplaceEntries(): readonly PluginMarketplaceEntry[] {
    const entries = this.market.status === 'loaded' ? this.market.entries : this.pendingBuiltInEntries;
    return dedupeCapabilityMarketplaceEntries(
      entries.filter(marketplaceEntryIsVisible),
      this.opts.capabilities ?? [],
      this.catalogIsDefault,
    );
  }

  private get pendingBuiltInEntries(): readonly PluginMarketplaceEntry[] {
    if (!this.catalogIsDefault) return [];
    return (this.opts.capabilities ?? [])
      .filter((capability) => capability.supported)
      .map((capability) => ({
        id: capability.pluginId ?? capability.id,
        displayName: capability.displayName,
        description: capability.description,
        tier: 'official',
        source: `capability:${capability.id}`,
        builtIn: true,
      }));
  }

  private get catalogIsDefault(): boolean {
    return this.opts.catalogIsDefault !== false;
  }

  private capabilityForEntry(entry: PluginMarketplaceEntry): CapabilityStatus | undefined {
    const capabilityId = capabilityIdForMarketplaceEntry(entry.id, this.catalogIsDefault);
    return this.opts.capabilities?.find((capability) => capability.id === capabilityId);
  }

  private installedPluginForEntry(entry: PluginMarketplaceEntry): PluginSummary | undefined {
    return installedPluginForMarketplaceEntry(
      entry.id,
      this.opts.installed,
      this.capabilityForEntry(entry),
      this.catalogIsDefault,
    );
  }

  private isMarketplaceEntryInstalled(entry: PluginMarketplaceEntry): boolean {
    return this.installedPluginForEntry(entry) !== undefined;
  }

  private get officialEntries(): readonly PluginMarketplaceEntry[] {
    return this.marketplaceEntries.filter((entry) => entry.tier === 'official');
  }

  private get thirdPartyEntries(): readonly PluginMarketplaceEntry[] {
    return this.marketplaceEntries.filter((entry) => entry.tier !== 'official');
  }

  private requestMarketplaceIfNeeded(): void {
    if (this.market.status === 'idle' && this.activeTab.id !== 'custom') {
      this.market = { status: 'loading' };
      this.opts.onRequestMarketplace?.();
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.activeTabIndex = (this.activeTabIndex + 1) % PLUGINS_PANEL_TABS.length;
      this.selectedIndex = 0;
      this.requestMarketplaceIfNeeded();
      return;
    }
    if (matchesKey(data, Key.shift('tab'))) {
      this.activeTabIndex =
        (this.activeTabIndex - 1 + PLUGINS_PANEL_TABS.length) % PLUGINS_PANEL_TABS.length;
      this.selectedIndex = 0;
      this.requestMarketplaceIfNeeded();
      return;
    }
    switch (this.activeTab.id) {
      case 'installed':
        this.handleInstalledInput(data);
        return;
      case 'official':
      case 'third-party':
        this.handleMarketplaceInput(data);
        return;
      case 'custom':
        this.customInput.handleInput(data);
        return;
    }
  }

  private handleInstalledInput(data: string): void {
    const plugins = this.opts.installed;
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(plugins.length - 1, this.selectedIndex + 1);
      return;
    }
    const plugin = plugins[this.selectedIndex];
    const ch = printableChar(data);
    if (matchesKey(data, Key.space) || ch === ' ') {
      if (plugin !== undefined) {
        this.opts.onSelect({ kind: 'toggle', id: plugin.id, enabled: !plugin.enabled });
      }
      return;
    }
    if (ch === 'd' || ch === 'D') {
      if (plugin !== undefined) this.opts.onSelect({ kind: 'remove', id: plugin.id });
      return;
    }
    if (ch === 'm' || ch === 'M') {
      if (plugin !== undefined) this.opts.onSelect({ kind: 'mcp', id: plugin.id });
      return;
    }
    if (ch === 'r' || ch === 'R') {
      this.opts.onSelect({ kind: 'reload' });
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (plugin === undefined) return;
      const update = this.installedUpdateStatus(plugin);
      if (update !== undefined) {
        this.opts.onSelect({ kind: 'install', entry: update.entry });
      } else {
        this.opts.onSelect({ kind: 'details', id: plugin.id });
      }
      return;
    }
    if (ch === 'i' || ch === 'I') {
      if (plugin !== undefined) this.opts.onSelect({ kind: 'details', id: plugin.id });
    }
  }

  private handleMarketplaceInput(data: string): void {
    const entries = this.activeTab.id === 'official' ? this.officialEntries : this.thirdPartyEntries;
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = entries.length === 0 ? 0 : Math.min(entries.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const entry = entries[this.selectedIndex];
      if (entry === undefined || marketplaceEntryIsCloudOnly(entry)) return;
      this.opts.onSelect({ kind: 'install', entry });
    }
  }

  override invalidate(): void {
    super.invalidate();
    this.customInput.invalidate();
  }

  override render(width: number): string[] {
    if (this.installing !== undefined) {
      return this.renderInstalling(width);
    }
    const colors = currentTheme.palette;
    const tab = this.activeTab.id;
    const hint =
      tab === 'installed'
        ? this.installedHint()
        : tab === 'custom'
          ? t('tui.dialogs.pluginsSelector.tabHintCustom')
          : this.marketplaceHint();
    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(' Plugins'),
      mutedHintLine(hint, colors),
      '',
      renderTabStrip({
        labels: PLUGINS_PANEL_TABS.map((t) => t.label),
        activeIndex: this.activeTabIndex,
        width,
        colors,
      }),
      '',
    ];

    if (tab === 'installed') this.renderInstalled(lines, width);
    else if (tab === 'official') this.renderOfficial(lines, width);
    else if (tab === 'third-party') this.renderThirdParty(lines, width);
    else this.renderCustom(lines, width);

    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  private renderInstalled(lines: string[], width: number): void {
    const { installed } = this.opts;
    const colors = currentTheme.palette;
    if (installed.length === 0) {
      lines.push(chalk.hex(colors.textMuted)('  No plugins installed.'));
    } else {
      for (let i = 0; i < installed.length; i++) {
        lines.push(...this.renderInstalledRow(installed[i]!, i, width));
      }
    }
    lines.push('');
    lines.push(mutedHintLine(` ${installed.length} installed`, colors));
  }

  private marketplaceHint(): string {
    const entries = this.activeTab.id === 'official' ? this.officialEntries : this.thirdPartyEntries;
    const entry = entries[this.selectedIndex];
    const install = entry !== undefined && marketplaceEntryIsCloudOnly(entry) ? '' : ' · Enter install';
    return ` Tab switch · ↑↓ navigate${install} · Esc cancel`;
  }

  private installedHint(): string {
    const plugin = this.opts.installed[this.selectedIndex];
    const hasUpdate = plugin !== undefined && this.installedUpdateStatus(plugin) !== undefined;
    const enter = hasUpdate ? t('tui.dialogs.pluginsSelector.enterUpdate') : t('tui.dialogs.pluginsSelector.enterDetails');
    return t('tui.dialogs.pluginsSelector.tabHintInstalled', { enterAction: enter });
  }

  private installedUpdateStatus(
    plugin: PluginSummary,
  ): { entry: PluginMarketplaceEntry; local: string; latest: string } | undefined {
    if (this.market.status !== 'loaded') return undefined;
    const entries = this.marketplaceEntries.filter((entry) => !marketplaceEntryIsCloudOnly(entry));
    const entry = entries.find(
      (candidate) => this.installedPluginForEntry(candidate)?.id === plugin.id,
    );
    if (entry === undefined) return undefined;
    const status = computeUpdateStatus(entry.version, plugin.version, true);
    return status.kind === 'update' ? { entry, local: status.local, latest: status.latest } : undefined;
  }

  private renderInstalledRow(plugin: PluginSummary, index: number, width: number): string[] {
    const colors = currentTheme.palette;
    const selected = index === this.selectedIndex;
    const pointer = selected ? SELECT_POINTER : ' ';
    const labelStyle = selected ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
    const prefix = chalk.hex(selected ? colors.primary : colors.textDim)(`  ${pointer} `);
    const status = pluginStatus(plugin);
    const update = this.installedUpdateStatus(plugin);
    let line = prefix + labelStyle(plugin.displayName);
    if (status !== undefined) {
      line += '  ' + statusStyle({ kind: 'plugin', value: '', label: '', description: '', status }, colors)(status);
    }
    if (update !== undefined) {
      const badge = `update ${update.local} → ${update.latest}`;
      line += '  ' + marketplaceStatusStyle(badge, colors)(badge);
    }
    if (this.opts.pluginHint?.id === plugin.id) {
      line += '  ' + chalk.hex(colors.warning)(this.opts.pluginHint.text);
    }
    const descWidth = Math.max(1, width - 4);
    const out = [line];
    for (const descLine of wrapOverviewDescription(overviewPluginDescription(plugin), descWidth)) {
      out.push(mutedHintLine(`    ${descLine}`, colors));
    }
    return out;
  }

  private renderMarketplaceTab(
    lines: string[],
    width: number,
    entries: readonly PluginMarketplaceEntry[],
  ): void {
    const colors = currentTheme.palette;
    if (this.market.status === 'loading' || this.market.status === 'idle') {
      lines.push(chalk.hex(colors.textMuted)(t('tui.dialogs.pluginsSelector.loadingMarketplace')));
      if (entries.length === 0) return;
    } else if (this.market.status === 'error') {
      lines.push(chalk.hex(colors.warning)(`  Marketplace unavailable: ${this.market.message}`));
      lines.push(mutedHintLine(t('tui.dialogs.pluginsSelector.useCustomTabHint'), colors));
      if (entries.length === 0) return;
    }
    if (entries.length === 0) {
      lines.push(chalk.hex(colors.textMuted)(t('tui.dialogs.pluginsSelector.noPluginsFound')));
    } else {
      for (let i = 0; i < entries.length; i++) {
        lines.push(...this.renderMarketplaceRow(entries[i]!, i, width));
      }
    }
    const installedCount = entries.filter((entry) =>
      this.isMarketplaceEntryInstalled(entry),
    ).length;
    lines.push('');
    lines.push(
      mutedHintLine(
        t('tui.dialogs.pluginsSelector.marketplaceCount', { installed: installedCount, available: entries.length - installedCount }),
        colors,
      ),
    );
    if (this.market.status === 'loaded') {
      lines.push(mutedHintLine(` Source: ${this.market.source}`, colors));
    }
  }

  private renderOfficial(lines: string[], width: number): void {
    this.renderMarketplaceTab(lines, width, this.officialEntries);
  }

  private renderThirdParty(lines: string[], width: number): void {
    if (this.catalogIsDefault) {
      const colors = currentTheme.palette;
      lines.push(mutedHintLine(t('tui.dialogs.pluginsSelector.thirdPartySourceHint'), colors));
      lines.push('');
    }
    this.renderMarketplaceTab(lines, width, this.thirdPartyEntries);
  }

  private renderMarketplaceRow(entry: PluginMarketplaceEntry, index: number, width: number): string[] {
    const colors = currentTheme.palette;
    const selected = index === this.selectedIndex;
    const pointer = selected ? SELECT_POINTER : ' ';
    const labelStyle = selected ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
    const prefix = chalk.hex(selected ? colors.primary : colors.textDim)(`  ${pointer} `);
    const capability = this.capabilityForEntry(entry);
    const status = marketplaceEntryIsCloudOnly(entry)
      ? 'cloud only'
      : capability?.install.running === true
        ? 'installing…'
        : marketplaceEntryStatus(entry, this.installedPluginForEntry(entry));
    const line =
      prefix + labelStyle(entry.displayName) + '  ' + marketplaceStatusStyle(status, colors)(status);
    const descWidth = Math.max(1, width - 4);
    const out = [line];
    const isOfficial = this.activeTab.id === 'official';
    const description = isOfficial
      ? officialMarketplaceEntryDescription(entry)
      : marketplaceEntryDescription(entry);
    for (const descLine of wrapOverviewDescription(description, descWidth)) {
      out.push(mutedHintLine(`    ${descLine}`, colors));
    }
    if (!isOfficial) {
      for (const metadataLine of wrapOverviewDescription(marketplaceEntryMetadata(entry), descWidth)) {
        out.push(mutedHintLine(`    ${metadataLine}`, colors));
      }
    }
    return out;
  }

  private renderCustom(lines: string[], width: number): void {
    const colors = currentTheme.palette;
    lines.push(mutedHintLine(t('tui.dialogs.pluginsSelector.installFromUrlHint'), colors));
    lines.push('');
    lines.push(...renderUrlInputBox(this.customInput, this.focused, width, colors));
  }

  private renderInstalling(width: number): string[] {
    const colors = currentTheme.palette;
    const lines = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(' Plugins'),
      '',
      chalk.hex(colors.textMuted)(`  Installing ${this.installing}…`),
      '',
      chalk.hex(colors.primary)('─'.repeat(width)),
    ];
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }
}

function buildMcpItems(info: PluginInfo): PluginsOverviewItem[] {
  const items: PluginsOverviewItem[] = info.mcpServers.map((server) => ({
    value: `${MCP_SERVER_PREFIX}${server.name}`,
    kind: 'plugin',
    label: server.name,
    status: server.enabled ? 'enabled' : 'disabled',
    description: mcpServerDescription(server),
  }));
  items.push({
    value: 'back',
    kind: 'action',
    label: t('tui.dialogs.pluginsSelector.backToInstalled'),
    description: t('tui.dialogs.pluginsSelector.backToInstalledDesc'),
  });
  return items;
}

function mcpServerDescription(server: PluginMcpServerInfo): string {
  const action = server.enabled ? t('tui.dialogs.pluginsSelector.mcpDisable') : t('tui.dialogs.pluginsSelector.mcpEnable');
  if (server.transport === 'http' || server.transport === 'sse') {
    return `${action} · ${server.transport.toUpperCase()} · ${server.url ?? server.runtimeName}`;
  }
  const args = server.args !== undefined && server.args.length > 0 ? ` ${server.args.join(' ')}` : '';
  const command = `${server.command ?? ''}${args}`.trim();
  const cwd = server.cwd === undefined ? '' : ` · cwd ${server.cwd}`;
  return `${action} · stdio · ${command || server.runtimeName}${cwd}`;
}

function mcpItemServerName(item: PluginsOverviewItem): string | undefined {
  if (!item.value.startsWith(MCP_SERVER_PREFIX)) return undefined;
  return item.value.slice(MCP_SERVER_PREFIX.length);
}

function marketplaceEntryDescription(entry: PluginMarketplaceEntry): string {
  return pluginMarketplaceCliDescription(entry) ?? marketplaceTierLabel(entry.tier);
}

function marketplaceEntryMetadata(entry: PluginMarketplaceEntry): string {
  const version = entry.version !== undefined ? ` · v${entry.version}` : '';
  const tier = pluginMarketplaceCliDescription(entry) !== undefined
    ? ` · ${marketplaceTierLabel(entry.tier)}`
    : '';
  const keywords =
    entry.keywords !== undefined && entry.keywords.length > 0
      ? ` · ${entry.keywords.join(', ')}`
      : '';
  return `id ${entry.id}${version}${tier}${keywords}`;
}

function officialMarketplaceEntryDescription(entry: PluginMarketplaceEntry): string {
  return pluginMarketplaceCliDescription(entry) ?? '';
}

function marketplaceTierLabel(tier: PluginMarketplaceEntry['tier']): string {
  if (tier === 'official') return t('tui.dialogs.pluginsSelector.marketplaceTierOfficial');
  if (tier === 'curated') return t('tui.dialogs.pluginsSelector.marketplaceTierCurated');
  return t('tui.dialogs.pluginsSelector.marketplaceTierUnknown');
}

function marketplaceEntryIsVisible(entry: PluginMarketplaceEntry): boolean {
  return marketplaceEntryVisibleOnHost(entry, 'cli', process.platform);
}

function marketplaceEntryIsCloudOnly(entry: PluginMarketplaceEntry): boolean {
  const platforms: readonly string[] | undefined = entry.platforms;
  return platforms?.every((platform) => platform === 'cloud') === true;
}

function installStatus(entry: PluginMarketplaceEntry): string {
  return entry.version === undefined ? 'install' : t('tui.dialogs.pluginsSelector.installStatusVersion', { version: entry.version });
}

function marketplaceEntryStatus(
  entry: PluginMarketplaceEntry,
  installed: PluginSummary | undefined,
): string {
  const status = computeUpdateStatus(entry.version, installed?.version, installed !== undefined);
  switch (status.kind) {
    case 'update':
      return `update ${status.local} → ${status.latest}`;
    case 'up-to-date':
      return status.version === undefined ? 'installed' : t('tui.dialogs.pluginsSelector.installedStatusVersion', { version: status.version });
    case 'not-installed':
      return installStatus(entry);
  }
}

function sectionLabel(label: string, colors: ColorPalette): string {
  return chalk.hex(colors.textDim).bold(` ${label}`);
}

function statusStyle(
  item: PluginsOverviewItem,
  colors: ColorPalette,
): (text: string) => string {
  if (item.kind === 'action') return chalk.hex(colors.textDim);
  if (item.status === 'enabled' || item.status === 'installed') return chalk.hex(colors.success);
  if (item.status?.startsWith('install')) return chalk.hex(colors.primary);
  if (item.status === 'disabled') return chalk.hex(colors.textDim);
  if (item.status !== undefined && /^\d/.test(item.status)) return chalk.hex(colors.textDim);
  return chalk.hex(colors.warning);
}

function mutedHintLine(text: string, colors?: ColorPalette): string {
  if (colors !== undefined) {
    return chalk.hex(colors.textMuted)(text);
  }
  return currentTheme.fg('textMuted', text);
}

function wrapOverviewDescription(text: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = visibleWidth(word) <= maxWidth ? word : truncateToWidth(word, maxWidth, ELLIPSIS);
  }

  if (current.length > 0) lines.push(current);
  return lines;
}
