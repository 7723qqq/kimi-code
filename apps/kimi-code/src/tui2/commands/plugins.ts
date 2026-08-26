/**
 * TUI2 `/plugins` command — plugin management.
 *
 * Mirrors `tui/commands/plugins.ts` with the pi-tui panel mounting replaced
 * by response-store dialog state (`pluginsPanel` / `pluginMcpPicker` /
 * `pluginConfirm`) and transcript entries for list/info rendering.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import { homedir as osHomedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
  log,
  type CapabilityStatus,
  type PluginInfo,
  type PluginSummary,
  type Session,
} from '@moonshot-ai/kimi-code-sdk';

import { KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV, QUOTA_CONSUMING_PLUGIN_IDS } from '#/constant/app';
import { t } from '#/i18n';
import { openUrl } from '#/utils/open-url';
import { loadPluginMarketplace, type PluginMarketplaceEntry } from '#/utils/plugin-marketplace';

import type {
  PluginMcpSelection,
  PluginsPanelSelection,
  PluginsPanelTabId,
} from '../components/dialogs/plugins-selector';
import {
  buildPluginsInfoLines,
  buildPluginsListLines,
} from '../components/messages/plugins-status-panel';
import { getNoActiveSessionMessage } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import {
  formatPluginSourceLabel,
  isOfficialPluginInstall,
  isOfficialPluginSource,
} from '../utils/plugin-source-label';
import { nextTranscriptId } from '../utils/transcript-id';
import type { SlashCommandHost } from './dispatch';

interface ShowPluginsPickerOptions {
  readonly selectedId?: string;
  readonly pluginHint?: {
    readonly id: string;
    readonly text: string;
  };
  readonly initialTab?: PluginsPanelTabId;
  readonly marketplaceSource?: string;
}

interface ShowPluginMcpPickerOptions {
  readonly selectedServer?: string;
  readonly serverHint?: { readonly server: string; readonly text: string };
}

/** The plugin-management surface `/plugins` operates on. */
type PluginApi = Pick<
  Session,
  | 'listPlugins'
  | 'installPlugin'
  | 'setPluginEnabled'
  | 'setPluginMcpServerEnabled'
  | 'removePlugin'
  | 'reloadPlugins'
  | 'getPluginInfo'
>;

/**
 * Resolve the plugin-management API. On the v2 engine plugin state is
 * app-global, so a session-less startup still gets a working `/plugins`
 * through the harness's global facade; on v1 (and once a session exists) the
 * session's own API is used.
 */
async function resolvePluginApi(host: SlashCommandHost): Promise<PluginApi> {
  if (host.session !== undefined) return host.session;
  if (!host.engineV2) {
    throw new Error(getNoActiveSessionMessage());
  }
  return {
    listPlugins: () => host.harness.listPlugins(),
    installPlugin: (source) => host.harness.installPlugin(source),
    setPluginEnabled: (id, enabled) => host.harness.setPluginEnabled(id, enabled),
    setPluginMcpServerEnabled: (id, server, enabled) =>
      host.harness.setPluginMcpServerEnabled(id, server, enabled),
    removePlugin: (id) => host.harness.removePlugin(id),
    reloadPlugins: () => host.harness.reloadPlugins(),
    getPluginInfo: (id) => host.harness.getPluginInfo(id),
  };
}

export async function handlePluginsCommand(host: SlashCommandHost, rawArgs: string): Promise<void> {
  const args = rawArgs
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const sub = args[0];
  const rest = args.slice(1);
  const session = await resolvePluginApi(host);

  try {
    if (sub === undefined) {
      await showPluginsPicker(host);
      return;
    }
    if (sub === 'list') {
      await renderPluginsList(host);
      return;
    }
    if (sub === 'install') {
      const source = rest.join(' ').trim();
      if (source.length === 0) {
        host.showError(t('tui.statusMessages.pluginsUsageInstall'));
        return;
      }
      if (!(await confirmInstallTrust(host, source, isOfficialPluginSource(source)))) {
        host.showStatus(t('tui.statusMessages.pluginsInstallCancelled'));
        return;
      }
      const spinner = host.showProgressSpinner(
        t('tui.statusMessages.pluginsInstallingFrom', { source: truncateForStatus(source) }),
      );
      try {
        await installPluginFromSource(host, source);
        spinner.stop({ ok: true, label: t('tui.statusMessages.pluginsInstallFinished') });
      } catch (error) {
        spinner.stop({
          ok: false,
          label: t('tui.statusMessages.pluginsInstallFailed', { error: formatErrorMessage(error) }),
        });
        throw error;
      }
      return;
    }
    if (sub === 'marketplace') {
      const marketplaceSource = rest.join(' ').trim() || undefined;
      await showPluginsPicker(host, {
        // Custom marketplaces often omit `tier`, so their entries land on the
        // Curated tab (entry.tier !== 'official'). Open there when a custom
        // source is supplied; otherwise the default catalog's official entries
        // make Official the right landing tab.
        initialTab: marketplaceSource === undefined ? 'official' : 'third-party',
        marketplaceSource,
      });
      return;
    }
    if (sub === 'info') {
      const id = rest[0];
      if (id === undefined) {
        await showPluginsPicker(host);
        return;
      }
      await renderPluginInfo(host, id);
      return;
    }
    if (sub === 'mcp') {
      const action = rest[0];
      const id = rest[1];
      const server = rest[2];
      if (
        (action !== 'enable' && action !== 'disable') ||
        id === undefined ||
        server === undefined
      ) {
        host.showError(t('tui.statusMessages.pluginsUsageMcp'));
        return;
      }
      await session.setPluginMcpServerEnabled(id, server, action === 'enable');
      const mcpKey = action === 'enable' ? 'pluginsMcpEnabled' : 'pluginsMcpDisabled';
      host.showStatus(t(`tui.statusMessages.${mcpKey}`, { server, id }));
      return;
    }
    if (sub === 'enable' || sub === 'disable') {
      const id = rest[0];
      if (id === undefined) {
        await showPluginsPicker(host);
        return;
      }
      await applyPluginEnabled(host, id, sub === 'enable');
      return;
    }
    if (sub === 'remove') {
      const id = rest[0];
      if (id === undefined) {
        host.showError(t('tui.statusMessages.pluginsUsageRemove'));
        return;
      }
      if (!(await confirmRemovePlugin(host, id))) {
        host.showStatus(t('tui.statusMessages.pluginsRemoveCancelled', { id }));
        return;
      }
      await removePlugin(host, id);
      return;
    }
    if (sub === 'reload') {
      await reloadPlugins(host);
      return;
    }
    const plugins = await session.listPlugins();
    if (plugins.some((plugin) => plugin.id === sub)) {
      await renderPluginInfo(host, sub);
      return;
    }
    host.showError(t('tui.statusMessages.pluginsUnknownAction', { action: sub }));
  } catch (error) {
    host.showError(
      t('tui.statusMessages.pluginsCommandFailed', {
        action: sub ?? '',
        error: formatErrorMessage(error),
      }),
    );
  }
}

/**
 * Resolve the capability API. Like plugin state, capability state is
 * app-global on the v2 engine, so a session-less startup still gets
 * readiness and installs through the harness's global facade; with a live
 * session the session's own API is used (v1 included, where the capability
 * surface then reports itself unavailable).
 */
type CapabilityApi = Pick<Session, 'listCapabilities' | 'getCapability' | 'installCapability'>;

async function resolveCapabilityApi(host: SlashCommandHost): Promise<CapabilityApi> {
  if (host.session !== undefined) return host.session;
  if (!host.engineV2) {
    throw new Error(getNoActiveSessionMessage());
  }
  return host.harness;
}

function logCapabilityStatus(capability: CapabilityStatus, installed?: boolean): void {
  const payload = {
    capabilityId: capability.id,
    pluginId: capability.pluginId,
    installed,
    supported: capability.supported,
    state: capability.state,
    version: capability.version,
    install: capability.install,
    steps: capability.steps,
  };
  const hasStepIssues = capability.steps.some((step) => step.state !== 'ok');
  if (capability.install.error !== undefined || (installed !== false && hasStepIssues)) {
    log.warn('capability needs attention', payload);
  } else {
    log.info('capability status', payload);
  }
}

async function showPluginsPicker(
  host: SlashCommandHost,
  options?: ShowPluginsPickerOptions,
): Promise<void> {
  let plugins: readonly PluginSummary[];
  try {
    plugins = await (await resolvePluginApi(host)).listPlugins();
  } catch (error) {
    host.showError(
      t('tui.statusMessages.pluginsFailedToLoad', { error: formatErrorMessage(error) }),
    );
    return;
  }

  let capabilities: readonly CapabilityStatus[] = [];
  if (host.engineV2) {
    try {
      capabilities = await (await resolveCapabilityApi(host)).listCapabilities();
    } catch (error) {
      log.warn('capability status unavailable', { error });
    }
  }

  const installedIds = new Set(plugins.map((plugin) => plugin.id));
  for (const capability of capabilities) {
    logCapabilityStatus(capability, installedIds.has(capability.pluginId ?? capability.id));
  }

  host.store?.setState('pluginsPanel', {
    installed: plugins,
    installedIds,
    capabilities,
    catalogIsDefault: isDefaultMarketplaceCatalog(options?.marketplaceSource),
    initialTab: options?.initialTab,
    selectedId: options?.selectedId,
    pluginHint: options?.pluginHint,
    marketplaceLoading: options?.initialTab !== 'custom',
  });
  host.store?.setState('activeDialog', 'plugins-selector');
  // Kick off the catalog fetch for any tab that needs it.
  if (options?.initialTab !== 'custom') {
    void loadMarketplaceCatalog(host, options?.marketplaceSource, capabilities);
  }
}

/**
 * Adapt a capability from the engine's registry into a catalog row. The
 * engine is the single source of truth for what the built-in capabilities
 * are — the CLI only renders them. The `capability:<id>` source marker
 * routes installs through the capability flow (never a plain plugin
 * install), so the row needs no real URL.
 */
function capabilityMarketplaceEntry(capability: CapabilityStatus): PluginMarketplaceEntry {
  return {
    id: capability.id,
    displayName: capability.displayName,
    description: capability.description,
    tier: 'official',
    source: `capability:${capability.id}`,
    builtIn: true,
  };
}

/**
 * Injection is part of the DEFAULT catalog experience only: any explicit
 * replacement (the slash-command source or a user-set env override) opts out
 * wholesale. The dev marketplace server started by scripts/dev.mjs serves
 * this repo's own catalog and marks itself, so it still counts as default.
 */
function isDefaultMarketplaceCatalog(
  source: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (source !== undefined) return false;
  if (env[KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV] === undefined) return true;
  return env['KIMI_CODE_PLUGIN_MARKETPLACE_FROM_DEV_SERVER'] === '1';
}

async function loadMarketplaceCatalog(
  host: SlashCommandHost,
  source: string | undefined,
  capabilities: readonly CapabilityStatus[],
): Promise<void> {
  try {
    const marketplace = await loadPluginMarketplace({
      workDir: host.state.appState.workDir,
      source,
      builtInEntries:
        host.engineV2 && isDefaultMarketplaceCatalog(source)
          ? capabilities.map(capabilityMarketplaceEntry)
          : undefined,
    });
    host.store?.setState('pluginsPanel', {
      marketplace: { plugins: marketplace.plugins, source: marketplace.source },
      marketplaceError: undefined,
      marketplaceLoading: false,
    });
  } catch (error) {
    host.store?.setState('pluginsPanel', {
      marketplaceError: formatErrorMessage(error),
      marketplaceLoading: false,
    });
  }
}

export async function showPluginMcpPicker(
  host: SlashCommandHost,
  id: string,
  options?: ShowPluginMcpPickerOptions,
): Promise<void> {
  let info: PluginInfo;
  try {
    info = await (await resolvePluginApi(host)).getPluginInfo(id);
  } catch (error) {
    host.showError(
      t('tui.statusMessages.pluginsFailedToLoadMcp', { error: formatErrorMessage(error) }),
    );
    return;
  }

  host.store?.setState('pluginMcpPicker', {
    info,
    selectedServer: options?.selectedServer,
    serverHint: options?.serverHint,
  });
  host.store?.setState('activeDialog', 'plugins-mcp');
}

async function confirmRemovePlugin(host: SlashCommandHost, id: string): Promise<boolean> {
  let displayName = id;
  try {
    displayName = (await (await resolvePluginApi(host)).getPluginInfo(id)).displayName;
  } catch {
    // Keep the confirmation available even when plugin details cannot be loaded.
  }

  return new Promise((resolveConfirmed) => {
    host.store?.setState('pluginConfirm', { kind: 'remove', id, displayName });
    host.store?.setState('activeDialog', 'plugins-confirm');
    host.store?.setState('pluginConfirmResolver', resolveConfirmed);
  });
}

async function confirmInstallTrust(
  host: SlashCommandHost,
  label: string,
  official: boolean,
): Promise<boolean> {
  // Kimi-built official plugins are trusted implicitly; anything else requires
  // the user to explicitly opt in via the trust prompt.
  if (official) return true;
  return new Promise((resolveConfirmed) => {
    host.store?.setState('pluginConfirm', { kind: 'trust', label });
    host.store?.setState('activeDialog', 'plugins-confirm');
    host.store?.setState('pluginConfirmResolver', resolveConfirmed);
  });
}

/** Resolve the open plugin confirmation (called by the confirm dialog). */
export function resolvePluginConfirm(host: SlashCommandHost, confirmed: boolean): void {
  const resolver = host.store?.state.pluginConfirmResolver;
  host.store?.setState('pluginConfirm', null);
  host.store?.setState('pluginConfirmResolver', undefined);
  host.store?.setState('activeDialog', null);
  resolver?.(confirmed);
}

const CAPABILITY_POLL_INTERVAL_MS = 700;
const CAPABILITY_POLL_ATTEMPTS = 260; // ~3 minutes of runtime setup budget

/** Client-injected v2 entries install their runtime and plugin together.
 * Trust keys on the parser-proof `builtIn` flag — the `capability:<id>`
 * source string stays purely diagnostic. */
function isCapabilityEntry(host: SlashCommandHost, entry: PluginMarketplaceEntry): boolean {
  return host.engineV2 && entry.builtIn === true;
}

/**
 * Closed-set plugin id check for the post-remove note. What must not happen
 * is answering membership by running `listCapabilities()`, which fires every
 * entry's detector (seconds of probes) just to print one hint line.
 */
function isCapabilityPluginId(host: SlashCommandHost, id: string): boolean {
  return host.engineV2 && (id === 'kimi-cu' || id === 'kimi-cu-win' || id === 'kimi-webbridge');
}

/** Poll a background capability install until it settles (or we run out of budget). */
async function pollCapabilityInstall(
  host: SlashCommandHost,
  id: string,
): Promise<CapabilityStatus | undefined> {
  const api = await resolveCapabilityApi(host);
  let previousProgress = '';
  for (let attempt = 0; attempt < CAPABILITY_POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, CAPABILITY_POLL_INTERVAL_MS);
    });
    const status = await api.getCapability(id);
    if (!status.install.running) return status;
    const progress = `${status.install.step ?? ''}:${status.install.percent ?? ''}`;
    if (progress !== previousProgress) {
      previousProgress = progress;
      log.info('capability install progress', {
        capabilityId: id,
        step: status.install.step,
        percent: status.install.percent,
      });
    }
  }
  return undefined;
}

export const __pluginsCommandInternals = {
  isCapabilityEntry,
  installCapabilityFromPanel,
  isDefaultMarketplaceCatalog,
  pollCapabilityInstall,
  removePlugin,
};

async function installCapabilityFromPanel(
  host: SlashCommandHost,
  entry: PluginMarketplaceEntry,
): Promise<void> {
  const label = entry.displayName;
  // Capability entries are official by construction; the trust prompt is
  // reserved for unreviewed third-party plugins.
  host.store?.setState('pluginsPanel', { installing: truncateForStatus(label) });
  const api = await resolveCapabilityApi(host);
  log.info('capability install requested', { capabilityId: entry.id });
  try {
    // An install already running (started from another panel or client) is
    // followed, not restarted — the service rejects duplicate starts even
    // though the original is healthy.
    const alreadyRunning = await api.getCapability(entry.id).then(
      (status) => status.install.running,
      () => false,
    );
    if (!alreadyRunning) {
      await api.installCapability(entry.id);
    } else {
      log.info('following running capability install', { capabilityId: entry.id });
    }
  } catch (error) {
    log.warn('capability install failed to start', { capabilityId: entry.id, error });
    host.store?.setState('pluginsPanel', { installing: undefined });
    host.showError(
      t('tui.statusMessages.pluginsFailedToInstall', { label, error: formatErrorMessage(error) }),
    );
    host.restoreEditor();
    return;
  }
  let result: CapabilityStatus | undefined;
  try {
    result = await pollCapabilityInstall(host, entry.id);
  } catch (error) {
    log.warn('capability install polling failed', { capabilityId: entry.id, error });
    result = undefined;
  }
  host.store?.setState('pluginsPanel', { installing: undefined });
  // Close the panel so the result lines land in the transcript, matching the
  // plain plugin install flow.
  host.restoreEditor();
  if (result === undefined) {
    host.showStatus(t('tui.statusMessages.pluginInstallStillRunning', { label }));
    return;
  }
  logCapabilityStatus(result);
  if (result.install.error !== undefined) {
    host.showError(
      t('tui.statusMessages.pluginInstallFailed', { label, error: result.install.error }),
    );
    host.showStatus(t('tui.statusMessages.pluginInstallFixHint'), 'warning');
    return;
  }
  if (result.state !== 'ready') {
    const permissionsRequired =
      entry.id === 'kimi-cu' &&
      result.steps.some((step) => step.id === 'permissions' && step.state !== 'ok');
    if (permissionsRequired) {
      host.showStatus(t('tui.statusMessages.pluginPermissionHint'), 'warning');
    } else {
      host.showError(t('tui.statusMessages.pluginInstallIncomplete', { label }));
    }
    host.showStatus(pluginReloadHint(), 'warning');
    return;
  }
  if (entry.id === 'kimi-webbridge') {
    host.showNotice(t('tui.statusMessages.pluginInstalled', { label }));
    host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'assistant',
      renderMode: 'markdown',
      content: WEBBRIDGE_POST_INSTALL_MARKDOWN,
    });
    return;
  }
  host.showStatus(t('tui.statusMessages.pluginInstalled', { label }));
  host.showStatus(pluginReloadHint(), 'warning');
}

async function installFromPanel(
  host: SlashCommandHost,
  source: string,
  label: string,
  official: boolean,
): Promise<void> {
  if (!(await confirmInstallTrust(host, label, official))) {
    host.showStatus(t('tui.statusMessages.pluginsInstallCancelledLabel', { label }));
    host.restoreEditor();
    return;
  }
  // Official installs keep the panel mounted and show the inline installing
  // state; third-party installs pass through a trust prompt that replaces the
  // panel, so fall back to a transcript status for those.
  if (official) {
    host.store?.setState('pluginsPanel', { installing: truncateForStatus(label) });
  } else {
    host.showStatus(t('tui.statusMessages.pluginsInstallingOrUpdating', { label }));
  }
  try {
    await installPluginFromSource(host, source);
  } catch (error) {
    if (official) {
      host.store?.setState('pluginsPanel', { installing: undefined });
    } else {
      // The trust prompt replaced the panel; re-mount it so the user can retry
      // instead of being dropped back at the editor.
      host.store?.setState('activeDialog', 'plugins-selector');
    }
    host.showError(
      t('tui.statusMessages.pluginsFailedToInstall', { label, error: formatErrorMessage(error) }),
    );
    return;
  }
  // Close the panel after installing so the result status and the
  // "/reload or /new" tip are visible in the transcript.
  host.restoreEditor();
}

async function applyPluginEnabled(
  host: SlashCommandHost,
  id: string,
  enabled: boolean,
  showStatus = true,
): Promise<string> {
  const session = await resolvePluginApi(host);
  await session.setPluginEnabled(id, enabled);
  let info: PluginInfo | undefined;
  try {
    info = await session.getPluginInfo(id);
  } catch {
    info = undefined;
  }
  const mcpHint =
    enabled && info !== undefined && info.mcpServerCount > info.enabledMcpServerCount
      ? t('tui.statusMessages.pluginsMcpDisabledHint', { id })
      : '';
  if (showStatus) {
    const enabledKey = enabled ? 'pluginsEnabled' : 'pluginsDisabled';
    host.showStatus(t(`tui.statusMessages.${enabledKey}`, { id }) + mcpHint);
  }
  const inlineMcpHint = mcpHint.length > 0 ? t('tui.statusMessages.pluginsInlineMcpDisabled') : '';
  return `${pluginInlineChangeHint()}${inlineMcpHint}`;
}

/** Handle a plugins-panel selection (called by the plugins-selector dialog). */
export async function handlePluginsPanelSelection(
  host: SlashCommandHost,
  selection: PluginsPanelSelection,
): Promise<void> {
  switch (selection.kind) {
    case 'toggle': {
      const hint = await applyPluginEnabled(host, selection.id, selection.enabled, false);
      await showPluginsPicker(host, {
        initialTab: 'installed',
        selectedId: selection.id,
        pluginHint: { id: selection.id, text: hint },
      });
      return;
    }
    case 'remove':
      if (!(await confirmRemovePlugin(host, selection.id))) {
        host.showStatus(t('tui.statusMessages.pluginsRemoveCancelled', { id: selection.id }));
        await showPluginsPicker(host, { initialTab: 'installed', selectedId: selection.id });
        return;
      }
      await removePlugin(host, selection.id);
      await showPluginsPicker(host, { initialTab: 'installed' });
      return;
    case 'mcp':
      await showPluginMcpPicker(host, selection.id);
      return;
    case 'details':
      host.restoreEditor();
      await renderPluginInfo(host, selection.id);
      return;
    case 'reload':
      await reloadPlugins(host);
      await showPluginsPicker(host, { initialTab: 'installed' });
      return;
    case 'install':
      if (isCapabilityEntry(host, selection.entry)) {
        await installCapabilityFromPanel(host, selection.entry);
        return;
      }
      await installFromPanel(
        host,
        selection.entry.source,
        selection.entry.displayName,
        isOfficialPluginSource(selection.entry.source),
      );
      return;
    case 'install-source':
      await installFromPanel(
        host,
        selection.source,
        selection.source,
        isOfficialPluginSource(selection.source),
      );
      return;
    case 'open-url':
      host.restoreEditor();
      openUrl(selection.url);
      host.showStatus(
        t('tui.statusMessages.pluginsOpeningPage', { label: selection.label }),
        'success',
      );
      host.showStatus(t('tui.statusMessages.pluginsIfNotOpened', { url: selection.url }));
      return;
  }
}

/** Handle a plugin-MCP selection (called by the plugin-mcp picker dialog). */
export async function handlePluginMcpSelection(
  host: SlashCommandHost,
  selection: PluginMcpSelection,
): Promise<void> {
  switch (selection.kind) {
    case 'toggle':
      await (
        await resolvePluginApi(host)
      ).setPluginMcpServerEnabled(selection.pluginId, selection.server, selection.enabled);
      await showPluginMcpPicker(host, selection.pluginId, {
        selectedServer: selection.server,
        serverHint: {
          server: selection.server,
          text: pluginInlineChangeHint(),
        },
      });
      return;
    case 'back':
      await showPluginsPicker(host, { selectedId: selection.pluginId });
      return;
  }
}

async function removePlugin(host: SlashCommandHost, id: string): Promise<void> {
  await (await resolvePluginApi(host)).removePlugin(id);
  host.showStatus(t('tui.statusMessages.pluginsRemoved', { id }));
  if (isCapabilityPluginId(host, id)) {
    host.showStatus(t('tui.statusMessages.pluginsRuntimeLeftUntouched'));
    return;
  }
  host.showStatus(pluginReloadHint(), 'warning');
}

async function renderPluginsList(
  host: SlashCommandHost,
  plugins?: readonly PluginSummary[],
): Promise<void> {
  const currentPlugins = plugins ?? (await (await resolvePluginApi(host)).listPlugins());
  host.appendTranscriptEntry({
    id: nextTranscriptId(),
    kind: 'status',
    renderMode: 'plain',
    content: buildPluginsListLines({ plugins: currentPlugins }).join('\n'),
  });
}

export async function renderPluginInfo(host: SlashCommandHost, id: string): Promise<void> {
  const info = await (await resolvePluginApi(host)).getPluginInfo(id);
  host.appendTranscriptEntry({
    id: nextTranscriptId(),
    kind: 'status',
    renderMode: 'plain',
    content: buildPluginsInfoLines({ info }).join('\n'),
  });
}

async function installPluginFromSource(host: SlashCommandHost, source: string): Promise<void> {
  const session = await resolvePluginApi(host);
  const beforeList = await session.listPlugins();
  const summary = await session.installPlugin(
    resolvePluginInstallSource(source, host.state.appState.workDir),
  );
  showPluginInstallResult(host, beforeList, summary);
}

function pluginReloadHint(): string {
  return t('tui.statusMessages.pluginsReloadHint');
}

const WEBBRIDGE_POST_INSTALL_MARKDOWN = [
  '*Two steps left to use Kimi WebBridge:*',
  '1. Install the browser extension',

  '',
  '   - [Chrome Web Store](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc)',
  '   - [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/kimi-webbridge/bnlffdbcfnanfbknnlaflhlhkocccckg)',
  '   - [Manual installation guide](https://www.kimi.com/code/docs/kimi-code-cli/customization/plugins.html#install-the-browser-extension)',
  '',
  '2. Run `/reload` or `/new` to apply it.',
].join('\n');

function showPluginInstallResult(
  host: SlashCommandHost,
  beforeList: readonly PluginSummary[],
  summary: PluginSummary,
): void {
  const previous = beforeList.find((entry) => entry.id === summary.id);
  const mcpCount = summary.mcpServerCount;
  const mcpHint =
    mcpCount > 0
      ? t(
          mcpCount === 1
            ? 'tui.statusMessages.pluginsDeclaresMcp_one'
            : 'tui.statusMessages.pluginsDeclaresMcp_other',
          { count: mcpCount },
        )
      : '';
  const action = describeInstallAction(previous, summary);
  host.showStatus(`${action} (${summary.id}).${mcpHint}`);
  host.showStatus(pluginReloadHint(), 'warning');
  // Gate on provenance, not just the id: a local/GitHub fork whose manifest
  // reuses a billed plugin's id is not the official quota-consuming build.
  if (QUOTA_CONSUMING_PLUGIN_IDS.includes(summary.id) && isOfficialPluginInstall(summary)) {
    host.showStatus(t('tui.statusMessages.pluginsQuotaNote'), 'warning');
  }
}

function describeInstallAction(previous: PluginSummary | undefined, next: PluginSummary): string {
  const sourceLabel = formatPluginSourceLabel(next);
  const versionFromTo = (prev?: string, cur?: string): string => {
    if (prev === undefined || prev === cur) return cur === undefined ? '' : ` ${cur}`;
    return ` ${prev} → ${cur ?? '-'}`;
  };
  if (previous === undefined) {
    return t('tui.statusMessages.pluginsInstalledDesc', {
      displayName: next.displayName,
      version: versionFromTo(undefined, next.version),
      sourcePhrase: sourcePhrase(sourceLabel),
    });
  }
  if (sourceIdentity(previous) !== sourceIdentity(next)) {
    const prevSourceLabel = formatPluginSourceLabel(previous);
    return t('tui.statusMessages.pluginsMigratedDesc', {
      displayName: next.displayName,
      prevSource: prevSourceLabel,
      source: sourceLabel,
      version: versionFromTo(previous.version, next.version),
    });
  }
  return t('tui.statusMessages.pluginsUpdatedDesc', {
    displayName: next.displayName,
    version: versionFromTo(previous.version, next.version),
    sourcePhrase: sourcePhrase(sourceLabel),
  });
}

// formatPluginSourceLabel already prefixes zip-url hosts with "via", so adding
// "from" would read as "from via <host>". Only prepend "from" otherwise.
function sourcePhrase(sourceLabel: string): string {
  if (sourceLabel.startsWith('via ')) {
    return t('tui.statusMessages.pluginsViaSource', { source: sourceLabel.slice(4) });
  }
  return t('tui.statusMessages.pluginsFromSource', { source: sourceLabel });
}

function sourceIdentity(plugin: PluginSummary): string {
  if (plugin.source === 'github' && plugin.github !== undefined) {
    return `github:${plugin.github.owner}/${plugin.github.repo}`;
  }
  return plugin.source;
}

function truncateForStatus(input: string): string {
  const max = 80;
  return input.length > max ? `${input.slice(0, max - 1)}…` : input;
}

async function reloadPlugins(host: SlashCommandHost): Promise<void> {
  const summary = await (await resolvePluginApi(host)).reloadPlugins();
  const line =
    t('tui.statusMessages.pluginsReloadResult', {
      added: summary.added.length,
      removed: summary.removed.length,
    }) +
    (summary.errors.length > 0
      ? t('tui.statusMessages.pluginsReloadResultErrors', { count: summary.errors.length })
      : '');
  host.showStatus(line);
  // Rebuild the TUI's plugin slash-command list from the reloaded service so
  // newly added/enabled commands resolve in this session-less UI right away.
  await host.refreshPluginCommands(host.session);
}

function resolvePluginInstallSource(source: string, workDir: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed === '~') return osHomedir();
  if (trimmed.startsWith('~/')) return join(osHomedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : resolve(workDir, trimmed);
}

function pluginInlineChangeHint(): string {
  return t('tui.statusMessages.pluginsInlineChangeHint');
}
