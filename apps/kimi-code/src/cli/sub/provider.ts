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
 */

import {
  applyCatalogProvider,
  catalogProviderModels,
  CatalogFetchError,
  RegistryImportError,
  type ImportCustomRegistryResult,
  createKimiHarnessNative,
  DEFAULT_CATALOG_URL,
  resolveCatalogImport,
  type Catalog,
  type CatalogProviderEntry,
  type KimiConfig,
  type KimiHarness,
} from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';

import { createKimiCodeHostIdentity, createKimiCodeUserAgent } from '#/cli/version';
import { t } from '#/i18n';
import { fetchCatalogOrBuiltIn } from '#/utils/catalog-fetch';
import { readStdinText } from '#/utils/process/stdin';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface ProviderDeps {
  readonly getHarness: () => KimiHarness;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly env: NodeJS.ProcessEnv;
  readonly exit: (code: number) => never;
  readonly readStdin: () => Promise<string>;
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

export async function handleProviderAdd(
  deps: ProviderDeps,
  url: string,
  opts: AddOptions,
): Promise<void> {
  const apiKey = await resolveApiKey(opts.apiKey, deps);

  const trimmedUrl = url.trim();
  if (trimmedUrl.length === 0) {
    deps.stderr.write(t('tui.statusMessages.providerUrlRequired') + '\n');
    deps.exit(1);
  }

  const harness = deps.getHarness();
  await harness.ensureConfigFile();

  // A re-import may legitimately omit the key: the SDK falls back to the one a
  // previous import from the same URL stored on its providers. Only when
  // neither exists is the key genuinely missing — and failing here beats the
  // confusing 401 the registry would otherwise answer with.
  if (apiKey === undefined && !(await hasStoredRegistryKey(harness, trimmedUrl))) {
    deps.stderr.write(t('tui.statusMessages.providerApiKeyMissing') + '\n');
    deps.exit(1);
  }

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
      `provider "${id}" declares credential env var "${envName}" — set api_key_env in config.toml to use it\n`,
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
      deps.stderr.write(`Provider "${providerId}" not found in catalog at ${url}.\n`);
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
      deps.stdout.write(`Provider "${providerId}" lists no usable models in this catalog.\n`);
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
  const apiKey = await resolveApiKey(opts.apiKey, deps);
  if (apiKey === undefined) {
    deps.stderr.write(t('tui.statusMessages.providerApiKeyMissing') + '\n');
    deps.exit(1);
  }

  const url = opts.url ?? DEFAULT_CATALOG_URL;
  const catalog = await loadCatalogOrExit(deps, url);

  const entry = catalog[providerId];
  if (entry === undefined) {
    deps.stderr.write(`Provider "${providerId}" not found in catalog at ${url}.\n`);
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
    deps.stderr.write(`Provider "${providerId}" lists no usable models in this catalog.\n`);
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
  // make `resolveThinkingEffortForModel` (agent-core-v2/src/kosong/model/thinking.ts) treat
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

  catalog
    .command('list [providerId]')
    .description(t('cli.commandDescriptions.providerCatalogList'))
    .option('--filter <substring>', t('cli.optionDescriptions.providerCatalogFilter'))
    .option('--url <url>', `Override catalog URL. Defaults to ${DEFAULT_CATALOG_URL}.`)
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
    .option('--url <url>', `Override catalog URL. Defaults to ${DEFAULT_CATALOG_URL}.`)
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
        // Native Rust harness for provider commands.
        harness ??= createKimiHarnessNative({ identity });
        return harness;
      }),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    env: overrides.env ?? process.env,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
    readStdin: overrides.readStdin ?? readStdinText,
    // The v2 harness boots an engine whose watchers hold the event loop open;
    // close it so a one-shot command can exit. No-op for injected harnesses.
    close: async () => {
      await harness?.close();
    },
  };
}

/**
 * Resolve the API key without requiring it as an argv value, which any other
 * local user can read off the process list (`ps`, Task Manager). `--api-key -`
 * reads it from stdin; otherwise `KIMI_PROVIDER_API_KEY` (or the older
 * `KIMI_REGISTRY_API_KEY`) supplies it from the environment.
 */
async function resolveApiKey(
  flag: string | undefined,
  deps: ProviderDeps,
): Promise<string | undefined> {
  if (flag === '-') {
    const fromStdin = (await deps.readStdin()).trim();
    return fromStdin.length > 0 ? fromStdin : undefined;
  }
  if (typeof flag === 'string' && flag.length > 0) return flag;
  const fromEnv = deps.env['KIMI_PROVIDER_API_KEY'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  const legacyEnv = deps.env['KIMI_REGISTRY_API_KEY'];
  if (typeof legacyEnv === 'string' && legacyEnv.length > 0) return legacyEnv;
  return undefined;
}

/**
 * Whether a previous import from `url` left an api key on its providers'
 * `source` blob. The URL is the stable identity of "the same registry" — the
 * key commonly rotates between imports — so this is what makes a keyless
 * re-import legitimate rather than a missing credential.
 */
async function hasStoredRegistryKey(harness: KimiHarness, url: string): Promise<boolean> {
  const config = await harness.getConfig();
  for (const provider of Object.values(config.providers)) {
    const source = (provider as { readonly source?: unknown }).source;
    if (source === undefined || typeof source !== 'object' || source === null) continue;
    const record = source as Record<string, unknown>;
    if (record['kind'] !== 'apiJson' || record['url'] !== url) continue;
    const key = record['apiKey'];
    if (typeof key === 'string' && key.length > 0) return true;
  }
  return false;
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
