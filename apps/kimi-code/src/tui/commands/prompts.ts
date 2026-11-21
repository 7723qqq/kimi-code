import {
  catalogModelToAlias,
  resolveCatalogImport,
  type Catalog,
  type CatalogModel,
  type ModelAlias,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { capabilitiesForModel } from '@moonshot-ai/kimi-code-oauth';
import type {
  ManagedKimiCodeModelInfo,
  OpenPlatformDefinition,
} from '@moonshot-ai/kimi-code-oauth';

import { ApiKeyInputDialogComponent, type ApiKeyInputResult } from '../components/dialogs/api-key-input-dialog';
import {
  ChoicePickerComponent,
  PreviewChoicePickerComponent,
  type ChoiceOption,
} from '../components/dialogs/choice-picker';
import { FeedbackInputDialogComponent, type FeedbackInputDialogResult } from '../components/dialogs/feedback-input-dialog';
import { ModelSelectorComponent } from '../components/dialogs/model-selector';
import { PlatformSelectorComponent } from '../components/dialogs/platform-selector';
import { DOCK_PREVIEW_ROWS } from '../constant/rendering';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';
import type { SlashCommandHost } from './dispatch';
import { t } from '#/i18n';

export function promptPlatformSelection(host: SlashCommandHost): Promise<string | undefined> {
  return new Promise((resolve) => {
    const selector = new PlatformSelectorComponent({
      onSelect: (platformId) => {
        host.restoreEditor();
        resolve(platformId);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(selector, undefined, () => {
      resolve(undefined);
    });
  });
}

export function promptLogoutProviderSelection(
  host: SlashCommandHost,
  options: readonly ChoiceOption[],
  currentValue: string | undefined,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('tui.statusMessages.selectProviderToLogout'),
      options,
      currentValue,
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

export interface FeedbackPromptResult {
  readonly value: string;
}

export function promptFeedbackInput(host: SlashCommandHost): Promise<FeedbackPromptResult | undefined> {
  return new Promise((resolve) => {
    const dialog = new FeedbackInputDialogComponent(host.state.ui, (result: FeedbackInputDialogResult) => {
      host.restoreEditor();
      resolve(result.kind === 'ok' ? { value: result.value } : undefined);
    });
    host.mountEditorReplacement(dialog);
  });
}

export type FeedbackAttachmentLevel = 'logs' | 'logs+codebase';

const FEEDBACK_ATTACHMENT_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'logs',
    label: t('tui.commands.prompts.currentSessionLogs'),
    description: t('tui.commands.prompts.uploadListedFiles'),
  },
  {
    value: 'logs+codebase',
    label: t('tui.commands.prompts.logsPlusCode'),
    description:
      t('tui.commands.prompts.alsoUploadSources'),
    descriptionTone: 'warning',
  },
];

export interface FeedbackSessionPreview {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly files: readonly string[];
}

export function promptFeedbackAttachment(
  host: SlashCommandHost,
  excludeCodebase = false,
  session?: FeedbackSessionPreview,
): Promise<FeedbackAttachmentLevel | undefined> {
  const options = excludeCodebase
    ? FEEDBACK_ATTACHMENT_OPTIONS.filter((option) => option.value !== 'logs+codebase')
    : FEEDBACK_ATTACHMENT_OPTIONS;
  let scroll = 0;
  const maxScroll = session === undefined ? 0 : Math.max(0, session.files.length - 5);
  return new Promise((resolve) => {
    const picker = new PreviewChoicePickerComponent({
      title: t('tui.commands.prompts.chooseIncluded'),
      notice:
        t('tui.commands.prompts.alwaysIncluded'),
      options,
      layout:
        host.state.dockContainer === undefined ? undefined : { maxBodyRows: DOCK_PREVIEW_ROWS },
      previewLabel:
        session === undefined
          ? t('tui.commands.prompts.sessionFilesHeading')
          : t('tui.commands.prompts.currentSessionLine', { p1: session.sessionId }),
      onPreviewScroll:
        session === undefined
          ? undefined
          : (direction) => {
              scroll = Math.max(0, Math.min(maxScroll, scroll + direction * 5));
            },
      preview: {
        render: () => {
          if (session === undefined) {
            return [t('tui.commands.prompts.fileListUnavailable')];
          }
          if (session.files.length === 0) {
            return [
              t('tui.commands.prompts.noSessionFiles'),
              '',
              t('tui.commands.prompts.zipIncludesLog'),
            ];
          }
          const shown = session.files.slice(scroll, scroll + 5);
          const last = scroll + shown.length;
          return [
            t('tui.commands.prompts.fileListRange', { p1: String(session.files.length), p2: String(scroll + 1), p3: String(last) }),
            ...shown.map((entry) => {
              const absolute = join(session.sessionDir, entry);
              return `  ${toTerminalHyperlink(absolute, pathToFileURL(absolute).href)}`;
            }),
            ...(last < session.files.length
              ? [t('tui.commands.prompts.moreFilesNextPage', { p1: String(session.files.length - last) })]
              : []),
            ...(scroll > 0 ? [t('tui.commands.prompts.previousPage')] : []),
            '',
            t('tui.commands.prompts.zipIncludesLog'),
          ];
        },
        invalidate: () => {},
        dispose: () => {},
      },
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value as FeedbackAttachmentLevel);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

export function promptApiKey(
  host: SlashCommandHost,
  platformName: string,
  subtitleLines: readonly string[] = [t('tui.commands.prompts.keySavedTo')],
): Promise<string | undefined> {
  const releaseAuthBlock = host.beginAuthBlock();
  return new Promise<string | undefined>((resolve) => {
    const dialog = new ApiKeyInputDialogComponent(
      platformName,
      subtitleLines,
      (result: ApiKeyInputResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
    );
    host.mountEditorReplacement(dialog, undefined, () => {
      resolve(undefined);
    });
  }).finally(releaseAuthBlock);
}

export function promptSshPassword(host: SlashCommandHost, environmentId: string): Promise<string | undefined> {
  const releaseAuthBlock = host.beginAuthBlock();
  return new Promise<string | undefined>((resolve) => {
    const dialog = new ApiKeyInputDialogComponent(
      environmentId,
      [t('tui.commands.prompts.passwordNotSaved')],
      (result: ApiKeyInputResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
      {
        title: t('tui.commands.prompts.sshPasswordPrompt', { p1: environmentId }),
        emptyHint: t('tui.commands.prompts.sshPasswordEmpty'),
        trimValue: false,
      },
    );
    host.mountEditorReplacement(dialog, undefined, () => {
      resolve(undefined);
    });
  }).finally(releaseAuthBlock);
}

export function promptBaseUrl(host: SlashCommandHost, platformName: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = new ApiKeyInputDialogComponent(
      platformName,
      [t('tui.statusMessages.promptBaseUrlMissingEndpoint')],
      (result: ApiKeyInputResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
      {
        title: t('tui.statusMessages.promptBaseUrlTitle', { provider: platformName }),
        mask: false,
        emptyHint: t('tui.statusMessages.promptBaseUrlEmpty'),
      },
    );
    host.mountEditorReplacement(dialog);
  });
}

export function promptCatalogProviderSelection(host: SlashCommandHost, catalog: Catalog): Promise<string | undefined> {
  return new Promise((resolve) => {
    const options: ChoiceOption[] = Object.entries(catalog)
      .filter(([, entry]) => resolveCatalogImport(entry).kind !== 'invalid')
      .map(([id, entry]) => ({
        value: id,
        label: entry.name ?? id,
        description:
          typeof entry.api === 'string' && entry.api.length > 0 ? entry.api : undefined,
      }))
      .toSorted((a, b) => a.label.localeCompare(b.label));

    if (options.length === 0) {
      host.showError(t('tui.commands.prompts.noSupportedProviders'));
      resolve(undefined);
      return;
    }

    const picker = new ChoicePickerComponent({
      title: t('tui.statusMessages.selectProviderTitle'),
      options,
      searchable: true,
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
    const firstAlias = Object.keys(modelDict)[0] ?? '';
    const caps = modelDict[firstAlias]?.capabilities ?? [];
    const initialThinking = caps.includes('always_thinking') || caps.includes('thinking');
    const selector = new ModelSelectorComponent({
      models: modelDict,
      currentValue: firstAlias,
      currentThinkingEffort: initialThinking ? 'on' : 'off',
      searchable: true,
      onSelect: ({ alias, thinking }) => {
        host.restoreEditor();
        resolve({ alias, thinking });
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(selector);
  });
}
