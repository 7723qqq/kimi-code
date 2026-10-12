/**
 * `kimi provider` sub-command — non-interactive provider management.
 *
 * Mirrors the TUI `/provider` flow (apps/kimi-code/src/tui/commands/provider.ts)
 * for the custom-registry path so users can import an api.json document, drop
 * a provider, or inspect what is configured without launching the TUI.
 *
 * `add` writes the same `source = { kind: 'apiJson', url, apiKey }` blob the
 * TUI does; the next launch's `refreshAllProviderModels`
 * (apps/kimi-code/src/tui/utils/refresh-providers.ts) groups by URL, retries
 * available API-key candidates, and re-fetches the model list, so periodic
 * refresh is automatic.
 *
 * `create` / `update` are the non-interactive twin of the TUI's manual
 * provider form: both build the same form value and hand it to the shared
 * `utils/provider-form.ts` module, so the CLI and the TUI validate and write
 * a hand-typed provider identically. One flag per optional model field, and
 * the row follows the shared three-state rule: a flag that was not given
 * leaves the field `undefined` (an edit keeps the stored value), a blank flag
 * clears the stored key.
 */

import {
  applyCatalogProvider,
  catalogProviderModels,
  CatalogFetchError,
  RegistryImportError,
  type ImportCustomRegistryResult,
  createKimiHarness,
  DEFAULT_CATALOG_URL,
  resolveCatalogImport,
  type Catalog,
  type CatalogProviderEntry,
  type KimiConfig,
  type KimiHarness,
} from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';

import { createKimiCodeHostIdentity, createKimiCodeUserAgent } from '#/cli/version';
import { t, type TranslationKey } from '#/i18n';
import { fetchCatalogOrBuiltIn } from '#/utils/catalog-fetch';
import {
  buildAddPatch,
  CAPABILITY_NAMES,
  parseList,
  planEditWrite,
  PROVIDER_WIRE_TYPES,
  validateProviderForm,
  type ProviderFormError,
  type ProviderFormModelRow,
  type ProviderFormValue,
  type ProviderWireType,
} from '#/utils/provider-form';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface ProviderDeps {
  readonly getHarness: () => KimiHarness;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly env: NodeJS.ProcessEnv;
  readonly exit: (code: number) => never;
}

interface AddOptions {
  readonly apiKey?: string;
}

interface ListOptions {
  readonly json: boolean;
}

interface CatalogListOptions {
  readonly json: boolean;
  readonly filter?: string;
  readonly url?: string;
}

interface CatalogAddOptions {
  readonly apiKey?: string;
  readonly defaultModel?: string;
  readonly url?: string;
  readonly baseUrl?: string;
}

interface CreateOptions {
  readonly id?: string;
  readonly type?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly maxContextSize?: string;
  readonly displayName?: string;
  /**
   * The optional model-row fields. Absent means "the user did not name this
   * field": nothing is written for a new row and the stored value survives on
   * an edited one. An explicitly blank flag clears the key instead (see
   * `applyOptionalNumber` in `utils/provider-form.ts` for the three states).
   */
  readonly maxInputSize?: string;
  readonly maxOutputSize?: string;
  readonly capabilities?: string;
  readonly supportEfforts?: string;
  readonly defaultEffort?: string;
  readonly offEffort?: string;
  /** `--adaptive-thinking` sets it, `--no-adaptive-thinking` clears it, neither keeps it. */
  readonly adaptiveThinking?: boolean;
  readonly default?: boolean;
  readonly json?: boolean;
}

interface UpdateOptions extends CreateOptions {
  readonly newId?: string;
}

/** A validated form value plus the model row a caller's `--default` refers to. */
interface ProviderFormInput {
  readonly value: ProviderFormValue;
  readonly model: string;
}

export async function handleProviderAdd(
  deps: ProviderDeps,
  url: string,
  opts: AddOptions,
): Promise<void> {
  const apiKey = resolveApiKey(opts.apiKey, deps.env);

  const trimmedUrl = url.trim();
  if (trimmedUrl.length === 0) {
    deps.stderr.write(t('tui.statusMessages.providerUrlRequired') + '\n');
    deps.exit(1);
  }

  const harness = deps.getHarness();
  await harness.ensureConfigFile();

  let result: ImportCustomRegistryResult;
  try {
    result = await harness.importCustomRegistry({
      url: trimmedUrl,
      apiKey,
      setDefaultWhenUnset: false,
    });
  } catch (error) {
    if (!(error instanceof RegistryImportError) || error.phase === 'apply') throw error;
    if (error.phase === 'empty') {
      deps.stderr.write(t('tui.statusMessages.providerNoUsable', { url: trimmedUrl }) + '\n');
      deps.exit(1);
    }
    const suffix = error.status === undefined ? '' : ` (HTTP ${String(error.status)})`;
    deps.stderr.write(
      t('tui.statusMessages.providerFetchFailed', { suffix, error: errorMessage(error) }) + '\n',
    );
    if (apiKey === undefined && (error.status === 401 || error.status === 403)) {
      deps.stderr.write(t('tui.statusMessages.providerAuthRequired') + '\n');
    }
    deps.exit(1);
  }

  const count = result.providers.length;
  deps.stdout.write(
    t('tui.statusMessages.providerMultipleImported', {
      count,
      plural: count === 1 ? '' : 's',
      modelCount: result.modelsImported,
      modelPlural: result.modelsImported === 1 ? '' : 's',
      url: trimmedUrl,
    }) + '\n',
  );
  for (const provider of result.providers) {
    deps.stdout.write(`  - ${provider.id}\n`);
  }
  for (const [id, envName] of Object.entries(result.credentialEnv)) {
    deps.stdout.write(
      t('tui.statusMessages.providerCredentialEnvHint', { id, env: envName }) + '\n',
    );
  }
}

export async function handleProviderRemove(deps: ProviderDeps, providerId: string): Promise<void> {
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();
  if (config.providers[providerId] === undefined) {
    deps.stderr.write(t('tui.statusMessages.providerNotFound', { id: providerId }) + '\n');
    deps.exit(1);
  }
  await harness.removeProvider(providerId);
  deps.stdout.write(t('tui.statusMessages.providerRemoved', { id: providerId }) + '\n');
}

/**
 * Adds a provider and one model row typed on the command line. Everything the
 * flags carry goes through the shared form module, so a rejection here reads
 * exactly like the TUI form's inline error and the config stays untouched.
 */
export async function handleProviderCreate(deps: ProviderDeps, opts: CreateOptions): Promise<void> {
  const input = createFormInput(deps, opts);

  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const providerId = input.value.id.trim();
  // `setConfig` merges, so writing an id that already exists would silently
  // rewrite that provider instead of adding a new one.
  const current = await harness.getConfig();
  if (current.providers[providerId] !== undefined) {
    deps.stderr.write(refusalMessage('idTaken', [providerId]) + '\n');
    deps.exit(1);
  }
  const patch = buildAddPatch(input.value);
  if (opts.default === true) {
    patch.defaultModel = `${providerId}/${input.model}`;
  }
  await harness.setConfig(patch);

  reportProviderWrite(
    deps,
    await harness.getConfig(),
    providerId,
    'tui.statusMessages.providerFormAdded',
    opts.json === true,
  );
}

/**
 * Updates a provider in place: fields the flags omit keep their stored value
 * and `--model` upserts one row into the existing set. The write mirrors the
 * TUI edit path — remove first (it cascades the old aliases and any dangling
 * default pointers), then apply the planned patch.
 */
export async function handleProviderUpdate(
  deps: ProviderDeps,
  providerId: string,
  opts: UpdateOptions,
): Promise<void> {
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const current = await harness.getConfig();
  const previous = current.providers[providerId];
  if (previous === undefined) {
    deps.stderr.write(t('tui.statusMessages.providerNotFound', { id: providerId }) + '\n');
    deps.exit(1);
  }

  const input = updateFormInput(deps, opts, providerId, current, previous);
  const plan = planEditWrite(current, input.value, providerId, {
    // An explicitly empty `--api-key ''` clears the stored credential; an
    // omitted flag keeps it.
    clearApiKey: opts.apiKey !== undefined && opts.apiKey.trim() === '',
  });
  if (plan.providerIdTaken || plan.collisions.length > 0) {
    const keys = plan.providerIdTaken
      ? [input.value.id.trim(), ...plan.collisions]
      : plan.collisions;
    deps.stderr.write(
      refusalMessage(plan.providerIdTaken ? 'idTaken' : 'aliasConflict', keys) + '\n',
    );
    deps.exit(1);
  }

  const patch = plan.patch;
  if (opts.default === true) {
    patch.defaultModel = `${input.value.id.trim()}/${input.model}`;
  }
  await harness.removeProvider(plan.removeProviderId);
  await harness.setConfig(patch);

  reportProviderWrite(
    deps,
    await harness.getConfig(),
    input.value.id.trim(),
    'tui.statusMessages.providerFormUpdated',
    opts.json === true,
  );
}

/**
 * The submission result of both manual commands: the provider id with its
 * model aliases, sanitized the way `provider list --json` strips secrets.
 */
function reportProviderWrite(
  deps: ProviderDeps,
  config: KimiConfig,
  providerId: string,
  messageKey: TranslationKey,
  json: boolean,
): void {
  if (json) {
    deps.stdout.write(
      `${JSON.stringify(
        {
          providers: sanitizeProvidersForOutput(config.providers),
          models: config.models ?? {},
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  deps.stdout.write(t(messageKey, { id: providerId }) + '\n');
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if (model.provider === providerId) deps.stdout.write(`  - ${alias}\n`);
  }
}

/** One locale key per `validateProviderForm` code, shared with the TUI form. */
const PROVIDER_FORM_ERROR_KEYS: Record<ProviderFormError, TranslationKey> = {
  idRequired: 'tui.dialogs.providerForm.error.idRequired',
  idInvalid: 'tui.dialogs.providerForm.error.idInvalid',
  apiKeyRequired: 'tui.dialogs.providerForm.error.apiKeyRequired',
  baseUrlRequired: 'tui.dialogs.providerForm.error.baseUrlRequired',
  modelRequired: 'tui.dialogs.providerForm.error.modelRequired',
  contextSizeRequired: 'tui.dialogs.providerForm.error.contextSizeRequired',
  contextSizeInvalid: 'tui.dialogs.providerForm.error.contextSizeInvalid',
  modelDuplicate: 'tui.dialogs.providerForm.error.modelDuplicate',
  capabilityUnknown: 'tui.dialogs.providerForm.error.capabilityUnknown',
  defaultEffortNotSupported: 'tui.dialogs.providerForm.error.defaultEffortNotSupported',
};

function rejectProviderForm(deps: ProviderDeps, error: ProviderFormError): never {
  deps.stderr.write(t(PROVIDER_FORM_ERROR_KEYS[error]) + '\n');
  deps.exit(1);
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

/**
 * `--type` must name one of the six wire types the form offers. No key exists
 * for the rejection itself, so the option description — which enumerates the
 * accepted values — is what the user reads.
 */
function resolveWireType(deps: ProviderDeps, raw: string | undefined): ProviderWireType {
  const wireType = PROVIDER_WIRE_TYPES.find((candidate) => candidate === raw);
  if (wireType === undefined) {
    deps.stderr.write(t('cli.optionDescriptions.providerCreateType') + '\n');
    deps.exit(1);
  }
  return wireType;
}

const POSITIVE_INTEGER_PATTERN = /^\d+$/;

/** The flags that describe one model row — the row `--model` names. */
const MODEL_ROW_OPTION_KEYS = [
  'maxContextSize',
  'displayName',
  'maxInputSize',
  'maxOutputSize',
  'capabilities',
  'supportEfforts',
  'defaultEffort',
  'offEffort',
  'adaptiveThinking',
] as const satisfies readonly (keyof CreateOptions)[];

/**
 * A token-count flag. Absent keeps `previous` (which is `undefined` when the
 * flag belongs to a brand-new row); blank clears the stored key; anything else
 * must be a positive integer, the shape the engine's config schema accepts.
 */
function sizeField(
  deps: ProviderDeps,
  raw: string | undefined,
  previous: string | undefined,
): string | undefined {
  if (raw === undefined) return previous;
  const value = raw.trim();
  if (value === '') return '';
  if (!POSITIVE_INTEGER_PATTERN.test(value) || Number(value) < 1) {
    deps.stderr.write(t('tui.dialogs.providerForm.error.contextSizeInvalid') + '\n');
    deps.exit(1);
  }
  return value;
}

/**
 * Builds the row the flags describe. `previous` is the stored alias of the same
 * model id in edit mode: every optional field it declares is carried into the
 * row, so the flags only name what actually changes, and a field neither side
 * sets stays `undefined` — the write layer reads that as "this form does not
 * present the field" and keeps whatever the alias already had.
 */
function modelRowFromOptions(
  deps: ProviderDeps,
  opts: CreateOptions,
  previous?: ProviderFormModelRow,
): ProviderFormModelRow {
  const row: ProviderFormModelRow = {
    model: opts.model ?? '',
    maxContextSize: opts.maxContextSize ?? previous?.maxContextSize ?? '',
    displayName: opts.displayName ?? previous?.displayName ?? '',
  };
  // An explicitly blank `--capabilities` is an empty list, which the write
  // layer normalises to a deletion instead of writing `capabilities = []`.
  const capabilities =
    opts.capabilities === undefined ? previous?.capabilities : parseList(opts.capabilities);
  if (capabilities !== undefined) row.capabilities = [...capabilities];
  const maxInputSize = sizeField(deps, opts.maxInputSize, previous?.maxInputSize);
  if (maxInputSize !== undefined) row.maxInputSize = maxInputSize;
  const maxOutputSize = sizeField(deps, opts.maxOutputSize, previous?.maxOutputSize);
  if (maxOutputSize !== undefined) row.maxOutputSize = maxOutputSize;
  const supportEfforts = opts.supportEfforts ?? previous?.supportEfforts;
  if (supportEfforts !== undefined) row.supportEfforts = supportEfforts;
  const defaultEffort = opts.defaultEffort ?? previous?.defaultEffort;
  if (defaultEffort !== undefined) row.defaultEffort = defaultEffort;
  const offEffort = opts.offEffort ?? previous?.offEffort;
  if (offEffort !== undefined) row.offEffort = offEffort;
  // `??` is what lets `--no-adaptive-thinking` (false = clear) through.
  const adaptiveThinking = opts.adaptiveThinking ?? previous?.adaptiveThinking;
  if (adaptiveThinking !== undefined) row.adaptiveThinking = adaptiveThinking;
  return row;
}

function createFormInput(deps: ProviderDeps, opts: CreateOptions): ProviderFormInput {
  const row = modelRowFromOptions(deps, opts);
  const value: ProviderFormValue = {
    id: opts.id ?? '',
    type: resolveWireType(deps, opts.type),
    apiKey: opts.apiKey ?? '',
    baseUrl: opts.baseUrl ?? '',
    models: [row],
  };
  // A new provider authenticates with its own key, so `--api-key` is required.
  const error = validateProviderForm(value, { requireApiKey: true });
  if (error !== null) rejectProviderForm(deps, error);
  return { value, model: row.model.trim() };
}

/**
 * A model-row flag only means something on a row, and `--model` is what names
 * that row. Without it the flags would describe a model the command then drops
 * (the historical behaviour of `--max-context-size` and `--display-name`), so
 * the command refuses and points at `--model` instead.
 */
function requireModelFlag(deps: ProviderDeps, opts: UpdateOptions): void {
  if (opts.model !== undefined) return;
  if (!MODEL_ROW_OPTION_KEYS.some((key) => opts[key] !== undefined)) return;
  deps.stderr.write(`--model: ${t('cli.optionDescriptions.providerCreateModel')}\n`);
  deps.exit(1);
}

function updateFormInput(
  deps: ProviderDeps,
  opts: UpdateOptions,
  providerId: string,
  current: KimiConfig,
  previous: NonNullable<KimiConfig['providers'][string]>,
): ProviderFormInput {
  requireModelFlag(deps, opts);

  const renamedId = (opts.newId ?? '').trim();
  const rows = providerModelRows(current, providerId);

  const requestedModel = (opts.model ?? '').trim();
  let models = rows;
  if (opts.model !== undefined) {
    // Upsert: the row starts from the stored alias of the same model id, so a
    // flag that omits a field keeps the stored value and a new model id needs
    // `--max-context-size` like `create` does.
    const existing = rows.find((row) => row.model.trim() === requestedModel);
    models = [
      ...rows.filter((row) => row.model.trim() !== requestedModel),
      modelRowFromOptions(deps, opts, existing),
    ];
  }

  const value: ProviderFormValue = {
    id: renamedId === '' ? providerId : renamedId,
    // `astron` is an engine-only type outside the six form values; it survives
    // an untouched `--type` unchanged because the patch is built from the
    // stored provider object.
    type:
      opts.type === undefined
        ? (previous.type as ProviderWireType)
        : resolveWireType(deps, opts.type),
    apiKey: opts.apiKey ?? '',
    baseUrl: opts.baseUrl ?? previous.baseUrl ?? '',
    models,
  };
  // Edit mode: a blank key means "keep the stored credential".
  const error = validateProviderForm(value, { requireApiKey: false });
  if (error !== null) rejectProviderForm(deps, error);
  return { value, model: requestedModel === '' ? (models[0]?.model.trim() ?? '') : requestedModel };
}

/**
 * The stored aliases of one provider as rows, with every optional field the
 * alias declares carried into the row: `planEditWrite` rebuilds all of them, so
 * a row is meant to be a complete description of its alias. The states a row
 * cannot write back stay out of the row instead of flattening into a deletion,
 * the way the TUI's prefill does.
 */
function providerModelRows(current: KimiConfig, providerId: string): ProviderFormModelRow[] {
  const rows: ProviderFormModelRow[] = [];
  for (const alias of Object.values(current.models ?? {})) {
    if (alias.provider !== providerId) continue;
    const row: ProviderFormModelRow = {
      model: alias.model,
      maxContextSize: String(alias.maxContextSize),
      displayName: alias.displayName ?? '',
    };
    // An empty list is a state of its own: `capabilities = []` declares nothing
    // and `support_efforts = []` is an empty ladder, while an omitted key falls
    // back to inference for both.
    if (alias.capabilities !== undefined && alias.capabilities.length > 0) {
      row.capabilities = [...alias.capabilities];
    }
    if (alias.maxInputSize !== undefined) row.maxInputSize = String(alias.maxInputSize);
    if (alias.maxOutputSize !== undefined) row.maxOutputSize = String(alias.maxOutputSize);
    if (alias.supportEfforts !== undefined && alias.supportEfforts.length > 0) {
      row.supportEfforts = alias.supportEfforts.join(', ');
    }
    // A stored empty name and a stored `adaptiveThinking: false` are states the
    // row cannot write back either: '' in a row clears the key, and `false`
    // clears it too even though the engine reads the stored `false` as "use the
    // budget-effort ladder".
    if (alias.defaultEffort !== undefined && alias.defaultEffort !== '') {
      row.defaultEffort = alias.defaultEffort;
    }
    if (alias.offEffort !== undefined && alias.offEffort !== '') row.offEffort = alias.offEffort;
    if (alias.adaptiveThinking === true) row.adaptiveThinking = true;
    rows.push(row);
  }
  return rows;
}

export async function handleProviderList(deps: ProviderDeps, opts: ListOptions): Promise<void> {
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();

  if (opts.json) {
    deps.stdout.write(
      `${JSON.stringify(
        {
          providers: sanitizeProvidersForOutput(config.providers),
          models: config.models ?? {},
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const modelsByProvider = new Map<string, string[]>();
  const modelEntries = (config.models ?? {}) as Record<string, { readonly provider: string }>;
  for (const [alias, model] of Object.entries(modelEntries)) {
    const list = modelsByProvider.get(model.provider) ?? [];
    list.push(alias);
    modelsByProvider.set(model.provider, list);
  }

  const providerIds = Object.keys(config.providers).toSorted();
  if (providerIds.length === 0) {
    deps.stdout.write(t('tui.statusMessages.providerNoneConfigured') + '\n');
    return;
  }

  for (const id of providerIds) {
    const provider = config.providers[id]!;
    const aliases = modelsByProvider.get(id) ?? [];
    const sourceLabel = providerSourceLabel(provider);
    deps.stdout.write(
      `${id}  type=${provider.type}  models=${String(aliases.length)}  source=${sourceLabel}\n`,
    );
  }
  if (config.defaultModel !== undefined) {
    deps.stdout.write(
      '\n' + t('tui.statusMessages.providerDefaultModel', { model: config.defaultModel }) + '\n',
    );
  }
}

/**
 * Fetches the models.dev-style public catalog and lists providers, or — when
 * `providerId` is given — drills into one provider and lists its models. This
 * mirrors the discovery half of the TUI "Known third-party provider" flow.
 */
export async function handleCatalogList(
  deps: ProviderDeps,
  providerId: string | undefined,
  opts: CatalogListOptions,
): Promise<void> {
  const url = opts.url ?? DEFAULT_CATALOG_URL;
  const catalog = await loadCatalogOrExit(deps, url);

  if (providerId !== undefined) {
    const entry = catalog[providerId];
    if (entry === undefined) {
      deps.stderr.write(
        t('tui.statusMessages.providerCatalogNotFound', { id: providerId, url }) + '\n',
      );
      deps.exit(1);
    }
    const models = catalogProviderModels(entry);
    if (opts.json) {
      deps.stdout.write(
        `${JSON.stringify({ providerId, name: entry.name ?? providerId, models }, null, 2)}\n`,
      );
      return;
    }
    if (models.length === 0) {
      deps.stdout.write(
        t('tui.statusMessages.providerCatalogNoUsableModels', { id: providerId }) + '\n',
      );
      return;
    }
    deps.stdout.write(`${entry.name ?? providerId} (${providerId})\n`);
    for (const model of models) {
      const cap: string[] = [];
      if (model.capability.tool_use) cap.push('tool_use');
      if (model.capability.thinking) cap.push('thinking');
      if (model.capability.image_in) cap.push('image_in');
      const ctx =
        typeof model.capability.max_context_tokens === 'number'
          ? String(model.capability.max_context_tokens)
          : '?';
      const capLabel = cap.length > 0 ? ` [${cap.join(',')}]` : '';
      deps.stdout.write(`  ${model.id}  ctx=${ctx}${capLabel}\n`);
    }
    return;
  }

  const filter = opts.filter?.toLowerCase();
  const entries = Object.entries(catalog)
    .filter(([id, entry]) => {
      if (filter === undefined) return true;
      const haystack = `${id} ${entry.name ?? ''}`.toLowerCase();
      return haystack.includes(filter);
    })
    .toSorted(([a], [b]) => a.localeCompare(b));

  if (opts.json) {
    const out: Record<string, CatalogProviderEntry> = {};
    for (const [id, entry] of entries) out[id] = entry;
    deps.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }

  if (entries.length === 0) {
    if (filter !== undefined) {
      deps.stdout.write(t('tui.statusMessages.providerCatalogNoMatch', { filter }) + '\n');
    } else {
      deps.stdout.write(t('tui.statusMessages.providerCatalogEmpty') + '\n');
    }
    return;
  }

  for (const [id, entry] of entries) {
    const modelCount = entry.models === undefined ? 0 : Object.keys(entry.models).length;
    const resolution = resolveCatalogImport(entry);
    const wireLabel =
      resolution.kind === 'invalid'
        ? '?'
        : resolution.guessed
          ? `${resolution.wire} (guessed)`
          : resolution.wire;
    deps.stdout.write(
      `${id}  wire=${wireLabel}  models=${String(modelCount)}  ${entry.name ?? ''}\n`,
    );
  }
}

/**
 * Imports a known provider from the models.dev catalog by id. Unlike
 * `provider add` (which expects a custom api.json), this command relies on
 * the catalog's normalized metadata to fill in context limits and capabilities.
 */
export async function handleCatalogAdd(
  deps: ProviderDeps,
  providerId: string,
  opts: CatalogAddOptions,
): Promise<void> {
  const apiKey = resolveApiKey(opts.apiKey, deps.env);
  if (apiKey === undefined) {
    deps.stderr.write(t('tui.statusMessages.providerCatalogMissingApiKey') + '\n');
    deps.exit(1);
  }

  const url = opts.url ?? DEFAULT_CATALOG_URL;
  const catalog = await loadCatalogOrExit(deps, url);

  const entry = catalog[providerId];
  if (entry === undefined) {
    deps.stderr.write(
      t('tui.statusMessages.providerCatalogNotFound', { id: providerId, url }) + '\n',
    );
    deps.exit(1);
  }

  const resolution = resolveCatalogImport(entry, opts.baseUrl);
  if (resolution.kind === 'invalid') {
    switch (resolution.reason) {
      case 'unknown-explicit-type':
        deps.stderr.write(
          t('tui.statusMessages.providerCatalogUnsupportedProtocol', {
            providerId,
            type: entry.type ?? '',
          }) + '\n',
        );
        break;
      case 'proprietary-sdk':
        deps.stderr.write(
          t('tui.statusMessages.providerCatalogProprietarySdk', { providerId }) + '\n',
        );
        break;
      case 'empty-base-url':
        deps.stderr.write(t('tui.statusMessages.providerCatalogEmptyBaseUrl') + '\n');
        break;
      case 'placeholder-base-url':
        deps.stderr.write(
          t('tui.statusMessages.providerCatalogPlaceholderBaseUrlWithValue', {
            baseUrl: opts.baseUrl ?? '',
          }) + '\n',
        );
        break;
    }
    deps.exit(1);
  }
  if (resolution.kind === 'needs-base-url') {
    deps.stderr.write(
      t('tui.statusMessages.providerCatalogBaseUrlRequired', { providerId }) + '\n',
    );
    deps.exit(1);
  }
  const { wire, baseUrl } = resolution;

  const models = catalogProviderModels(entry);
  if (models.length === 0) {
    deps.stderr.write(
      t('tui.statusMessages.providerCatalogNoUsableModels', { id: providerId }) + '\n',
    );
    deps.exit(1);
  }

  if (opts.defaultModel !== undefined && !models.some((m) => m.id === opts.defaultModel)) {
    deps.stderr.write(
      t('tui.statusMessages.providerCatalogModelNotInProvider', {
        model: opts.defaultModel,
        id: providerId,
      }) + '\n',
    );
    deps.exit(1);
  }

  const harness = deps.getHarness();
  await harness.ensureConfigFile();

  let config = await harness.getConfig();

  // Capture defaults BEFORE `removeProvider`, because that call clears
  // `defaultModel` when it points at one of this provider's aliases (see
  // `config-mapper.ts planProviderRemoval`). Without this, re-importing an
  // already-configured provider would lose the user's previously-set default
  // even when `--default-model` is not supplied.
  const previousDefaultModel = config.defaultModel;
  const previousThinking = config.thinking;

  if (config.providers[providerId] !== undefined) {
    config = await harness.removeProvider(providerId);
  }

  // `applyCatalogProvider` always overwrites both `defaultModel` and
  // `[thinking]`. The values we pass here are temporary; we restore
  // a consistent state in the post-apply block below.
  applyCatalogProvider(config, {
    providerId,
    wire,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    apiKey,
    models,
    selectedModelId: opts.defaultModel ?? '',
    thinking: false,
  });

  // Resolve the final `defaultModel`:
  //   - If the caller asked for one, `applyCatalogProvider` already set it.
  //   - Else, restore the previous default ONLY when its alias still resolves
  //     after the catalog refresh; the catalog may have dropped the old
  //     model, in which case restoring would point default_model at a
  //     non-existent alias and break the next session.
  if (opts.defaultModel === undefined) {
    const stillResolves =
      previousDefaultModel !== undefined && config.models?.[previousDefaultModel] !== undefined;
    config.defaultModel = stillResolves ? previousDefaultModel : undefined;
  }

  // Always restore `[thinking]` from what was there before — including
  // `undefined`. Persisting `enabled: false` when the user never set it would
  // make `resolveThinkingEffortForModel` (agent-core-v2/src/llm-adapter/model/thinking.ts) treat
  // it as an explicit "off" request and silently disable thinking, even for
  // thinking-capable models.
  config.thinking = previousThinking;

  await harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: config.defaultModel,
    thinking: config.thinking,
  });

  const displayName = entry.name ?? providerId;
  deps.stdout.write(
    t('tui.statusMessages.providerImported', {
      name: displayName,
      id: providerId,
      count: models.length,
      plural: models.length === 1 ? '' : 's',
      url,
    }) + '\n',
  );
  if (resolution.guessed) {
    deps.stdout.write(t('tui.statusMessages.providerProtocolGuessedNote', { providerId }) + '\n');
  }
  if (opts.defaultModel !== undefined) {
    deps.stdout.write(
      t('tui.statusMessages.providerDefaultSet', { id: providerId, model: opts.defaultModel }) +
        '\n',
    );
  }
}

async function loadCatalogOrExit(deps: ProviderDeps, url: string): Promise<Catalog> {
  try {
    const loaded = await fetchCatalogOrBuiltIn(url, { userAgent: createKimiCodeUserAgent() });
    if (loaded.fromBuiltIn) {
      deps.stderr.write(t('tui.statusMessages.providerCatalogFallbackWarning', { url }) + '\n');
    }
    return loaded.catalog;
  } catch (error) {
    const suffix = error instanceof CatalogFetchError ? ` (HTTP ${String(error.status)})` : '';
    deps.stderr.write(
      t('tui.statusMessages.providerCatalogFetchFailed', {
        url,
        suffix,
        error: errorMessage(error),
      }) + '\n',
    );
    deps.exit(1);
  }
}

export function registerProviderCommand(parent: Command, deps?: Partial<ProviderDeps>): void {
  const provider = parent.command('provider').description(t('cli.commandDescriptions.provider'));

  // Last-resort boundary: handlers report expected failures themselves, but
  // anything that escapes (e.g. a config write rejected because config.toml
  // is invalid) must end as a one-line error + exit 1, not an unhandled
  // rejection dumping a stack trace.
  const runAction = async (
    resolved: ResolvedProviderDeps,
    run: () => Promise<void>,
  ): Promise<void> => {
    try {
      await run();
    } catch (error) {
      resolved.stderr.write(`${errorMessage(error)}\n`);
      resolved.exit(1);
    } finally {
      await resolved.close();
    }
  };

  provider
    .command('add <url>')
    .description(t('cli.commandDescriptions.providerAdd'))
    .option('--api-key <key>', t('cli.optionDescriptions.providerApiKey'))
    .action(async (url: string, options: { apiKey?: string }) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleProviderAdd(resolved, url, { apiKey: options.apiKey }));
    });

  provider
    .command('remove <providerId>')
    .description(t('cli.commandDescriptions.providerRemove'))
    .action(async (providerId: string) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleProviderRemove(resolved, providerId));
    });

  provider
    .command('list')
    .description(t('cli.commandDescriptions.providerList'))
    .option('--json', t('cli.optionDescriptions.providerListJson'), false)
    .action(async (options: { json?: boolean }) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () =>
        handleProviderList(resolved, { json: options.json === true }),
      );
    });

  const catalog = provider
    .command('catalog')
    .description(t('cli.commandDescriptions.providerCatalog'));

  // `--capabilities` has no picker to show the legal names, so the help text
  // lists them. Both manual commands take the same row flags: each option
  // describes the one model row that `--model` names.
  const capabilitiesDescription = `${t(
    'tui.dialogs.providerForm.capabilitiesLabel',
  )}: ${CAPABILITY_NAMES.join(', ')}`;

  provider
    .command('create')
    .description(t('cli.commandDescriptions.providerCreate'))
    .option('--id <id>', t('tui.dialogs.providerForm.idLabel'))
    .option('--type <wire>', t('cli.optionDescriptions.providerCreateType'))
    .option('--api-key <key>', t('cli.optionDescriptions.providerCreateApiKey'))
    .option('--base-url <url>', t('cli.optionDescriptions.providerCreateBaseUrl'))
    .option('--model <model>', t('cli.optionDescriptions.providerCreateModel'))
    .option('--max-context-size <tokens>', t('cli.optionDescriptions.providerCreateMaxContextSize'))
    .option('--display-name <name>', t('cli.optionDescriptions.providerCreateDisplayName'))
    .option('--max-input-size <tokens>', t('tui.dialogs.providerForm.maxInputSizeLabel'))
    .option('--max-output-size <tokens>', t('tui.dialogs.providerForm.maxOutputSizeLabel'))
    .option('--capabilities <list>', capabilitiesDescription)
    .option('--support-efforts <list>', t('tui.dialogs.providerForm.supportEffortsLabel'))
    .option('--default-effort <name>', t('tui.dialogs.providerForm.defaultEffortLabel'))
    .option('--off-effort <name>', t('tui.dialogs.providerForm.offEffortLabel'))
    .option('--adaptive-thinking', t('tui.dialogs.providerForm.adaptiveThinkingLabel'))
    .option('--no-adaptive-thinking', t('tui.dialogs.providerForm.adaptiveThinkingLabel'))
    .option('--default', t('cli.optionDescriptions.providerCreateDefault'), false)
    .option('--json', t('cli.optionDescriptions.providerListJson'), false)
    .action(async (options: CreateOptions) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleProviderCreate(resolved, options));
    });

  provider
    .command('update <providerId>')
    .description(t('cli.commandDescriptions.providerUpdate'))
    .option('--new-id <id>', t('cli.optionDescriptions.providerCreateNewId'))
    .option('--type <wire>', t('cli.optionDescriptions.providerCreateType'))
    .option('--api-key <key>', t('cli.optionDescriptions.providerCreateApiKey'))
    .option('--base-url <url>', t('cli.optionDescriptions.providerCreateBaseUrl'))
    .option('--model <model>', t('cli.optionDescriptions.providerCreateModel'))
    .option('--max-context-size <tokens>', t('cli.optionDescriptions.providerCreateMaxContextSize'))
    .option('--display-name <name>', t('cli.optionDescriptions.providerCreateDisplayName'))
    .option('--max-input-size <tokens>', t('tui.dialogs.providerForm.maxInputSizeLabel'))
    .option('--max-output-size <tokens>', t('tui.dialogs.providerForm.maxOutputSizeLabel'))
    .option('--capabilities <list>', capabilitiesDescription)
    .option('--support-efforts <list>', t('tui.dialogs.providerForm.supportEffortsLabel'))
    .option('--default-effort <name>', t('tui.dialogs.providerForm.defaultEffortLabel'))
    .option('--off-effort <name>', t('tui.dialogs.providerForm.offEffortLabel'))
    .option('--adaptive-thinking', t('tui.dialogs.providerForm.adaptiveThinkingLabel'))
    .option('--no-adaptive-thinking', t('tui.dialogs.providerForm.adaptiveThinkingLabel'))
    .option('--default', t('cli.optionDescriptions.providerCreateDefault'), false)
    .option('--json', t('cli.optionDescriptions.providerListJson'), false)
    .action(async (providerId: string, options: UpdateOptions) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleProviderUpdate(resolved, providerId, options));
    });

  catalog
    .command('list [providerId]')
    .description(t('cli.commandDescriptions.providerCatalogList'))
    .option('--filter <substring>', t('cli.optionDescriptions.providerCatalogFilter'))
    .option(
      '--url <url>',
      t('cli.optionDescriptions.providerCatalogUrl', { url: DEFAULT_CATALOG_URL }),
    )
    .option('--json', t('cli.optionDescriptions.providerCatalogJson'), false)
    .action(
      async (
        providerId: string | undefined,
        options: { filter?: string; url?: string; json?: boolean },
      ) => {
        const resolved = resolveDeps(deps);
        await runAction(resolved, () =>
          handleCatalogList(resolved, providerId, {
            json: options.json === true,
            ...(options.filter === undefined ? {} : { filter: options.filter }),
            ...(options.url === undefined ? {} : { url: options.url }),
          }),
        );
      },
    );

  catalog
    .command('add <providerId>')
    .description(t('cli.commandDescriptions.providerCatalogAdd'))
    .option('--api-key <key>', t('cli.optionDescriptions.providerCatalogApiKey'))
    .option('--default-model <modelId>', t('cli.optionDescriptions.providerCatalogDefaultModel'))
    .option('--base-url <url>', t('cli.optionDescriptions.providerCatalogBaseUrl'))
    .option(
      '--url <url>',
      t('cli.optionDescriptions.providerCatalogUrl', { url: DEFAULT_CATALOG_URL }),
    )
    .action(
      async (
        providerId: string,
        options: { apiKey?: string; defaultModel?: string; url?: string; baseUrl?: string },
      ) => {
        const resolved = resolveDeps(deps);
        await runAction(resolved, () =>
          handleCatalogAdd(resolved, providerId, {
            ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
            ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
            ...(options.url === undefined ? {} : { url: options.url }),
            ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
          }),
        );
      },
    );
}

type ResolvedProviderDeps = ProviderDeps & { readonly close: () => Promise<void> };

function resolveDeps(overrides: Partial<ProviderDeps> = {}): ResolvedProviderDeps {
  let harness: KimiHarness | undefined;
  const identity = createKimiCodeHostIdentity();
  return {
    getHarness:
      overrides.getHarness ??
      (() => {
        harness ??= createKimiHarness({ identity });
        return harness;
      }),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    env: overrides.env ?? process.env,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
    // The v2 harness boots an engine whose watchers hold the event loop open;
    // close it so a one-shot command can exit. No-op for injected harnesses.
    close: async () => {
      await harness?.close();
    },
  };
}

function resolveApiKey(flag: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof flag === 'string' && flag.length > 0) return flag;
  const fromEnv = env['KIMI_REGISTRY_API_KEY'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return undefined;
}

/**
 * Copy the provider map for `--json` stdout output, stripping secrets so they
 * never leave the process: `apiKey` on each provider and the `apiKey` inside
 * the `source` blob (registry imports persist the key there, see
 * `handleProviderAdd`). All other fields are kept as-is.
 */
function sanitizeProvidersForOutput(
  providers: KimiConfig['providers'],
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  const providerEntries = providers as Record<string, Record<string, unknown>>;
  for (const [id, provider] of Object.entries(providerEntries)) {
    const copy: Record<string, unknown> = { ...provider };
    delete copy['apiKey'];
    const source = copy['source'];
    if (source !== undefined && typeof source === 'object') {
      const sourceCopy: Record<string, unknown> = { ...source };
      delete sourceCopy['apiKey'];
      copy['source'] = sourceCopy;
    }
    out[id] = copy;
  }
  return out;
}
function providerSourceLabel(provider: KimiConfig['providers'][string]): string {
  const source = provider.source;
  if (source !== undefined) {
    if (source['kind'] === 'apiJson' && typeof source['url'] === 'string') {
      return `apiJson(${source['url']})`;
    }
  }
  if (provider.oauth !== undefined) return 'oauth';
  return 'inline';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
