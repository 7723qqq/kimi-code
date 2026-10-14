import {
  type KimiConfig,
  type KimiConfigPatch,
  type ModelAlias,
  type ProviderConfig,
  type ProviderType,
  removeProviderFromConfig,
} from '@moonshot-ai/kimi-code-sdk';

import type { ProviderWriteSections } from '#/utils/provider-write';

/**
 * The six wire types the manual provider form offers, in the official
 * presentation order (`dist-web` AddProviderPage).
 *
 * The engine's own `ProviderType` has a seventh member, `astron`, which the
 * form has no field for. A record already stored as `astron` keeps that type
 * when it is edited (the form carries the stored value through as an extra
 * candidate) instead of being rewritten to the first entry above.
 */
export const PROVIDER_WIRE_TYPES = [
  'kimi',
  'openai',
  'openai_responses',
  'anthropic',
  'google-genai',
  'vertexai',
] as const;

export type ProviderWireType = (typeof PROVIDER_WIRE_TYPES)[number];

export const CAPABILITY_NAMES = [
  'image_in',
  'video_in',
  'audio_in',
  'pdf_in',
  'thinking',
  'always_thinking',
  'tool_use',
  'dynamically_loaded_tools',
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export function isCapabilityName(value: string): value is CapabilityName {
  return (CAPABILITY_NAMES as readonly string[]).includes(value);
}

export const THINKING_EFFORT_NAMES = ['off', 'low', 'medium', 'high', 'max', 'xhigh'] as const;

/**
 * A boolean field the form owns outright.
 *
 * `undefined` keeps whatever the record already declared, `'clear'` deletes the
 * key, and a boolean is written verbatim. `false` cannot double as "delete" for
 * the toggles the form owns: `adaptiveThinking: false` is a declaration of its
 * own — `model-auth.ts` reads it as the budget-effort ladder, while an omitted
 * key falls back to the model-name inference — and folding the two together is
 * what made that state unreachable.
 */
export type ProviderFormToggle = boolean | 'clear';

export interface ProviderFormModelRow {
  model: string;
  maxContextSize: string;
  displayName: string;
  /**
   * Model capabilities. Absent means "not set here": a new row writes nothing,
   * and an edited row keeps whatever the alias already declared. An empty list
   * is normalised to absent rather than written, because nothing downstream
   * separates `capabilities = []` from a missing key — `catalog-service.ts`
   * reads both through `?? []`, and the detection it falls back to is computed
   * from the wire and the model name, never from whether the key exists. (Only
   * `overrides.capabilities` distinguishes declared from absent, and the form
   * deliberately does not offer overrides.)
   */
  capabilities?: string[];
  maxInputSize?: string;
  maxOutputSize?: string;
  /**
   * Ordered by strength: the default effort is the middle entry.
   *
   * Blank clears the key; the literal `[]` declares a ladder that is empty on
   * purpose ({@link EMPTY_EFFORT_LADDER}), which the engine reads differently
   * from a missing key: `thinking.ts` refuses to turn thinking off for a
   * declared-empty ladder (`off-needs-offeffort`) and passes silently when the
   * key is absent.
   */
  supportEfforts?: string;
  defaultEffort?: string;
  offEffort?: string;
  adaptiveThinking?: ProviderFormToggle;
  /**
   * Per-model wire override. `''` means "not set" — the alias is rebuilt from
   * the provider's type — while `undefined` keeps whatever was stored.
   */
  protocol?: '' | 'anthropic' | 'openai_responses';
  betaApi?: ProviderFormToggle;
  reasoningKey?: string;
  /** Per-model endpoint, paired with {@link protocol}. */
  baseUrl?: string;
  /**
   * Display-only: the stored alias carries `overrides`, which the engine applies
   * OVER every field above (`model-auth.ts` spreads them last). The form cannot
   * edit them — offering the ten nested fields would double the editor for a
   * layer hand-added models do not need — so it shows this instead, and lets the
   * user drop them. Never written.
   */
  hasStoredOverrides?: boolean;
  /** `true` deletes the stored `overrides`; absent keeps them. */
  clearOverrides?: boolean;
}

export interface ProviderFormValue {
  id: string;
  /**
   * The engine's whole `ProviderType`, not just the six the form offers: an
   * edited record keeps a type the form cannot set (`astron`), so narrowing
   * this to {@link ProviderWireType} would only move the rewrite into a caller.
   */
  type: ProviderType;
  apiKey: string;
  /**
   * The NAME of an environment variable holding the credential, as the
   * alternative to an inline {@link apiKey}. The engine keeps the two sources
   * apart and never merges them, so a value that sets both is refused rather
   * than silently resolved.
   */
  apiKeyEnv?: string;
  baseUrl: string;
  /**
   * This provider's own default-model pointer, as a bare model id. Written as
   * the `${id}/${model}` alias and refused when it names no row of this
   * provider, so the config never carries a pointer nothing resolves.
   *
   * The TOP-LEVEL `config.defaultModel` is a different field, owned by the add
   * flow's model selector.
   */
  defaultModel?: string;
  /** Request headers as `k=v, k2=v2` text; blank clears them. */
  customHeaders?: string;
  /** Provider-scoped environment as `k=v, k2=v2` text; blank clears it. */
  env?: string;
  models: ProviderFormModelRow[];
}

export type ProviderFormError =
  | 'idRequired'
  | 'idInvalid'
  | 'apiKeyRequired'
  | 'apiKeyConflict'
  | 'baseUrlRequired'
  | 'modelRequired'
  | 'contextSizeRequired'
  | 'contextSizeInvalid'
  | 'modelDuplicate'
  | 'capabilityUnknown'
  | 'defaultEffortNotSupported'
  | 'defaultModelUnknown'
  | 'betaApiWithoutAnthropic'
  | 'modelBaseUrlInvalid'
  | 'headerInvalid'
  | 'envInvalid';

export function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parseEffortList(raw: string | undefined): string[] {
  const seen = new Set<string>();
  const efforts: string[] = [];
  for (const effort of parseList(raw)) {
    if (seen.has(effort)) continue;
    seen.add(effort);
    efforts.push(effort);
  }
  return efforts;
}

/** The first `k=v` entry with no name, or `undefined` when every entry parses. */
export function badKeyValueEntry(raw: string | undefined): string | undefined {
  for (const entry of parseList(raw)) {
    if (entry.indexOf('=') <= 0) return entry;
  }
  return undefined;
}

/**
 * The `k=v, k2=v2` pairs the form's two flat string records are collected from,
 * in the order typed, later duplicates winning.
 *
 * Both front ends hand over this same text, so a value containing a comma
 * cannot be expressed — the fields' hints say so, and `config.toml` stays the
 * way to write one.
 */
export function parseKeyValueList(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of parseList(raw)) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim();
    if (key === '') continue;
    out[key] = entry.slice(separator + 1).trim();
  }
  return out;
}

/**
 * The text a flat string record is presented as. Every entry carries its `=`,
 * including an empty value, so the form round-trips a blank value instead of
 * producing an entry its own parser would reject.
 */
export function formatKeyValueList(map: Record<string, string> | undefined): string {
  if (map === undefined) return '';
  return Object.entries(map)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

/**
 * The text a PARTIAL write leaves behind, for the two repeatable CLI flags that
 * have no text field of their own: the named entries merged OVER the stored
 * record, or exactly the named entries when the caller asked to clear first.
 *
 * Merging is the whole point — a replacement would silently drop every entry the
 * command line did not name (`--custom-header X-Trace=1` taking a stored
 * `Authorization` with it), and the TUI cannot lose them because it hands over
 * the prefilled text instead. `--clear-custom-headers`/`--clear-env` alongside a
 * value flag is the spelled-out way to replace.
 *
 * An entry that does not parse is kept as typed rather than dropped here, so
 * `validateProviderForm` reports it instead of this layer swallowing it.
 * `undefined` means "leave the stored record alone".
 */
export function mergeKeyValueText(
  entries: readonly string[] | undefined,
  clear: boolean | undefined,
  stored: Record<string, string> | undefined,
): string | undefined {
  if (entries === undefined || entries.length === 0) {
    return clear === true ? '' : undefined;
  }
  const merged = new Map<string, string>(clear === true ? [] : Object.entries(stored ?? {}));
  const unparsed: string[] = [];
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    const key = separator > 0 ? entry.slice(0, separator).trim() : '';
    if (key === '') {
      unparsed.push(entry);
      continue;
    }
    merged.set(key, entry.slice(separator + 1).trim());
  }
  const text = formatKeyValueList(Object.fromEntries(merged));
  return [text, ...unparsed].filter((part) => part !== '').join(', ');
}

export interface PlanEditWriteOptions {
  /**
   * The edit form left the API key field blank on purpose: write an explicit
   * empty `apiKey` so the stored credential is cleared. Without it a blank
   * field keeps the existing credential untouched.
   */
  clearApiKey?: boolean;
}

export interface PlanEditWriteResult {
  /** The provider to delete first (`removeProvider`), then apply {@link patch}. */
  removeProviderId: string;
  /**
   * The merge patch. It is the whole write on a host that cannot replace
   * sections; hosts that can write {@link sections} instead, in one call.
   */
  patch: KimiConfigPatch;
  /**
   * The same write expressed as complete sections, for a host that can land it
   * in one atomic write (`replaceConfigSections` via `persistProviderWrite`).
   * Built on the config the removal leaves behind, so it is exactly what the
   * `removeProvider` + `patch` pairing would leave on disk — but reachable
   * without a moment in between where the provider is gone and its replacement
   * is not written yet.
   */
  sections: ProviderWriteSections;
  /**
   * Alias keys this patch would write over a record that already belongs to a
   * different provider. The caller must refuse the write while it is non-empty.
   */
  collisions: string[];
  /** True when `newId` differs from `previousId` and another provider already uses it. */
  providerIdTaken: boolean;
}

/**
 * The official id rule (`dist-web` `dL`): the value is matched verbatim, so a
 * leading space is rejected instead of being trimmed away.
 */
const PROVIDER_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\-_ ]*$/u;

const POSITIVE_INTEGER_PATTERN = /^\d+$/;

export function validateProviderForm(
  value: ProviderFormValue,
  opts: { requireApiKey: boolean },
): ProviderFormError | null {
  if (value.id.trim() === '') return 'idRequired';
  if (!PROVIDER_ID_PATTERN.test(value.id)) return 'idInvalid';
  if (opts.requireApiKey && value.apiKey.trim() === '') return 'apiKeyRequired';
  // The engine keeps the two credential sources apart — `open-platform.ts`
  // replaces rather than merges them precisely so a second source cannot be
  // resurrected — so a record setting both is ambiguous, not redundant.
  if (value.apiKey.trim() !== '' && (value.apiKeyEnv ?? '').trim() !== '') return 'apiKeyConflict';
  if (value.baseUrl.trim() === '') return 'baseUrlRequired';
  if (badKeyValueEntry(value.customHeaders) !== undefined) return 'headerInvalid';
  if (badKeyValueEntry(value.env) !== undefined) return 'envInvalid';
  if (value.models.length === 0) return 'modelRequired';
  for (const row of value.models) {
    if (row.model.trim() === '') return 'modelRequired';
    const maxContextSize = row.maxContextSize.trim();
    if (maxContextSize === '') return 'contextSizeRequired';
    if (!POSITIVE_INTEGER_PATTERN.test(maxContextSize) || Number(maxContextSize) < 1) {
      return 'contextSizeInvalid';
    }
    const maxInputSize = (row.maxInputSize ?? '').trim();
    if (
      maxInputSize !== '' &&
      (!POSITIVE_INTEGER_PATTERN.test(maxInputSize) || Number(maxInputSize) < 1)
    ) {
      return 'contextSizeInvalid';
    }
    const maxOutputSize = (row.maxOutputSize ?? '').trim();
    if (
      maxOutputSize !== '' &&
      (!POSITIVE_INTEGER_PATTERN.test(maxOutputSize) || Number(maxOutputSize) < 1)
    ) {
      return 'contextSizeInvalid';
    }
  }
  for (const row of value.models) {
    for (const capability of row.capabilities ?? []) {
      if (!isCapabilityName(capability)) return 'capabilityUnknown';
    }
    if (row.defaultEffort !== undefined && row.defaultEffort.trim() !== '') {
      // A declared-empty ladder supports no default, so this refuses one exactly
      // as a missing ladder does.
      const ladder = rowEffortLadder(row.supportEfforts);
      const efforts = ladder === undefined || ladder === 'clear' ? [] : ladder;
      if (!efforts.includes(row.defaultEffort.trim())) return 'defaultEffortNotSupported';
    }
    // A per-model endpoint has to be one, or the transport is handed a value it
    // cannot open a connection to.
    const modelBaseUrl = (row.baseUrl ?? '').trim();
    if (modelBaseUrl !== '' && !/^https?:\/\//.test(modelBaseUrl)) return 'modelBaseUrlInvalid';
    // `betaApi` reaches the wire only through the Anthropic transport
    // (`protocolAdapterRegistry.ts`); under any other protocol the engine
    // accepts it and does nothing with it, so it is refused here instead.
    if (row.betaApi === true && !reachesAnthropic(value.type, row.protocol)) {
      return 'betaApiWithoutAnthropic';
    }
  }
  // The provider-level pointer is written as `${id}/${model}`, so it has to name
  // a row of this provider: a pointer nothing resolves outlives the edit.
  const pointer = (value.defaultModel ?? '').trim();
  if (pointer !== '' && !value.models.some((row) => row.model.trim() === pointer)) {
    return 'defaultModelUnknown';
  }
  // Duplicates come after every row's own errors, so a malformed row reports
  // its own code first (kap's `refineProviderForm` shape: `duplicate model`).
  const seenModels = new Set<string>();
  for (const row of value.models) {
    const model = row.model.trim();
    if (seenModels.has(model)) return 'modelDuplicate';
    seenModels.add(model);
  }
  return null;
}

/**
 * Whether `betaApi` can take effect for a row: the Anthropic transport is
 * selected by the provider's wire type, or by the row's own `protocol` override.
 */
function reachesAnthropic(type: ProviderType, protocol: string | undefined): boolean {
  return type === 'anthropic' || protocol === 'anthropic';
}

/**
 * Switching to `anthropic` strips a trailing `/v1` from the base URL; others
 * keep it. Takes the engine's full type: the rule itself only looks at
 * `anthropic`, and a stored `astron` must pass through unchanged.
 */
export function normalizeBaseUrlForType(baseUrl: string, type: ProviderType): string {
  return type === 'anthropic' ? baseUrl.replace(/\/v1\/?$/, '') : baseUrl;
}

/**
 * Capabilities a brand-new manual model declares. The historical default, kept
 * because a hand-added model name is usually one the engine cannot classify on
 * its own: without `tool_use` a custom gateway model would lose its tools.
 */
export const DEFAULT_MODEL_CAPABILITIES = ['tool_use', 'thinking'] as const;

export function defaultModelRow(): ProviderFormModelRow {
  return { model: '', maxContextSize: '', displayName: '' };
}

/**
 * Apply one optional field the form may own.
 *
 * Three states, and the difference between the first two is the whole point:
 * `undefined` means the form does not present this field at all, so whatever
 * the alias already declared survives untouched; an empty string means the user
 * cleared it, which deletes the key rather than writing an empty value the
 * engine would have to interpret; anything else is written.
 */
function applyOptionalNumber(
  alias: ModelAlias,
  key: 'maxInputSize' | 'maxOutputSize',
  raw: string | undefined,
): void {
  if (raw === undefined) return;
  const value = raw.trim();
  if (value === '') {
    delete alias[key];
    return;
  }
  alias[key] = Number(value);
}

function applyOptionalString(
  alias: ModelAlias,
  key: 'defaultEffort' | 'offEffort' | 'reasoningKey' | 'baseUrl',
  value: string | undefined,
): void {
  if (value === undefined) return;
  const trimmed = value.trim();
  if (trimmed === '') {
    delete alias[key];
    return;
  }
  alias[key] = trimmed;
}

/**
 * The literal a user types to declare an EMPTY effort ladder.
 *
 * A blank text field has to keep its existing meaning — "clear the key" — so the
 * declared-empty state needs a spelling of its own, and `[]` is what it looks
 * like. The engine reads the two states differently; see
 * {@link ProviderFormModelRow.supportEfforts}.
 */
export const EMPTY_EFFORT_LADDER = '[]';

/**
 * The ladder a row declares: `string[]` to write it (possibly empty), `'clear'`
 * for a blank field, `undefined` when the row does not present the field at all.
 */
export function rowEffortLadder(raw: string | undefined): string[] | 'clear' | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (text === '') return 'clear';
  if (text === EMPTY_EFFORT_LADDER) return [];
  return parseEffortList(raw);
}

/** The text a stored ladder is presented as; an empty one round-trips as the literal. */
export function formatEffortList(efforts: readonly string[] | undefined): string {
  if (efforts === undefined) return '';
  if (efforts.length === 0) return EMPTY_EFFORT_LADDER;
  return efforts.join(', ');
}

/**
 * `supportEfforts` is a comma-separated list whose ORDER carries meaning — the
 * default effort is the middle entry and the persistence ceiling is derived
 * from the index — so this trims and de-duplicates while preserving the order
 * the user typed, and never sorts.
 */
function applyEffortList(alias: ModelAlias, value: string | undefined): void {
  const ladder = rowEffortLadder(value);
  if (ladder === undefined) return;
  if (ladder === 'clear') {
    delete alias.supportEfforts;
    return;
  }
  alias.supportEfforts = ladder;
}

/**
 * `undefined` keeps what the alias declared, `'clear'` deletes the key, and a
 * boolean is written verbatim — see {@link ProviderFormToggle} for why `false`
 * needs a representation of its own rather than doubling as "delete".
 */
function applyToggle(
  alias: ModelAlias,
  key: 'adaptiveThinking' | 'betaApi',
  value: ProviderFormToggle | undefined,
): void {
  if (value === undefined) return;
  if (value === 'clear') {
    delete alias[key];
    return;
  }
  alias[key] = value;
}

/** `undefined` keeps the stored override; `''` drops it back to the provider's type. */
function applyProtocol(alias: ModelAlias, value: ProviderFormModelRow['protocol']): void {
  if (value === undefined) return;
  if (value === '') {
    delete alias.protocol;
    return;
  }
  alias.protocol = value;
}

/**
 * Rows the form did not originate (a freshly added one) carry the official
 * defaults; a row matched to an existing alias keeps every field the form
 * does not own (`overrides`, `name`, ...).
 */
function buildModelAlias(
  row: ProviderFormModelRow,
  providerId: string,
  previous?: ModelAlias,
): ModelAlias {
  const alias: ModelAlias = {
    ...(previous ?? { capabilities: [...DEFAULT_MODEL_CAPABILITIES] }),
    provider: providerId,
    model: row.model.trim(),
    maxContextSize: Number(row.maxContextSize.trim()),
  };

  if (row.capabilities !== undefined) {
    const capabilities = [...new Set(row.capabilities.map((c) => c.trim()).filter(Boolean))];
    if (capabilities.length === 0) {
      delete alias.capabilities;
    } else {
      alias.capabilities = capabilities;
    }
  }

  applyOptionalNumber(alias, 'maxInputSize', row.maxInputSize);
  applyOptionalNumber(alias, 'maxOutputSize', row.maxOutputSize);
  applyEffortList(alias, row.supportEfforts);
  applyOptionalString(alias, 'defaultEffort', row.defaultEffort);
  applyOptionalString(alias, 'offEffort', row.offEffort);
  applyToggle(alias, 'adaptiveThinking', row.adaptiveThinking);
  applyToggle(alias, 'betaApi', row.betaApi);
  applyProtocol(alias, row.protocol);
  applyOptionalString(alias, 'reasoningKey', row.reasoningKey);
  applyOptionalString(alias, 'baseUrl', row.baseUrl);

  // The form cannot edit `overrides`, but it has to be able to drop them: the
  // engine spreads them OVER every field above (`model-auth.ts`
  // `effectiveModelConfig`), so a stale set silently defeats the edit the user
  // just made — the form reads back changed while the runtime keeps the old
  // values.
  if (row.clearOverrides === true) delete alias.overrides;

  const displayName = row.displayName.trim();
  if (displayName === '') {
    delete alias.displayName;
  } else {
    alias.displayName = displayName;
  }
  return alias;
}

/** The aliases of one provider, keyed by model id so edit rows can match them. */
function collectProviderAliases(current: KimiConfig, providerId: string): Map<string, ModelAlias> {
  const aliases = new Map<string, ModelAlias>();
  for (const [key, alias] of Object.entries(current.models ?? {})) {
    if (alias.provider !== providerId) continue;
    const canonical = key === `${providerId}/${alias.model}`;
    if (canonical || !aliases.has(alias.model)) aliases.set(alias.model, alias);
  }
  return aliases;
}

export function buildAddPatch(value: ProviderFormValue): KimiConfigPatch {
  const id = value.id.trim();
  const provider: ProviderConfig = { type: value.type };
  const baseUrl = value.baseUrl.trim();
  if (baseUrl !== '') provider.baseUrl = baseUrl;
  const apiKey = value.apiKey.trim();
  if (apiKey !== '') provider.apiKey = apiKey;
  const apiKeyEnv = (value.apiKeyEnv ?? '').trim();
  if (apiKeyEnv !== '') provider.apiKeyEnv = apiKeyEnv;
  const providerDefaultModel = (value.defaultModel ?? '').trim();
  if (providerDefaultModel !== '') provider.defaultModel = `${id}/${providerDefaultModel}`;
  const customHeaders = parseKeyValueList(value.customHeaders);
  if (Object.keys(customHeaders).length > 0) provider.customHeaders = customHeaders;
  const env = parseKeyValueList(value.env);
  if (Object.keys(env).length > 0) provider.env = env;

  const models: Record<string, ModelAlias> = {};
  for (const row of value.models) {
    models[`${id}/${row.model.trim()}`] = buildModelAlias(row, id);
  }
  return { providers: { [id]: provider }, models };
}

/**
 * Plans the edit write: `removeProvider(previousId)` first (it cascades the
 * provider's aliases and dangling default pointers), then apply the returned
 * patch.
 *
 * The patch rebuilds the provider from the previous entry so fields the form
 * does not edit survive the removal (`source`, `oauth`, ...). That guarantee
 * holds for this pure-function layer only: which keys reach disk is the engine
 * section schema's decision — the SDK-only `stream`, `temperature`, `maxTokens`
 * and `searchDisable` are dropped there. An alias matched by model id is
 * rebuilt from its old object for the same reason.
 *
 * Alias keys are NOT all rebuilt, because the removal this pairs with cascades
 * every alias whose `provider` names the previous id — including keys the form
 * never shows, such as a hand-written `[models.fast]`. A key the form does not
 * build itself is therefore CARRIED: verbatim key, unchanged model, `provider`
 * rewritten to the new id. A key is carried only while its model is still a
 * submitted row, so deleting a row still deletes its aliases, and it is never
 * carried over a key the rebuild writes — which is what keeps a rename from
 * leaving the old id behind as a second key for one model.
 *
 * The plan carries both shapes of the same write: the patch for a host that
 * merges, and {@link PlanEditWriteResult.sections} for a host that can replace
 * the affected sections in one write. `persistProviderWrite` picks between
 * them; the two leave identical configs, which is what
 * `test/utils/provider-form.test.ts` pins down. The carried keys join the same
 * `models` map that feeds both, so the two shapes agree about them too.
 */
export function planEditWrite(
  current: KimiConfig,
  value: ProviderFormValue,
  previousId: string,
  opts: PlanEditWriteOptions = {},
): PlanEditWriteResult {
  const newId = value.id.trim();
  const previousProvider = current.providers[previousId];
  const previousAliases = collectProviderAliases(current, previousId);

  const models: Record<string, ModelAlias> = {};
  for (const row of value.models) {
    const model = row.model.trim();
    models[`${newId}/${model}`] = buildModelAlias(row, newId, previousAliases.get(model));
  }

  // Alias keys this write does not build — a hand-written `[models.fast]` — are
  // carried over instead of being left to the removal, which cascades EVERY
  // alias of the previous id. Without this an edit that never mentions models
  // would delete them. A model the form no longer lists takes its keys with it,
  // and the previous id's canonical key is left to the rebuild above so a rename
  // cannot leave the old spelling behind as a second key for one model.
  const submittedModels = new Set(value.models.map((row) => row.model.trim()));
  for (const [key, alias] of Object.entries(current.models ?? {})) {
    if (alias.provider !== previousId) continue;
    if (Object.hasOwn(models, key)) continue;
    if (key === `${previousId}/${alias.model}`) continue;
    if (!submittedModels.has(alias.model.trim())) continue;
    models[key] = { ...alias, provider: newId };
  }

  const provider: ProviderConfig = { ...previousProvider, type: value.type };

  // Provider-level model pointer, when it used the old `${previousId}/...`
  // alias form. Dropped rather than rewritten when its row is gone, matching
  // the no-dangling-pointer rule of the top-level defaultModel below. A caller
  // that hands the field over below overrides this migration.
  const providerDefaultModel = previousProvider?.defaultModel;
  if (providerDefaultModel?.startsWith(`${previousId}/`) === true) {
    const nextDefaultModel = `${newId}${providerDefaultModel.slice(previousId.length)}`;
    if (nextDefaultModel in models) {
      provider.defaultModel = nextDefaultModel;
    } else {
      delete provider.defaultModel;
    }
  }

  const baseUrl = value.baseUrl.trim();
  if (baseUrl !== '') provider.baseUrl = baseUrl;

  const apiKey = value.apiKey.trim();
  if (apiKey === '') {
    if (opts.clearApiKey === true) provider.apiKey = '';
  } else {
    provider.apiKey = apiKey;
  }

  // The provider-level fields the form owns. `undefined` keeps whatever the
  // record carried; a blank value DELETES the field — the form presenting a
  // field is what makes blank read as "clear" rather than "leave alone".
  // `apiKey` and `baseUrl` above keep the older reading (blank means "keep"
  // unless the caller says otherwise) because their prompts and flags predate
  // this convention.
  if (value.apiKeyEnv !== undefined) {
    const apiKeyEnv = value.apiKeyEnv.trim();
    if (apiKeyEnv === '') {
      delete provider.apiKeyEnv;
    } else {
      provider.apiKeyEnv = apiKeyEnv;
    }
  }
  if (value.defaultModel !== undefined) {
    const pointer = value.defaultModel.trim();
    if (pointer === '') {
      delete provider.defaultModel;
    } else {
      provider.defaultModel = `${newId}/${pointer}`;
    }
  }
  if (value.customHeaders !== undefined) {
    const customHeaders = parseKeyValueList(value.customHeaders);
    if (Object.keys(customHeaders).length === 0) {
      delete provider.customHeaders;
    } else {
      provider.customHeaders = customHeaders;
    }
  }
  if (value.env !== undefined) {
    const env = parseKeyValueList(value.env);
    if (Object.keys(env).length === 0) {
      delete provider.env;
    } else {
      provider.env = env;
    }
  }

  const patch: KimiConfigPatch = { providers: { [newId]: provider }, models };

  const previousDefaultModel = current.defaultModel;
  if (previousDefaultModel !== undefined) {
    const defaultAlias = current.models?.[previousDefaultModel];
    if (defaultAlias?.provider === previousId) {
      const nextDefaultModel = `${newId}/${defaultAlias.model}`;
      if (nextDefaultModel in models) patch.defaultModel = nextDefaultModel;
    }
  }
  if (current.defaultProvider === previousId) patch.defaultProvider = newId;

  // Alias keys another provider already owns would be taken over by the
  // patch's merge; the caller refuses the write while any is reported.
  const collisions = Object.keys(models).filter((key) => {
    const existing = current.models?.[key];
    return existing !== undefined && existing.provider !== previousId;
  });
  const providerIdTaken = newId !== previousId && current.providers[newId] !== undefined;

  // The one-write shape, built on the config the removal leaves behind: every
  // surviving record plus the rebuilt ones this patch carries. Spreading over
  // the post-removal maps reproduces the engine's deep merge because a rebuilt
  // key never collides with a surviving one — the removal took the replaced
  // provider's aliases with it, and a key another provider owns is refused as a
  // collision before the write happens.
  const afterRemoval = removeProviderFromConfig(current, previousId);
  const sections: ProviderWriteSections = {
    providers: { ...afterRemoval.providers, [newId]: provider },
    // `afterRemoval.models` may be absent, and spreading that is a no-op.
    models: { ...afterRemoval.models, ...models },
    // The removal already cleared a pointer that dangled (that is why it is
    // read back rather than copied from `current`); a patch naming a
    // replacement value wins over that, and `undefined` here means "no
    // default", which the atomic write expresses as a cleared section.
    defaultModel: patch.defaultModel ?? afterRemoval.defaultModel,
    defaultProvider: patch.defaultProvider ?? afterRemoval.defaultProvider,
  };

  return { removeProviderId: previousId, patch, sections, collisions, providerIdTaken };
}
