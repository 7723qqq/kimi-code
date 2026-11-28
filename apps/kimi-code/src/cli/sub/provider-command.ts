import { DEFAULT_CATALOG_URL } from '@moonshot-ai/kimi-code-sdk/runtime';
import type { Command } from 'commander';

import { t } from '#/i18n';
import { CAPABILITY_NAMES } from '#/utils/provider-capabilities';

import type {
  CreateOptions,
  ProviderDeps,
  ResolvedProviderDeps,
  UpdateOptions,
} from './provider';

export function registerProviderCommand(parent: Command, deps?: Partial<ProviderDeps>): void {
  const provider = parent.command('provider').description(t('cli.commandDescriptions.provider'));

  // Last-resort boundary: handlers report expected failures themselves, but
  // anything that escapes (e.g. a config write rejected because config.toml
  // is invalid) must end as a one-line error + exit 1, not an unhandled
  // rejection dumping a stack trace.
  const runAction = async (
    formatError: (error: unknown) => string,
    resolved: ResolvedProviderDeps,
    run: () => Promise<void>,
  ): Promise<void> => {
    try {
      await run();
    } catch (error) {
      resolved.stderr.write(`${formatError(error)}\n`);
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
      const mod = await import('./provider');
      const resolved = await mod.resolveDeps(deps);
      await runAction(mod.errorMessage, resolved, () =>
        mod.handleProviderAdd(resolved, url, { apiKey: options.apiKey }),
      );
    });

  provider
    .command('remove <providerId>')
    .description(t('cli.commandDescriptions.providerRemove'))
    .option('--force', t('cli.optionDescriptions.providerRemoveForce'))
    .action(async (providerId: string, options: { force?: boolean }) => {
      const mod = await import('./provider');
      const resolved = await mod.resolveDeps(deps);
      await runAction(mod.errorMessage, resolved, () =>
        mod.handleProviderRemove(resolved, providerId, { force: options.force === true }),
      );
    });

  provider
    .command('list')
    .description(t('cli.commandDescriptions.providerList'))
    .option('--json', t('cli.optionDescriptions.providerListJson'), false)
    .action(async (options: { json?: boolean }) => {
      const mod = await import('./provider');
      const resolved = await mod.resolveDeps(deps);
      await runAction(mod.errorMessage, resolved, () =>
        mod.handleProviderList(resolved, { json: options.json === true }),
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
      const mod = await import('./provider');
      const resolved = await mod.resolveDeps(deps);
      await runAction(mod.errorMessage, resolved, () => mod.handleProviderCreate(resolved, options));
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
      const mod = await import('./provider');
      const resolved = await mod.resolveDeps(deps);
      await runAction(mod.errorMessage, resolved, () =>
        mod.handleProviderUpdate(resolved, providerId, options),
      );
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
        const mod = await import('./provider');
        const resolved = await mod.resolveDeps(deps);
        await runAction(mod.errorMessage, resolved, () =>
          mod.handleCatalogList(resolved, providerId, {
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
        const mod = await import('./provider');
        const resolved = await mod.resolveDeps(deps);
        await runAction(mod.errorMessage, resolved, () =>
          mod.handleCatalogAdd(resolved, providerId, {
            ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
            ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
            ...(options.url === undefined ? {} : { url: options.url }),
            ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
          }),
        );
      },
    );
}
