import type {
  KimiConfig,
  KimiConfigPatch,
  ModelAlias,
  ProviderConfig,
} from '@moonshot-ai/kimi-code-sdk';

/**
 * The six wire types the manual provider form offers, in the official
 * presentation order (`dist-web` AddProviderPage).
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

export interface ProviderFormModelRow {
  model: string;
  maxContextSize: string;
  displayName: string;
  /**
   * Model capabilities. Absent means "not set here": a new row writes nothing,
   * and an edited row keeps whatever the alias already declared. An empty
   * array is normalised to absent rather than written, because the engine
   * distinguishes `capabilities = []` (declares nothing, stays known) from an
   * omitted key (falls back to the model-name inference), and the form has no
   * way to express the former on purpose.
   */
  capabilities?: string[];
  maxInputSize?: string;
  maxOutputSize?: string;
  /** Ordered by strength: the default effort is the middle entry. */
  supportEfforts?: string;
  defaultEffort?: string;
  offEffort?: string;
  adaptiveThinking?: boolean;
}

export interface ProviderFormValue {
  id: string;
  type: ProviderWireType;
  apiKey: string;
  baseUrl: string;
  models: ProviderFormModelRow[];
}

export type ProviderFormError =
  | 'idRequired'
  | 'idInvalid'
  | 'apiKeyRequired'
  | 'baseUrlRequired'
  | 'modelRequired'
  | 'contextSizeRequired'
  | 'contextSizeInvalid'
  | 'modelDuplicate'
  | 'capabilityUnknown'
  | 'defaultEffortNotSupported';

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
  patch: KimiConfigPatch;
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
  if (value.baseUrl.trim() === '') return 'baseUrlRequired';
  if (value.models.length === 0) return 'modelRequired';
  for (const row of value.models) {
    if (row.model.trim() === '') return 'modelRequired';
    const maxContextSize = row.maxContextSize.trim();
    if (maxContextSize === '') return 'contextSizeRequired';
    if (!POSITIVE_INTEGER_PATTERN.test(maxContextSize) || Number(maxContextSize) < 1) {
      return 'contextSizeInvalid';
    }
  }
  for (const row of value.models) {
    for (const capability of row.capabilities ?? []) {
      if (!isCapabilityName(capability)) return 'capabilityUnknown';
    }
    if (row.defaultEffort !== undefined && row.defaultEffort.trim() !== '') {
      const efforts = parseEffortList(row.supportEfforts);
      if (efforts.length === 0) return 'defaultEffortNotSupported';
      if (!efforts.includes(row.defaultEffort.trim())) return 'defaultEffortNotSupported';
    }
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

/** Switching to `anthropic` strips a trailing `/v1` from the base URL; others keep it. */
export function normalizeBaseUrlForType(baseUrl: string, type: ProviderWireType): string {
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
  key: 'defaultEffort' | 'offEffort',
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
 * `supportEfforts` is a comma-separated list whose ORDER carries meaning — the
 * default effort is the middle entry and the persistence ceiling is derived
 * from the index — so this trims and de-duplicates while preserving the order
 * the user typed, and never sorts.
 */
function applyEffortList(alias: ModelAlias, value: string | undefined): void {
  if (value === undefined) return;
  const efforts = parseEffortList(value);
  if (efforts.length === 0) {
    delete alias.supportEfforts;
    return;
  }
  alias.supportEfforts = efforts;
}

/**
 * Rows the form did not originate (a freshly added one) carry the official
 * defaults; a row matched to an existing alias keeps every field the form
 * does not own (`maxOutputSize`, `supportEfforts`, `overrides`, ...).
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

  if (row.adaptiveThinking === true) {
    alias.adaptiveThinking = true;
  } else if (row.adaptiveThinking === false) {
    delete alias.adaptiveThinking;
  }

  const displayName = row.displayName.trim();
  if (displayName === '') {
    delete alias.displayName;
  } else {
    alias.displayName = displayName;
  }
  return alias;
}

/** The aliases of one provider, keyed by model id so edit rows can match them. */
function collectProviderAliases(
  current: KimiConfig,
  providerId: string,
): Map<string, ModelAlias> {
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
 * does not edit survive the removal (`source`, `oauth`, `customHeaders`,
 * `env`, ...). That guarantee holds for this pure-function layer only: which
 * keys reach disk is the engine section schema's decision — the SDK-only
 * `stream`, `temperature`, `maxTokens` and `searchDisable` are dropped there.
 * An alias matched by model id is rebuilt from its old object for the same
 * reason.
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

  const provider: ProviderConfig = { ...previousProvider, type: value.type };

  // Provider-level model pointer, when it used the old `${previousId}/...`
  // alias form. Dropped rather than rewritten when its row is gone, matching
  // the no-dangling-pointer rule of the top-level defaultModel below.
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

  return { removeProviderId: previousId, patch, collisions, providerIdTaken };
}
