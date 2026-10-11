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

export interface ProviderFormModelRow {
  model: string;
  maxContextSize: string;
  displayName: string;
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
  | 'modelDuplicate';

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

export function defaultModelRow(): ProviderFormModelRow {
  return { model: '', maxContextSize: '', displayName: '' };
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
    ...(previous ?? { capabilities: ['tool_use', 'thinking'], adaptiveThinking: true }),
    provider: providerId,
    model: row.model.trim(),
    maxContextSize: Number(row.maxContextSize.trim()),
  };
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
