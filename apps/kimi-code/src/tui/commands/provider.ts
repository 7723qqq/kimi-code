import {
  applyCatalogProvider,
  catalogProviderModels,
  CatalogFetchError,
  RegistryImportError,
  type ImportCustomRegistryResult,
  DEFAULT_CATALOG_URL,
  removeProviderFromConfig,
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
  formatEffortList,
  planEditWrite,
  type PlanEditWriteResult,
  type ProviderFormModelRow,
  type ProviderFormValue,
} from '#/utils/provider-form';
import { isFormReadOnlyProvider, isProviderIdLocked } from '#/utils/provider-managed';
import { persistProviderWrite, providerSectionsOf } from '#/utils/provider-write';

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
import { formatErrorMessage } from '../utils/event-payload';
import { thinkingEffortToConfig } from '../utils/thinking-config';
import { effectiveModelForHost } from '../utils/model-switch';
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

/**
 * Drops one provider row. The managed OAuth provider never reaches this — the
 * manager's `buildRows` skips it (`provider-manager.ts`), because its account is
 * owned by `/login` and `/logout` instead, and no other caller deletes by id.
 */
async function handleProviderDelete(host: SlashCommandHost, providerId: string): Promise<void> {
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

  const handled =
    source === 'known'
      ? await handleCatalogProviderAdd(host)
      : source === 'manual'
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

async function handleCatalogProviderAdd(host: SlashCommandHost): Promise<boolean> {
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

  if (catalog === undefined) return false;

  const providerId = await promptCatalogProviderSelection(host, catalog);
  if (providerId === undefined) return false;
  const entry = catalog[providerId];
  if (entry === undefined) return false;

  const models = catalogProviderModels(entry);
  if (models.length === 0) {
    host.showError(t('tui.commands.provider.noUsableModels', { id: providerId }));
    return false;
  }

  let resolution = resolveCatalogImport(entry);
  if (resolution.kind === 'needs-base-url') {
    const entered = await promptBaseUrl(host, entry.name ?? providerId);
    if (entered === undefined) return false;
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
    return false;
  }
  const { wire, baseUrl } = resolution;

  const apiKey = await promptApiKey(host, entry.name ?? providerId);
  if (apiKey === undefined) return false;

  // Persist the provider and all its models immediately after the api key is
  // entered. The model selector that follows is just a convenience to pick the
  // default model; ESC leaves the provider in place without a default selection.
  //
  // Re-importing a provider replaces the record that is already there, which is
  // the remove-then-rebuild pair `persistProviderWrite` lands as ONE section
  // replace where the host can: an exit between a removal and its patch would
  // otherwise leave the provider and every alias it had gone from config.toml.
  let config = await host.harness.getConfig();
  const previousDefaultModel = config.defaultModel;
  const previousThinking = config.thinking;
  const replacing = config.providers[providerId] !== undefined;
  if (replacing) config = removeProviderFromConfig(config, providerId);
  applyCatalogProvider(config, {
    providerId,
    wire,
    baseUrl,
    apiKey,
    models,
    selectedModelId: '', // no default yet; user picks in the model selector
    thinking: false, // will be resolved by the model selector
  });
  const stillResolves =
    previousDefaultModel !== undefined && config.models?.[previousDefaultModel] !== undefined;
  config.defaultModel = stillResolves ? previousDefaultModel : undefined;
  config.thinking = previousThinking;

  try {
    await persistProviderWrite(host.harness, {
      patch: {
        providers: config.providers,
        models: config.models,
        defaultModel: config.defaultModel,
        thinking: config.thinking,
      },
      sections: providerSectionsOf(config),
      // Folded into `sections` already; a host without atomic sections still has
      // to cascade the old record away before the merge.
      removeProviderId: replacing ? providerId : undefined,
    });
    await host.authFlow.refreshConfigAfterLogin();
  } catch (error) {
    host.showError(
      t('tui.statusMessages.providerFormFailed', { error: formatErrorMessage(error) }),
    );
    return false;
  }

  host.track('connect', { provider: providerId, method: 'catalog' });
  host.showStatus(t('tui.commands.provider.added', { name: entry.name ?? providerId }));
  if (resolution.guessed) {
    host.showStatus(t('tui.commands.provider.protocolGuessed', { id: providerId }));
  }

  await mountProviderModelSelector(host, [providerId]);
  return true;
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
    await host.waitForSessionAssembly();
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
  const refreshed = await host.authFlow.refreshConfigAfterLogin(effort);
  // A mounted confirmation gate owns the whole switch — including the picked
  // effort — so the follow-up activation must not fire under the open dialog.
  const gateOwnsSwitch = refreshed === 'gated';
  let engineTrackedSwitch = refreshed === 'gated' ? true : refreshed;
  // refreshConfigAfterLogin reactivates from the persisted config, so a pick
  // the gate keeps session-only never reaches the runtime — apply it after
  // the refresh, or the persisted value would clobber it.
  if (!gateOwnsSwitch && thinking.effort === undefined && effort !== 'off' && effort !== 'on') {
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
    // Same key the CLI prints for the same import result, so a provider that
    // declares a credential env var reads identically in both front ends.
    host.showStatus(t('tui.statusMessages.providerCredentialEnvHint', { id, env: envName }));
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
  const rawModels = { ...(await host.harness.getConfig().then((c) => c.models ?? {})) };
  delete rawModels[SECONDARY_DERIVED_MODEL_ALIAS];
  const stateModels = Object.fromEntries(
    Object.entries(rawModels).map(([alias, model]) => [alias, effectiveModelForHost(host, model)]),
  );
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
 * explicit clear) and the write is planned as `removeProvider(previousId)`
 * followed by the patch — the pairing the catalog / registry paths use, because
 * only the removal drops the aliases a rename leaves behind.
 * `persistProviderWrite` lands that pair as one atomic section replace where
 * the host can, so the provider can no longer vanish from config.toml with its
 * replacement unwritten. A write that would take over another provider's id or
 * aliases is refused instead of applied.
 *
 * Every stored type is editable: the form carries one it does not offer
 * (`astron`) as an extra candidate, so the record keeps its transport instead
 * of being rewritten to `kimi`. Managed records — an `oauth` one, or an Open
 * Platform provider — open read-only instead of being refused, so the user can
 * still see what is configured and why it cannot be changed here.
 */
async function handleProviderEdit(host: SlashCommandHost, providerId: string): Promise<void> {
  const config = await host.harness.getConfig();
  let targetId = providerId;
  let provider = config.providers[targetId];
  if (provider === undefined) {
    // The list snapshot is stale (the provider is already gone): re-render.
    reopenProviderManager(host);
    return;
  }

  const groupIds = customRegistrySiblingIds(config, provider);
  if (groupIds.length > 1) {
    const picked = await promptGroupedProviderEditSelection(host, groupIds);
    if (picked === undefined) {
      reopenProviderManager(host);
      return;
    }
    targetId = picked;
    provider = config.providers[targetId];
    if (provider === undefined) {
      reopenProviderManager(host);
      return;
    }
  }

  const value = await promptProviderForm(host, {
    mode: 'edit',
    provider: {
      id: targetId,
      // The stored type verbatim, `astron` included: the form carries a type it
      // cannot offer as an extra `type` candidate instead of collapsing the
      // record onto one of its own six.
      type: provider.type,
      apiKey: provider.apiKey,
      apiKeyEnv: provider.apiKeyEnv,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      customHeaders: provider.customHeaders,
      env: provider.env,
      models: providerFormRows(config, targetId),
    },
    // Both kinds of managed record are read-only here. `oauth` alone would miss
    // the Open Platform providers — they are written with `oauth` dropped — and
    // renaming one orphans its credential while the next refresh re-adds the
    // original id beside the renamed copy. A registry import is the narrower
    // case: its models are re-fetched from the registry, so only the id it is
    // looked up by is closed to edits.
    readOnly: isFormReadOnlyProvider(targetId, provider),
    idLocked: isProviderIdLocked(targetId, provider),
  });
  if (value === undefined) {
    reopenProviderManager(host);
    return;
  }

  const plan = planEditWrite(config, value, targetId, {
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

  try {
    await persistProviderWrite(host.harness, plan);
    await host.authFlow.refreshConfigAfterLogin();
    host.showStatus(
      t('tui.statusMessages.providerFormUpdated', { id: value.id.trim() }),
      'success',
    );
  } catch (error) {
    host.showError(
      t('tui.statusMessages.providerFormFailed', { error: formatErrorMessage(error) }),
    );
  }
  reopenProviderManager(host);
}

function registryEntryKey(provider: KimiConfig['providers'][string]): string | undefined {
  const source = provider.source as
    | { readonly kind?: unknown; readonly url?: unknown; readonly apiKey?: unknown }
    | undefined;
  if (source?.kind !== 'apiJson') return undefined;
  if (typeof source.url !== 'string') return undefined;
  return `${source.url}\u0000${typeof source.apiKey === 'string' ? source.apiKey : ''}`;
}

function customRegistrySiblingIds(
  config: KimiConfig,
  provider: KimiConfig['providers'][string],
): string[] {
  const key = registryEntryKey(provider);
  if (key === undefined) return [];
  const ids: string[] = [];
  for (const [id, candidate] of Object.entries(config.providers)) {
    if (registryEntryKey(candidate) === key) ids.push(id);
  }
  return ids;
}

function promptGroupedProviderEditSelection(
  host: SlashCommandHost,
  providerIds: readonly string[],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('tui.statusMessages.selectProviderTitle'),
      options: providerIds.map((id) => ({ value: id, label: id })),
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
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
    // instead of clearing it. An empty capability list stays absent because the
    // engine has no way to tell `capabilities = []` from a missing key (both
    // read through `?? []`); a declared-empty EFFORT ladder is different — the
    // engine reads it as the `off-needs-offeffort` state — so it is presented as
    // the literal `[]` the form round-trips.
    if (alias.capabilities !== undefined && alias.capabilities.length > 0) {
      row.capabilities = [...alias.capabilities];
    }
    if (alias.maxInputSize !== undefined) row.maxInputSize = String(alias.maxInputSize);
    if (alias.maxOutputSize !== undefined) row.maxOutputSize = String(alias.maxOutputSize);
    if (alias.supportEfforts !== undefined) {
      row.supportEfforts = formatEffortList(alias.supportEfforts);
    }
    if (alias.defaultEffort !== undefined && alias.defaultEffort !== '') {
      row.defaultEffort = alias.defaultEffort;
    }
    if (alias.offEffort !== undefined && alias.offEffort !== '') row.offEffort = alias.offEffort;
    // Both declared states are carried: `adaptiveThinking === false` picks the
    // budget-effort ladder in the engine, so folding it into the toggle's
    // undeclared position is what used to make that state unreachable.
    if (alias.adaptiveThinking !== undefined) row.adaptiveThinking = alias.adaptiveThinking;
    if (alias.protocol !== undefined) row.protocol = alias.protocol;
    if (alias.betaApi !== undefined) row.betaApi = alias.betaApi;
    if (alias.reasoningKey !== undefined && alias.reasoningKey.trim() !== '') {
      row.reasoningKey = alias.reasoningKey.trim();
    }
    if (alias.baseUrl !== undefined && alias.baseUrl.trim() !== '') {
      row.baseUrl = alias.baseUrl.trim();
    }
    // Display-only: the form cannot edit the stored override layer, only drop it.
    if (alias.overrides !== undefined) row.hasStoredOverrides = true;
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
