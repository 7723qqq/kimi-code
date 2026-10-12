import {
  applyCatalogProvider,
  catalogProviderModels,
  CatalogFetchError,
  RegistryImportError,
  type ImportCustomRegistryResult,
  DEFAULT_CATALOG_URL,
  resolveCatalogImport,
  SECONDARY_DERIVED_MODEL_ALIAS,
  type Catalog,
  type KimiConfig,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';

import { createKimiCodeUserAgent } from '#/cli/version';
import { t } from '#/i18n';
import { fetchCatalogOrBuiltIn } from '#/utils/catalog-fetch';
import {
  buildAddPatch,
  planEditWrite,
  PROVIDER_WIRE_TYPES,
  type PlanEditWriteResult,
  type ProviderFormModelRow,
  type ProviderFormValue,
} from '#/utils/provider-form';
import { refreshKimiRegion } from '#/utils/region';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import {
  CustomRegistryImportDialogComponent,
  type CustomRegistryImportResult,
  type CustomRegistryImportValue,
} from '../components/dialogs/custom-registry-import';
import {
  ProviderFormDialogComponent,
  type ProviderFormDialogOptions,
} from '../components/dialogs/provider-form-dialog';
import {
  ProviderManagerComponent,
  type ProviderManagerOptions,
} from '../components/dialogs/provider-manager';
import { TabbedModelSelectorComponent } from '../components/dialogs/tabbed-model-selector';
import { DEFAULT_OAUTH_PROVIDER_NAME } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import { thinkingEffortToConfig } from '../utils/thinking-config';
import { effectiveModelForHost } from './config';
import type { SlashCommandHost } from './dispatch';
import { promptApiKey, promptBaseUrl, promptCatalogProviderSelection } from './prompts';

// ---------------------------------------------------------------------------
// /provider command
// ---------------------------------------------------------------------------

export async function handleProviderCommand(host: SlashCommandHost): Promise<void> {
  const options = buildProviderManagerOptions(host);
  const component = new ProviderManagerComponent(options);
  host.mountEditorReplacement(component);
}

function buildProviderManagerOptions(host: SlashCommandHost): ProviderManagerOptions {
  const activeProviderId = host.state.appState.availableModels[host.state.appState.model]?.provider;
  return {
    providers: host.state.appState.availableProviders,
    activeProviderId,
    onAdd: () => {
      void handleProviderAdd(host).catch((error: unknown) => {
        host.showError(t('tui.commands.provider.addFailed', { error: formatErrorMessage(error) }));
      });
    },
    onEdit: (providerId) => {
      void handleProviderEdit(host, providerId).catch((error: unknown) => {
        host.showError(
          t('tui.statusMessages.providerFormFailed', { error: formatErrorMessage(error) }),
        );
      });
    },
    onDeleteSource: (providerIds) => {
      void handleProviderManagerDeleteSource(host, providerIds).catch((error: unknown) => {
        host.showError(
          t('tui.commands.provider.removeFailed', { error: formatErrorMessage(error) }),
        );
      });
    },
    onClose: () => {
      host.restoreEditor();
    },
  };
}

async function handleProviderManagerDeleteSource(
  host: SlashCommandHost,
  providerIds: readonly string[],
): Promise<void> {
  for (const providerId of providerIds) {
    try {
      await handleProviderDelete(host, providerId);
    } catch (error) {
      const msg = formatErrorMessage(error);
      host.showError(t('tui.commands.provider.deleteFailed', { id: providerId, error: msg }));
    }
  }
  reopenProviderManager(host);
}

async function handleProviderDelete(host: SlashCommandHost, providerId: string): Promise<void> {
  if (providerId === DEFAULT_OAUTH_PROVIDER_NAME) {
    await host.harness.auth.logout(DEFAULT_OAUTH_PROVIDER_NAME);
    // Drop the process-wide region cache with the credential: derived
    // endpoints (updates, marketplace, site links, telemetry) must fall back
    // to the marker/default profile, not the logged-out region.
    refreshKimiRegion();
    await host.authFlow.refreshConfigAfterLogout();
    return;
  }

  const activeProvider = host.state.appState.availableModels[host.state.appState.model]?.provider;
  const config = await host.harness.removeProvider(providerId);
  if (activeProvider === providerId) {
    await host.authFlow.refreshConfigAfterLogout();
  } else {
    host.setAppState({
      availableProviders: config.providers ?? {},
      availableModels: config.models ?? {},
    });
  }
}

async function handleProviderAdd(host: SlashCommandHost): Promise<void> {
  const source = await promptProviderAddSource(host);
  if (source === undefined) {
    reopenProviderManager(host);
    return;
  }

  if (source === 'known') {
    await handleCatalogProviderAdd(host);
    return;
  }
  const handled =
    source === 'manual'
      ? await handleManualProviderAdd(host)
      : await handleCustomRegistryAddViaDialog(host);
  if (!handled) {
    reopenProviderManager(host);
  }
}

function reopenProviderManager(host: SlashCommandHost): void {
  const options = buildProviderManagerOptions(host);
  const component = new ProviderManagerComponent(options);
  host.mountEditorReplacement(component);
}

function promptProviderAddSource(
  host: SlashCommandHost,
): Promise<'known' | 'custom' | 'manual' | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('tui.commands.provider.addTitle'),
      options: [
        { value: 'known', label: t('tui.statusMessages.knownThirdPartyProvider') },
        { value: 'custom', label: t('tui.statusMessages.customRegistryOption') },
        { value: 'manual', label: t('tui.statusMessages.manualProviderOption') },
      ],
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value === 'known' || value === 'custom' || value === 'manual' ? value : undefined);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

async function handleCatalogProviderAdd(host: SlashCommandHost): Promise<void> {
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancel;

  const spinner = host.showLoginProgressSpinner(
    t('tui.commands.provider.fetchingCatalog', { url: DEFAULT_CATALOG_URL }),
  );
  let catalog: Catalog | undefined;
  try {
    const loaded = await fetchCatalogOrBuiltIn(DEFAULT_CATALOG_URL, {
      signal: controller.signal,
      userAgent: createKimiCodeUserAgent(),
    });
    catalog = loaded.catalog;
    spinner.stop({
      ok: true,
      label: loaded.fromBuiltIn
        ? t('tui.statusMessages.catalogFromBuiltIn')
        : t('tui.statusMessages.catalogLoaded'),
    });
  } catch (error) {
    if (controller.signal.aborted) {
      spinner.stop({ ok: false, label: t('tui.commands.provider.aborted') });
    } else {
      spinner.stop({ ok: false, label: t('tui.statusMessages.catalogFailedToLoad') });
      const message = formatErrorMessage(error);
      if (error instanceof CatalogFetchError) {
        host.showError(
          t('tui.commands.provider.fetchCatalogFailedWithStatus', {
            status: error.status,
            error: message,
          }),
        );
      } else {
        host.showError(t('tui.commands.provider.fetchCatalogFailed', { error: message }));
      }
    }
  } finally {
    if (host.cancelInFlight === cancel) host.cancelInFlight = undefined;
  }

  if (catalog === undefined) return;

  const providerId = await promptCatalogProviderSelection(host, catalog);
  if (providerId === undefined) return;
  const entry = catalog[providerId];
  if (entry === undefined) return;

  const models = catalogProviderModels(entry);
  if (models.length === 0) {
    host.showError(t('tui.commands.provider.noUsableModels', { id: providerId }));
    return;
  }

  let resolution = resolveCatalogImport(entry);
  if (resolution.kind === 'needs-base-url') {
    const entered = await promptBaseUrl(host, entry.name ?? providerId);
    if (entered === undefined) return;
    resolution = resolveCatalogImport(entry, entered);
  }
  if (resolution.kind !== 'ok') {
    if (resolution.kind === 'invalid') {
      if (resolution.reason === 'unknown-explicit-type') {
        host.showError(
          t('tui.commands.provider.unsupportedProtocol', {
            id: providerId,
            type: entry.type ?? '',
          }),
        );
      } else if (resolution.reason === 'proprietary-sdk') {
        host.showError(t('tui.commands.provider.proprietarySdk', { id: providerId }));
      } else {
        host.showError(t('tui.statusMessages.providerCatalogPlaceholderBaseUrl'));
      }
    }
    return;
  }
  const { wire, baseUrl } = resolution;

  const apiKey = await promptApiKey(host, entry.name ?? providerId);
  if (apiKey === undefined) return;

  // Persist the provider and all its models immediately after the api key is
  // entered. The model selector that follows is just a convenience to pick the
  // default model; ESC leaves the provider in place without a default selection.
  const existingConfig = await host.harness.getConfig();
  if (existingConfig.providers[providerId] !== undefined) {
    await host.harness.removeProvider(providerId);
  }

  const config = await host.harness.getConfig();
  applyCatalogProvider(config, {
    providerId,
    wire,
    baseUrl,
    apiKey,
    models,
    selectedModelId: '', // no default yet; user picks in the model selector
    thinking: false, // will be resolved by the model selector
  });

  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.track('connect', { provider: providerId, method: 'catalog' });
  host.showStatus(t('tui.commands.provider.added', { name: entry.name ?? providerId }));
  if (resolution.guessed) {
    host.showStatus(t('tui.commands.provider.protocolGuessed', { id: providerId }));
  }

  // Build a merged model dictionary that includes existing models plus the
  // newly-persisted provider's models, so the tabbed selector shows every
  // provider's tab (the new provider's tab starts active via initialTabId).
  // The v1 runtime may carry the synthesized `__secondary__` derived entry —
  // never selectable in a picker.
  const stateModels = await host.harness.getConfig().then((c) => c.models ?? {});
  const mergedModels = { ...stateModels };
  delete mergedModels[SECONDARY_DERIVED_MODEL_ALIAS];

  const selector = new TabbedModelSelectorComponent({
    models: mergedModels,
    currentValue: host.state.appState.model,
    selectedValue: Object.keys(mergedModels).find((a) => a.startsWith(`${providerId}/`)),
    currentThinkingEffort: host.state.appState.thinkingEffort,
    initialTabId: providerId,
    onSelect: ({ alias, thinking }) => {
      host.restoreEditor();
      void setDefaultModel(host, alias, thinking).catch((error: unknown) => {
        host.showError(
          t('tui.commands.provider.setDefaultModelFailed', { error: formatErrorMessage(error) }),
        );
      });
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(selector);
}

export async function setDefaultModel(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
): Promise<void> {
  // Resolve efforts the same way the /model path does (effectiveModelForHost
  // applies overrides and the protocol-profile inference): catalog entries for
  // e.g. Anthropic models declare no support_efforts on the alias, and without
  // the inference an above-default pick would slip through as a persisted effort.
  const model = host.state.appState.availableModels[alias];
  const thinking = thinkingEffortToConfig(
    effort,
    model === undefined ? undefined : effectiveModelForHost(host, model),
  );
  if (host.session === undefined) {
    // A first prompt may still be inside lazy creation: wait it out so the
    // pick lands on the new session instead of racing its assembly (same
    // coordination as the /model path).
    await host.waitForLazyCreation();
  }
  await host.harness.setConfig({
    defaultModel: alias,
    thinking,
  });
  // Whether activation made the engine emit model_switch (it reached a live
  // session AND changed the bound alias — both engines track only an actual
  // change). Recorded at activation time rather than snapshotted at entry: a
  // lazy session can come live while the config writes above are pending; a
  // session created BY activation (v1) or a same-alias rebind does not count
  // — both bind the model without an engine event.
  let engineTrackedSwitch = await host.authFlow.refreshConfigAfterLogin();
  // refreshConfigAfterLogin reactivates from the persisted config, so a pick
  // the gate keeps session-only never reaches the runtime — apply it after
  // the refresh, or the persisted value would clobber it.
  if (thinking.effort === undefined && effort !== 'off' && effort !== 'on') {
    engineTrackedSwitch =
      (await host.authFlow.activateModelAfterLogin(alias, effort)) || engineTrackedSwitch;
  }
  // When the engine never emitted (no live session, or the alias was already
  // bound), the TUI stays the sole producer for the pick.
  if (!engineTrackedSwitch) {
    host.track('model_switch', { model: alias });
  }
  host.showStatus(t('tui.commands.provider.defaultModelSet', { model: alias, effort }));
}

async function handleCustomRegistryAddViaDialog(host: SlashCommandHost): Promise<boolean> {
  const value = await promptCustomRegistryImport(host);
  if (value === undefined) return false;

  let result: ImportCustomRegistryResult;
  try {
    result = await host.harness.importCustomRegistry({
      url: value.url,
      apiKey: value.apiKey,
      setDefaultWhenUnset: false,
    });
  } catch (error) {
    if (error instanceof RegistryImportError && error.phase === 'empty') {
      host.showStatus(t('tui.commands.provider.registryEmpty'));
      return false;
    }
    const phase =
      error instanceof RegistryImportError && error.phase === 'fetch' ? 'import' : 'apply';
    host.showError(
      t(
        phase === 'import'
          ? 'tui.commands.provider.importRegistryFailed'
          : 'tui.commands.provider.applyRegistryFailed',
        { error: formatErrorMessage(error) },
      ),
    );
    if (
      value.apiKey === undefined &&
      error instanceof RegistryImportError &&
      (error.status === 401 || error.status === 403)
    ) {
      host.showStatus(t('tui.commands.provider.registryAuthRequired'), 'warning');
    }
    return false;
  }
  try {
    await host.authFlow.refreshConfigAfterLogin();
  } catch (error) {
    host.showError(
      t('tui.commands.provider.applyRegistryFailed', { error: formatErrorMessage(error) }),
    );
    return false;
  }
  const addedProviderIds = result.providers.map((provider) => provider.id);
  const count = addedProviderIds.length;
  host.showStatus(
    t(count === 1 ? 'tui.commands.provider.importedOne' : 'tui.commands.provider.importedMany', {
      count,
    }),
    'success',
  );
  for (const [id, envName] of Object.entries(result.credentialEnv)) {
    host.showStatus(
      `provider "${id}" declares credential env var "${envName}" — set api_key_env in config.toml to use it`,
    );
  }

  await mountProviderModelSelector(host, addedProviderIds);
  return true;
}

/**
 * End every add flow with the model selector so the user can pick the new
 * provider's default model. Copy without the v1-synthesized `__secondary__`
 * derived entry — never selectable in a picker. The initial tab is the first
 * new provider's own tab, falling back to the first id when the refreshed
 * config carried no alias for it yet.
 */
async function mountProviderModelSelector(
  host: SlashCommandHost,
  providerIds: readonly string[],
): Promise<void> {
  const stateModels = { ...(await host.harness.getConfig().then((c) => c.models ?? {})) };
  delete stateModels[SECONDARY_DERIVED_MODEL_ALIAS];
  const firstNewAlias = Object.keys(stateModels).find((alias) =>
    providerIds.some((providerId) => alias.startsWith(`${providerId}/`)),
  );
  const firstNewProvider =
    firstNewAlias === undefined ? undefined : stateModels[firstNewAlias]?.provider;
  const selector = new TabbedModelSelectorComponent({
    models: stateModels,
    currentValue: host.state.appState.model,
    selectedValue: firstNewAlias,
    currentThinkingEffort: host.state.appState.thinkingEffort,
    initialTabId: firstNewProvider ?? providerIds[0],
    onSelect: ({ alias, thinking }) => {
      host.restoreEditor();
      void setDefaultModel(host, alias, thinking).catch((error: unknown) => {
        host.showError(
          t('tui.commands.provider.setDefaultModelFailed', { error: formatErrorMessage(error) }),
        );
      });
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(selector);
}

/**
 * Manual entry (`/provider` → add → manual): persist the hand-filled provider
 * plus its aliases in one `setConfig`, refresh the runtime, then offer the same
 * default-model selector the catalog / registry paths end with. Returns false
 * when the user cancelled, the id is taken, or the write failed, so the caller
 * restores the list.
 */
async function handleManualProviderAdd(host: SlashCommandHost): Promise<boolean> {
  const value = await promptProviderForm(host, { mode: 'add' });
  if (value === undefined) return false;

  // `setConfig` merges, so writing an id that already exists would silently
  // rewrite that provider's fields instead of adding a new one.
  const id = value.id.trim();
  const current = await host.harness.getConfig();
  if (current.providers[id] !== undefined) {
    host.showError(
      t('tui.statusMessages.providerFormFailed', { error: refusalMessage('idTaken', [id]) }),
    );
    return false;
  }

  try {
    await host.harness.setConfig(buildAddPatch(value));
    await host.authFlow.refreshConfigAfterLogin();
  } catch (error) {
    host.showError(
      t('tui.statusMessages.providerFormFailed', { error: formatErrorMessage(error) }),
    );
    return false;
  }

  host.track('connect', { provider: id, method: 'manual' });
  host.showStatus(t('tui.statusMessages.providerFormAdded', { id }), 'success');
  await mountProviderModelSelector(host, [id]);
  return true;
}

/**
 * Edit an existing provider from the `/provider` list (`E`). The form is
 * prefilled from the live config (API key included, so blanking it out is an
 * explicit clear) and the write is `removeProvider(previousId)` followed by the
 * patch — the v1-compatible pairing the catalog / registry paths use, because
 * only the removal drops the aliases a rename leaves behind. A write that would
 * take over another provider's id or aliases is refused instead of applied.
 */
async function handleProviderEdit(host: SlashCommandHost, providerId: string): Promise<void> {
  const config = await host.harness.getConfig();
  const provider = config.providers[providerId];
  if (provider === undefined) {
    // The list snapshot is stale (the provider is already gone): re-render.
    reopenProviderManager(host);
    return;
  }
  const type = PROVIDER_WIRE_TYPES.find((wire) => wire === provider.type);
  if (type === undefined) {
    // The form only knows the six wire types and would rewrite the record's
    // type to its first entry; refuse rather than silently change it.
    host.showError(
      t('tui.commands.provider.unsupportedProtocol', { id: providerId, type: provider.type }),
    );
    reopenProviderManager(host);
    return;
  }

  const value = await promptProviderForm(host, {
    mode: 'edit',
    provider: {
      id: providerId,
      type,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      models: providerFormRows(config, providerId),
      oauth: provider.oauth,
    },
  });
  if (value === undefined) {
    reopenProviderManager(host);
    return;
  }

  const plan = planEditWrite(config, value, providerId, {
    // A stored credential the user blanked out means "clear it"; a provider
    // that never had one keeps the key out of the written record.
    clearApiKey: provider.apiKey !== undefined && value.apiKey.trim() === '',
  });
  if (plan.providerIdTaken || plan.collisions.length > 0) {
    host.showError(
      t('tui.statusMessages.providerFormFailed', {
        error: refusalMessage(
          plan.providerIdTaken ? 'idTaken' : 'aliasConflict',
          conflictingKeys(plan, value.id.trim()),
        ),
      }),
    );
    reopenProviderManager(host);
    return;
  }

  await host.harness.removeProvider(plan.removeProviderId);
  await host.harness.setConfig(plan.patch);
  await host.authFlow.refreshConfigAfterLogin();
  host.showStatus(t('tui.statusMessages.providerFormUpdated', { id: value.id.trim() }), 'success');
  reopenProviderManager(host);
}

/**
 * The keys the refused write would have taken over, for the error text: the new
 * provider id when another provider already uses it, plus every alias key that
 * still belongs to someone else. Formatted like `demo2, demo2/gpt-4.1`.
 */
function conflictingKeys(plan: PlanEditWriteResult, newId: string): string[] {
  return plan.providerIdTaken ? [newId, ...plan.collisions] : plan.collisions;
}

/** Write-guard refusals: form-level, but not `ProviderFormError` codes. */
const PROVIDER_WRITE_REFUSAL_KEYS = {
  idTaken: 'tui.dialogs.providerForm.error.idTaken',
  aliasConflict: 'tui.dialogs.providerForm.error.aliasConflict',
} as const;

/** The localized reason followed by the keys it collided with, e.g. `… (demo2)`. */
function refusalMessage(
  code: keyof typeof PROVIDER_WRITE_REFUSAL_KEYS,
  keys: readonly string[],
): string {
  return `${t(PROVIDER_WRITE_REFUSAL_KEYS[code])} (${keys.join(', ')})`;
}

/** Edit-mode prefill: one row per alias whose `provider` points at the id. */
function providerFormRows(config: KimiConfig, providerId: string): ProviderFormModelRow[] {
  const rows: ProviderFormModelRow[] = [];
  for (const alias of Object.values(config.models ?? {})) {
    if (alias.provider !== providerId) continue;
    const row: ProviderFormModelRow = {
      model: alias.model,
      maxContextSize: String(alias.maxContextSize),
      displayName: alias.displayName ?? '',
    };
    // Only what the alias actually declares is presented: `undefined` means
    // "the form does not own this field", so the write keeps the stored value
    // instead of clearing it. An empty list stays absent for the same reason —
    // `[]` and an omitted key mean different things to the engine, and the form
    // cannot write the former back on purpose.
    if (alias.capabilities !== undefined && alias.capabilities.length > 0) {
      row.capabilities = [...alias.capabilities];
    }
    if (alias.maxInputSize !== undefined) row.maxInputSize = String(alias.maxInputSize);
    if (alias.maxOutputSize !== undefined) row.maxOutputSize = String(alias.maxOutputSize);
    if (alias.supportEfforts !== undefined && alias.supportEfforts.length > 0) {
      row.supportEfforts = alias.supportEfforts.join(', ');
    }
    if (alias.defaultEffort !== undefined && alias.defaultEffort !== '') {
      row.defaultEffort = alias.defaultEffort;
    }
    if (alias.offEffort !== undefined && alias.offEffort !== '') row.offEffort = alias.offEffort;
    // `adaptiveThinking === false` picks the budget-effort ladder in the
    // engine, so a row merely showing the toggle off must not overwrite it:
    // only an explicit `true` is presented, and `undefined` keeps the rest.
    if (alias.adaptiveThinking === true) row.adaptiveThinking = true;
    rows.push(row);
  }
  return rows;
}

function promptProviderForm(
  host: SlashCommandHost,
  options: ProviderFormDialogOptions,
): Promise<ProviderFormValue | undefined> {
  return new Promise((resolve) => {
    const dialog = new ProviderFormDialogComponent((result) => {
      host.restoreEditor();
      resolve(result.kind === 'ok' ? result.value : undefined);
    }, options);
    host.mountEditorReplacement(dialog);
  });
}

function promptCustomRegistryImport(
  host: SlashCommandHost,
): Promise<CustomRegistryImportValue | undefined> {
  return new Promise((resolve) => {
    const dialog = new CustomRegistryImportDialogComponent((result: CustomRegistryImportResult) => {
      host.restoreEditor();
      resolve(result.kind === 'ok' ? result.value : undefined);
    });
    host.mountEditorReplacement(dialog);
  });
}
