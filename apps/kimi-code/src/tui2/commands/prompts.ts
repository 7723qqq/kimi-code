/**
 * Shared interactive prompt helpers for slash commands — platform / logout /
 * feedback / api-key / base-url / catalog-provider / model selection dialogs.
 *
 * Status: REAL (tui2). Self-contained; no v1 re-export.
 *
 * Dialogs open through the response store's editor-replacement slot
 * (`mountEditorReplacement`), which MainShell renders in the editor
 * position; the Promise resolves from the component's onSelect / onCancel
 * callbacks.
 */
import { capabilitiesForModel } from '@moonshot-ai/kimi-code-oauth';
import type {
  ManagedKimiCodeModelInfo,
  OpenPlatformDefinition,
} from '@moonshot-ai/kimi-code-oauth';
import {
  catalogModelToAlias,
  resolveCatalogImport,
  type Catalog,
  type CatalogModel,
  type ModelAlias,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import {
  ApiKeyInputDialog,
  type ApiKeyInputResult,
} from '../components/dialogs/api-key-input-dialog';
import { ChoicePicker, type ChoiceOption } from '../components/dialogs/choice-picker';
import {
  FeedbackInputDialog,
  type FeedbackInputDialogResult,
} from '../components/dialogs/feedback-input-dialog';
import { ModelSelector } from '../components/dialogs/model-selector';
import { PlatformSelector } from '../components/dialogs/platform-selector';
import {
  asReplacement,
  mountEditorReplacement,
  restoreEditor,
} from '../utils/editor-replacement';
import type { SlashCommandHost } from './dispatch';

export function promptPlatformSelection(host: SlashCommandHost): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (host.store === undefined) {
      resolve(undefined);
      return;
    }
    mountEditorReplacement(
      host,
      asReplacement(PlatformSelector),
      {
        onSelect: (platformId: string) => {
          restoreEditor(host);
          resolve(platformId);
        },
        onCancel: () => {
          restoreEditor(host);
          resolve(undefined);
        },
      },
    );
  });
}

export function promptLogoutProviderSelection(
  host: SlashCommandHost,
  options: readonly ChoiceOption[],
  currentValue: string | undefined,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (host.store === undefined) {
      resolve(undefined);
      return;
    }
    mountEditorReplacement(
      host,
      asReplacement(ChoicePicker),
      {
        title: t('tui.statusMessages.selectProviderToLogout'),
        options,
        currentValue,
        onSelect: (value: string) => {
          restoreEditor(host);
          resolve(value);
        },
        onCancel: () => {
          restoreEditor(host);
          resolve(undefined);
        },
      },
    );
  });
}

export interface FeedbackPromptResult {
  readonly value: string;
}

export function promptFeedbackInput(
  host: SlashCommandHost,
): Promise<FeedbackPromptResult | undefined> {
  return new Promise((resolve) => {
    if (host.store === undefined) {
      resolve(undefined);
      return;
    }
    mountEditorReplacement(
      host,
      asReplacement(FeedbackInputDialog),
      {
        onDone: (result: FeedbackInputDialogResult) => {
          restoreEditor(host);
          resolve(result.kind === 'ok' ? { value: result.value } : undefined);
        },
      },
    );
  });
}

export type FeedbackAttachmentLevel = 'none' | 'logs' | 'logs+codebase';

function getFeedbackAttachmentOptions(): readonly ChoiceOption[] {
  return [
    {
      value: 'none',
      label: t('tui.statusMessages.feedbackNoAttachment'),
      description: t('tui.statusMessages.feedbackNoAttachmentDesc'),
    },
    {
      value: 'logs',
      label: t('tui.statusMessages.feedbackLogsOnly'),
      description: t('tui.statusMessages.feedbackLogsOnlyDesc'),
    },
    {
      value: 'logs+codebase',
      label: t('tui.statusMessages.feedbackLogsAndCodebase'),
      description: t('tui.statusMessages.feedbackLogsAndCodebaseDesc'),
      descriptionTone: 'warning',
    },
  ];
}

export function promptFeedbackAttachment(
  host: SlashCommandHost,
): Promise<FeedbackAttachmentLevel | undefined> {
  return new Promise((resolve) => {
    if (host.store === undefined) {
      resolve(undefined);
      return;
    }
    mountEditorReplacement(
      host,
      asReplacement(ChoicePicker),
      {
        title: t('tui.statusMessages.shareDiagnosticInfo'),
        options: getFeedbackAttachmentOptions(),
        onSelect: (value: string) => {
          restoreEditor(host);
          resolve(value as FeedbackAttachmentLevel);
        },
        onCancel: () => {
          restoreEditor(host);
          resolve(undefined);
        },
      },
    );
  });
}

export function promptApiKey(
  host: SlashCommandHost,
  platformName: string,
  subtitleLines: readonly string[] = [t('tui.statusMessages.apiKeySavedTo')],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (host.store === undefined) {
      resolve(undefined);
      return;
    }
    mountEditorReplacement(
      host,
      asReplacement(ApiKeyInputDialog),
      {
        platformName,
        subtitleLines,
        onDone: (result: ApiKeyInputResult) => {
          restoreEditor(host);
          resolve(result.kind === 'ok' ? result.value : undefined);
        },
      },
    );
  });
}

/**
 * Asks for the provider endpoint the catalog did not declare (or declared
 * only as an env placeholder) — required for catalog imports whose protocol
 * was guessed, where the built-in default endpoint would point at the wrong
 * host. Esc cancels the import.
 */
export function promptBaseUrl(
  host: SlashCommandHost,
  platformName: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (host.store === undefined) {
      resolve(undefined);
      return;
    }
    mountEditorReplacement(
      host,
      asReplacement(ApiKeyInputDialog),
      {
        platformName,
        subtitleLines: ['The catalog declares no endpoint for this provider — enter its base URL.'],
        onDone: (result: ApiKeyInputResult) => {
          restoreEditor(host);
          resolve(result.kind === 'ok' ? result.value : undefined);
        },
        title: `Enter base URL for ${platformName}`,
        mask: false,
        emptyHint: 'Base URL cannot be empty.',
      },
    );
  });
}

export function promptCatalogProviderSelection(
  host: SlashCommandHost,
  catalog: Catalog,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (host.store === undefined) {
      resolve(undefined);
      return;
    }
    const options: ChoiceOption[] = Object.entries(catalog)
      .filter(([, entry]) => resolveCatalogImport(entry).kind !== 'invalid')
      .map(([id, entry]) => ({
        value: id,
        label: entry.name ?? id,
        description: typeof entry.api === 'string' && entry.api.length > 0 ? entry.api : undefined,
      }))
      .toSorted((a, b) => a.label.localeCompare(b.label));

    if (options.length === 0) {
      host.showError(t('tui.statusMessages.catalogNoSupportedProviders'));
      resolve(undefined);
      return;
    }

    mountEditorReplacement(
      host,
      asReplacement(ChoicePicker),
      {
        title: t('tui.statusMessages.selectProviderTitle'),
        options,
        searchable: true,
        onSelect: (value: string) => {
          restoreEditor(host);
          resolve(value);
        },
        onCancel: () => {
          restoreEditor(host);
          resolve(undefined);
        },
      },
    );
  });
}

export async function promptModelSelectionForOpenPlatform(
  host: SlashCommandHost,
  models: ManagedKimiCodeModelInfo[],
  platform: OpenPlatformDefinition,
): Promise<{ model: ManagedKimiCodeModelInfo; thinking: ThinkingEffort } | undefined> {
  const modelDict: Record<string, ModelAlias> = {};
  for (const m of models) {
    modelDict[`${platform.id}/${m.id}`] = {
      provider: platform.id,
      model: m.id,
      maxContextSize: m.contextLength,
      capabilities: capabilitiesForModel(m),
      displayName: m.displayName,
    };
  }
  const selection = await runModelSelector(host, modelDict);
  if (selection === undefined) return undefined;
  const model = models.find((m) => `${platform.id}/${m.id}` === selection.alias);
  return model ? { model, thinking: selection.thinking } : undefined;
}

export async function promptModelSelectionForCatalog(
  host: SlashCommandHost,
  providerId: string,
  models: CatalogModel[],
): Promise<{ model: CatalogModel; thinking: ThinkingEffort } | undefined> {
  const modelDict: Record<string, ModelAlias> = {};
  for (const m of models) {
    modelDict[`${providerId}/${m.id}`] = catalogModelToAlias(providerId, m);
  }
  const selection = await runModelSelector(host, modelDict);
  if (selection === undefined) return undefined;
  const model = models.find((m) => `${providerId}/${m.id}` === selection.alias);
  return model ? { model, thinking: selection.thinking } : undefined;
}

export function runModelSelector(
  host: SlashCommandHost,
  modelDict: Record<string, ModelAlias>,
): Promise<{ alias: string; thinking: ThinkingEffort } | undefined> {
  return new Promise((resolve) => {
    if (host.store === undefined) {
      resolve(undefined);
      return;
    }
    const firstAlias = Object.keys(modelDict)[0] ?? '';
    const caps = modelDict[firstAlias]?.capabilities ?? [];
    const initialThinking = caps.includes('always_thinking') || caps.includes('thinking');
    mountEditorReplacement(
      host,
      asReplacement(ModelSelector),
      {
        models: modelDict,
        currentValue: firstAlias,
        currentThinkingEffort: initialThinking ? 'on' : 'off',
        searchable: true,
        onSelect: ({ alias, thinking }: { alias: string; thinking: ThinkingEffort }) => {
          restoreEditor(host);
          resolve({ alias, thinking });
        },
        onCancel: () => {
          restoreEditor(host);
          resolve(undefined);
        },
      },
    );
  });
}
