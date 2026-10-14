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
 *
 * A toggle is the one field where `false` is a declaration rather than a
 * deletion (`adaptive_thinking = false` is the budget-effort ladder), so the
 * negated flag writes it and a `--clear-*` flag is what drops the key.
 */

import { isOpenPlatformId } from '@moonshot-ai/kimi-code-oauth';
import {
  applyCatalogProvider,
  catalogProviderModels,
  CatalogFetchError,
  RegistryImportError,
  type ImportCustomRegistryResult,
  createKimiHarness,
  DEFAULT_CATALOG_URL,
  removeProviderFromConfig,
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
  formatEffortList,
  mergeKeyValueText,
  parseList,
  planEditWrite,
  PROVIDER_WIRE_TYPES,
  validateProviderForm,
  type ProviderFormError,
  type ProviderFormModelRow,
  type ProviderFormToggle,
  type ProviderFormValue,
  type ProviderWireType,
} from '#/utils/provider-form';
import { isLoginAccountProviderId, isProviderIdLocked } from '#/utils/provider-managed';
import { persistProviderWrite, providerSectionsOf } from '#/utils/provider-write';

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
  /**
   * `--adaptive-thinking` writes `true` and `--no-adaptive-thinking` writes
   * `false`; neither keeps the stored value. `false` is a declaration of its
   * own — the engine reads `adaptive_thinking = false` as the budget-effort
   * ladder while an omitted key falls back to the model-name inference — so
   * dropping the key is {@link CreateOptions.clearAdaptiveThinking}'s job, not
   * the negated flag's.
   */
  readonly adaptiveThinking?: boolean;
  /** `--clear-adaptive-thinking` deletes the stored key; it wins over the other two. */
  readonly clearAdaptiveThinking?: boolean;
  /**
   * `--protocol` narrows the alias to a per-model wire override: `none` drops
   * the stored one back to the provider's type, the other two values write it
   * (`resolveProtocol` refuses anything else). Absent keeps what was stored.
   */
  readonly protocol?: string;
  /**
   * `--beta-api` writes `true` and `--no-beta-api` writes `false`; absent keeps
   * the stored value and `--clear-beta-api` deletes the key. Only the Anthropic
   * transport reads the flag, so the shared rules refuse `true` under any other
   * protocol.
   */
  readonly betaApi?: boolean;
  /** `--clear-beta-api` deletes the stored key; it wins over the other two. */
  readonly clearBetaApi?: boolean;
  /** `--reasoning-key` names the wire field carrying reasoning content; blank clears it. */
  readonly reasoningKey?: string;
  /** `--model-base-url` overrides this model's endpoint; blank clears it. */
  readonly modelBaseUrl?: string;
  /**
   * `--clear-overrides` drops the alias's stored `overrides`, which the engine
   * applies over every field above.
   */
  readonly clearOverrides?: boolean;
  /**
   * `--api-key-env` stores the NAME of the environment variable holding the
   * credential instead of an inline key. Absent keeps the stored name; an
   * explicit empty value drops it.
   *
   * The engine keeps the two credential sources apart, and the shared rules
   * refuse a value that sets both, so switching between them names both ends in
   * the same command: to env auth is `--api-key '' --api-key-env FOO` (the
   * blank is what drops the stored inline key), and back to an inline key is
   * `--api-key sk-… --api-key-env ''`.
   */
  readonly apiKeyEnv?: string;
  /**
   * `--provider-default-model` points this provider's OWN default at one of its
   * model rows, written as the `${id}/${model}` alias and refused when it names
   * no row. Absent keeps the stored pointer; `--provider-default-model ''`
   * drops it. The top-level `default_model` is `--default`'s field.
   */
  readonly providerDefaultModel?: string;
  /**
   * `--custom-header k=v`, repeatable. The entries are MERGED over the stored
   * map, so naming one header keeps every header this line does not mention; an
   * omitted flag keeps the stored map untouched, and `--clear-custom-headers`
   * is what drops entries — alone for the whole map, or alongside this flag to
   * replace it with exactly the entries named. The entries are joined into the
   * `k=v, k2=v2` text the shared parser reads, so a value cannot contain a
   * comma.
   */
  readonly customHeader?: readonly string[];
  /** `--env k=v`, repeatable: provider-scoped environment, shaped like `--custom-header`. */
  readonly env?: readonly string[];
  /** `--clear-custom-headers` empties the stored map rather than keeping it. */
  readonly clearCustomHeaders?: boolean;
  /** `--clear-env` empties the stored env rather than keeping it. */
  readonly clearEnv?: boolean;
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

/**
 * `--force` is the escape hatch for the one removal `remove` refuses by
 * default: the account `/login` and `/logout` own.
 */
interface RemoveOptions {
  readonly force?: boolean;
}

export async function handleProviderRemove(
  deps: ProviderDeps,
  providerId: string,
  opts: RemoveOptions = {},
): Promise<void> {
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();
  const target = config.providers[providerId];
  if (target === undefined) {
    deps.stderr.write(t('tui.statusMessages.providerNotFound', { id: providerId }) + '\n');
    deps.exit(1);
  }
  // `/login` and `/logout` own this record — the TUI hides its row outright —
  // so deleting it here throws the credential away behind the account's own
  // commands, which re-provision it on the next login. `--force` is the
  // escape hatch for the removal a user really means.
  if (opts.force !== true) {
    if (isLoginAccountProviderId(providerId)) {
      deps.stderr.write(
        t('tui.statusMessages.providerRemoveLoginAccount', { id: providerId }) + '\n',
      );
      deps.exit(1);
    }
    if (target.oauth !== undefined) {
      deps.stderr.write(t('tui.dialogs.providerForm.managedReadonly') + '\n');
      deps.exit(1);
    }
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
 * TUI edit path — planned as remove-first (only the removal cascades the old
 * aliases and any dangling default pointers away), then landed by
 * `persistProviderWrite`, which folds the removal into a single atomic section
 * replace where the host supports one.
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
  if (previous.oauth !== undefined || isOpenPlatformId(providerId)) {
    deps.stderr.write(t('tui.dialogs.providerForm.managedReadonly') + '\n');
    deps.exit(1);
  }

  // The id of a login account, an Open Platform provider or a registry import
  // is owned outside the config, so renaming it here would not move the record:
  // it would write a copy under the new id and orphan the credential — and the
  // registry entry — the old one points at, which the next refresh or login
  // then re-adds beside the copy. Editing config.toml by hand stays possible.
  const renamedId = (opts.newId ?? '').trim();
  if (renamedId !== '' && renamedId !== providerId && isProviderIdLocked(providerId, previous)) {
    deps.stderr.write(t('tui.dialogs.providerForm.error.idLocked', { id: providerId }) + '\n');
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

  // `--default` names a row this write rebuilds, so the override has to reach
  // both shapes of the plan: the patch carries it on the merge path and the
  // sections on the one-write path.
  let patch = plan.patch;
  let sections = plan.sections;
  if (opts.default === true) {
    const defaultModel = `${input.value.id.trim()}/${input.model}`;
    patch = { ...patch, defaultModel };
    sections = { ...sections, defaultModel };
  }
  await persistProviderWrite(harness, {
    patch,
    sections,
    removeProviderId: plan.removeProviderId,
  });

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
  apiKeyConflict: 'tui.dialogs.providerForm.error.apiKeyConflict',
  baseUrlRequired: 'tui.dialogs.providerForm.error.baseUrlRequired',
  modelRequired: 'tui.dialogs.providerForm.error.modelRequired',
  contextSizeRequired: 'tui.dialogs.providerForm.error.contextSizeRequired',
  contextSizeInvalid: 'tui.dialogs.providerForm.error.contextSizeInvalid',
  modelDuplicate: 'tui.dialogs.providerForm.error.modelDuplicate',
  capabilityUnknown: 'tui.dialogs.providerForm.error.capabilityUnknown',
  defaultEffortNotSupported: 'tui.dialogs.providerForm.error.defaultEffortNotSupported',
  defaultModelUnknown: 'tui.dialogs.providerForm.error.defaultModelUnknown',
  betaApiWithoutAnthropic: 'tui.dialogs.providerForm.error.betaApiWithoutAnthropic',
  modelBaseUrlInvalid: 'tui.dialogs.providerForm.error.modelBaseUrlInvalid',
  headerInvalid: 'tui.dialogs.providerForm.error.headerInvalid',
  envInvalid: 'tui.dialogs.providerForm.error.envInvalid',
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

/**
 * `--protocol` is the per-model half of `--type`: the two values the alias
 * schema accepts, plus the literal `none` for "no override" — the alias is
 * rebuilt from the provider's type, which is also what an untouched flag leaves
 * in place. Anything else is refused the way `--type` is, with the option
 * description (which enumerates the three values) as the message.
 */
function resolveProtocol(deps: ProviderDeps, raw: string): '' | 'anthropic' | 'openai_responses' {
  if (raw === 'none') return '';
  if (raw === 'anthropic' || raw === 'openai_responses') return raw;
  deps.stderr.write(t('cli.optionDescriptions.providerCreateProtocol') + '\n');
  deps.exit(1);
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
  'clearAdaptiveThinking',
  'protocol',
  'betaApi',
  'clearBetaApi',
  'reasoningKey',
  'modelBaseUrl',
  'clearOverrides',
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
 * The three states of a toggle flag. `--clear-x` deletes the stored key and
 * wins over the other two; otherwise the flag's own boolean is written verbatim
 * (`false` included — see {@link CreateOptions.adaptiveThinking}) and an
 * untouched flag falls back to the stored declaration, which the write layer
 * would keep anyway.
 */
function toggleField(
  clear: boolean | undefined,
  value: boolean | undefined,
  previous: ProviderFormToggle | undefined,
): ProviderFormToggle | undefined {
  if (clear === true) return 'clear';
  return value ?? previous;
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
  const adaptiveThinking = toggleField(
    opts.clearAdaptiveThinking,
    opts.adaptiveThinking,
    previous?.adaptiveThinking,
  );
  if (adaptiveThinking !== undefined) row.adaptiveThinking = adaptiveThinking;
  const betaApi = toggleField(opts.clearBetaApi, opts.betaApi, previous?.betaApi);
  if (betaApi !== undefined) row.betaApi = betaApi;
  const protocol =
    opts.protocol === undefined ? previous?.protocol : resolveProtocol(deps, opts.protocol);
  if (protocol !== undefined) row.protocol = protocol;
  // The two plain strings below are not inherited from the stored alias: the
  // write layer keeps them through `previous`, so an edit that does not name
  // them never re-validates a stored endpoint or field name.
  if (opts.reasoningKey !== undefined) row.reasoningKey = opts.reasoningKey;
  if (opts.modelBaseUrl !== undefined) row.baseUrl = opts.modelBaseUrl;
  if (opts.clearOverrides === true) row.clearOverrides = true;
  return row;
}

/**
 * The provider-level fields the two manual commands share.
 *
 * `--api-key-env` and `--provider-default-model` follow the file's own-vs-keep
 * rule: an omitted flag leaves the property `undefined`, which the write layer
 * reads as "keep the stored value", while an explicit empty value asks for the
 * field to be dropped.
 *
 * The two `k=v` records are MERGED by the shared helper rather than joined
 * here: the flags carry only what this command line names while the write layer
 * replaces the whole record, so joining them would take every stored entry the
 * line did not name down with it — the silent loss a lone `--custom-header
 * X-Trace=1` used to cause. `stored` is the record to merge over: the caller's
 * `previous` on an edit, and `undefined` on `create`, which has none.
 */
function providerFieldsFromOptions(
  opts: CreateOptions,
  stored?: Pick<NonNullable<KimiConfig['providers'][string]>, 'customHeaders' | 'env'>,
): Pick<ProviderFormValue, 'apiKeyEnv' | 'defaultModel' | 'customHeaders' | 'env'> {
  return {
    apiKeyEnv: opts.apiKeyEnv,
    defaultModel: opts.providerDefaultModel,
    customHeaders: mergeKeyValueText(
      opts.customHeader,
      opts.clearCustomHeaders,
      stored?.customHeaders,
    ),
    env: mergeKeyValueText(opts.env, opts.clearEnv, stored?.env),
  };
}

function createFormInput(deps: ProviderDeps, opts: CreateOptions): ProviderFormInput {
  const row = modelRowFromOptions(deps, opts);
  const value: ProviderFormValue = {
    id: opts.id ?? '',
    type: resolveWireType(deps, opts.type),
    apiKey: opts.apiKey ?? '',
    baseUrl: opts.baseUrl ?? '',
    ...providerFieldsFromOptions(opts),
    models: [row],
  };
  // A new provider has to carry a credential, and either source satisfies it:
  // an inline key, or the name of the env var holding one. The shared rules
  // still refuse a value that sets both.
  const error = validateProviderForm(value, {
    requireApiKey: (value.apiKeyEnv ?? '').trim() === '',
  });
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
    // An untouched `--type` keeps the stored one verbatim, `astron` included —
    // the form value carries the engine's whole type, so a record outside the
    // six the flag accepts needs no narrowing to be updated.
    type: opts.type === undefined ? previous.type : resolveWireType(deps, opts.type),
    // Edit mode: a blank `--api-key` means "keep the stored credential", so the
    // value repeats the STORED key. `planEditWrite` spreads the previous record
    // and assigns this field, so repeating the same value leaves the produced
    // patch byte-identical — and it is what lets the shared rules SEE a stored
    // inline key that a new `--api-key-env` alone would leave in place: the
    // value then sets both credential sources, which `apiKeyConflict` refuses.
    // An explicit `--api-key ''` still drops the stored key (`clearApiKey`).
    apiKey: opts.apiKey ?? previous.apiKey ?? '',
    baseUrl: opts.baseUrl ?? previous.baseUrl ?? '',
    ...providerFieldsFromOptions(opts, previous),
    ...(opts.apiKeyEnv === undefined && previous.apiKeyEnv !== undefined
      ? { apiKeyEnv: previous.apiKeyEnv }
      : undefined),
    models,
  };
  const error = validateProviderForm(value, { requireApiKey: false });
  if (error !== null) rejectProviderForm(deps, error);
  return { value, model: requestedModel === '' ? (models[0]?.model.trim() ?? '') : requestedModel };
}

/**
 * The stored aliases of one provider as rows, with every optional field the
 * alias declares carried into the row: `planEditWrite` rebuilds all of them, so
 * a row is meant to be a complete description of its alias. The states a row
 * cannot write back stay out of the row instead of flattening into a deletion,
 * the way the TUI's prefill does — a stored empty effort name is one, and
 * `reasoningKey`/`baseUrl` are left to the write layer for the same reason (an
 * empty string would read as a deletion); they survive through the alias the
 * write rebuilds from.
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
      row.supportEfforts = formatEffortList(alias.supportEfforts);
    }
    if (alias.defaultEffort !== undefined && alias.defaultEffort !== '') {
      row.defaultEffort = alias.defaultEffort;
    }
    if (alias.offEffort !== undefined && alias.offEffort !== '') row.offEffort = alias.offEffort;
    // Both toggles round-trip `false` now: a row writes the boolean verbatim
    // (`applyToggle`), so presenting the stored `false` no longer flattens the
    // budget-effort ladder into a deletion.
    if (alias.adaptiveThinking !== undefined) row.adaptiveThinking = alias.adaptiveThinking;
    if (alias.betaApi !== undefined) row.betaApi = alias.betaApi;
    // The per-model wire override belongs in the row: `--beta-api`'s legality is
    // judged against the protocol the row effectively reaches Anthropic with,
    // and unlike the fields above a stored protocol is always one of the values
    // the row can write back.
    if (alias.protocol !== undefined) row.protocol = alias.protocol;
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

  // Capture defaults BEFORE the removal, because that call clears
  // `defaultModel` when it points at one of this provider's aliases (see
  // `config-mapper.ts planProviderRemoval`). Without this, re-importing an
  // already-configured provider would lose the user's previously-set default
  // even when `--default-model` is not supplied.
  const previousDefaultModel = config.defaultModel;
  const previousThinking = config.thinking;

  // The removal is folded into the config in memory instead of being persisted
  // as its own step: `persistProviderWrite` lands it as ONE atomic section
  // replace where the host supports one, so a re-import can no longer delete
  // the provider and every alias it had without writing the replacement.
  const replacing = config.providers[providerId] !== undefined;
  if (replacing) config = removeProviderFromConfig(config, providerId);

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
  // thinking-capable models. The merge path writes this value back; the
  // one-write path never names the section, which leaves the same value in
  // place without pinning a value that came from another config layer.
  config.thinking = previousThinking;

  await persistProviderWrite(harness, {
    patch: {
      providers: config.providers,
      models: config.models,
      defaultModel: config.defaultModel,
      thinking: config.thinking,
    },
    sections: providerSectionsOf(config),
    removeProviderId: replacing ? providerId : undefined,
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
    .option('--force', t('cli.optionDescriptions.providerRemoveForce'))
    .action(async (providerId: string, options: { force?: boolean }) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () =>
        handleProviderRemove(resolved, providerId, { force: options.force === true }),
      );
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

  // Collector for the repeatable `k=v` flags. It returns a NEW array instead of
  // pushing into the one commander hands over: that value is the `[]` default
  // the option was registered with, and commander re-seeds that same array as
  // the starting value on every parse of this Command, so mutating it would
  // carry one parse's entries into the next one.
  const collectKeyValue = (value: string, previous: readonly string[]): string[] => {
    return [...previous, value];
  };

  provider
    .command('create')
    .description(t('cli.commandDescriptions.providerCreate'))
    .option('--id <id>', t('tui.dialogs.providerForm.idLabel'))
    .option('--type <wire>', t('cli.optionDescriptions.providerCreateType'))
    .option('--api-key <key>', t('cli.optionDescriptions.providerCreateApiKey'))
    .option('--api-key-env <name>', t('cli.optionDescriptions.providerCreateApiKeyEnv'))
    .option('--base-url <url>', t('cli.optionDescriptions.providerCreateBaseUrl'))
    .option(
      '--provider-default-model <modelId>',
      t('cli.optionDescriptions.providerCreateProviderDefaultModel'),
    )
    .option(
      '--custom-header <k=v>',
      t('cli.optionDescriptions.providerCreateCustomHeader'),
      collectKeyValue,
      [],
    )
    .option('--env <k=v>', t('cli.optionDescriptions.providerCreateEnv'), collectKeyValue, [])
    .option('--clear-custom-headers', t('cli.optionDescriptions.providerClearCustomHeaders'))
    .option('--clear-env', t('cli.optionDescriptions.providerClearEnv'))
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
    .option('--clear-adaptive-thinking', t('cli.optionDescriptions.providerClearAdaptiveThinking'))
    .option('--protocol <wire>', t('cli.optionDescriptions.providerCreateProtocol'))
    .option('--beta-api', t('cli.optionDescriptions.providerCreateBetaApi'))
    .option('--no-beta-api', t('cli.optionDescriptions.providerClearBetaApi'))
    .option('--clear-beta-api', t('cli.optionDescriptions.providerClearBetaApi'))
    .option('--reasoning-key <key>', t('cli.optionDescriptions.providerCreateReasoningKey'))
    .option('--model-base-url <url>', t('cli.optionDescriptions.providerCreateModelBaseUrl'))
    .option('--clear-overrides', t('cli.optionDescriptions.providerClearOverrides'))
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
    .option('--api-key-env <name>', t('cli.optionDescriptions.providerCreateApiKeyEnv'))
    .option('--base-url <url>', t('cli.optionDescriptions.providerCreateBaseUrl'))
    .option(
      '--provider-default-model <modelId>',
      t('cli.optionDescriptions.providerCreateProviderDefaultModel'),
    )
    .option(
      '--custom-header <k=v>',
      t('cli.optionDescriptions.providerCreateCustomHeader'),
      collectKeyValue,
      [],
    )
    .option('--env <k=v>', t('cli.optionDescriptions.providerCreateEnv'), collectKeyValue, [])
    .option('--clear-custom-headers', t('cli.optionDescriptions.providerClearCustomHeaders'))
    .option('--clear-env', t('cli.optionDescriptions.providerClearEnv'))
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
    .option('--clear-adaptive-thinking', t('cli.optionDescriptions.providerClearAdaptiveThinking'))
    .option('--protocol <wire>', t('cli.optionDescriptions.providerCreateProtocol'))
    .option('--beta-api', t('cli.optionDescriptions.providerCreateBetaApi'))
    .option('--no-beta-api', t('cli.optionDescriptions.providerClearBetaApi'))
    .option('--clear-beta-api', t('cli.optionDescriptions.providerClearBetaApi'))
    .option('--reasoning-key <key>', t('cli.optionDescriptions.providerCreateReasoningKey'))
    .option('--model-base-url <url>', t('cli.optionDescriptions.providerCreateModelBaseUrl'))
    .option('--clear-overrides', t('cli.optionDescriptions.providerClearOverrides'))
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
