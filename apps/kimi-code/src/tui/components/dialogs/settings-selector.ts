import { t } from '#/i18n';

import { isExperimentalFlagEnabled } from '../../commands/experimental-flags';
import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const SETTINGS_SELECTION_MEMBERS = [
  'model',
  'theme',
  'tuiMode',
  'mermaid',
  'editor',
  'language',
  'permission',
  'survey',
  'experiments',
  'upgrade',
  'usage',
  'github_token',
  'astron',
  'promptOptimizer',
] as const;

export type SettingsSelection = (typeof SETTINGS_SELECTION_MEMBERS)[number];

/**
 * An option whose value the guard is guaranteed to accept.
 *
 * Without this, `getSettingsOptions` could add a value the members list does
 * not know about and the picker would silently drop the selection — the shape
 * of the original missing-`promptOptimizer` bug. Narrowing `value` here makes
 * that divergence a type error instead of a dead click.
 */
interface SettingsChoiceOption extends ChoiceOption {
  readonly value: SettingsSelection;
}

function getSettingsOptions(): readonly SettingsChoiceOption[] {
  const options: SettingsChoiceOption[] = [
    {
      value: 'model',
      label: t('tui.dialogs.settingsSelector.model'),
      description: t('tui.dialogs.settingsSelector.modelDesc'),
    },
    {
      value: 'permission',
      label: t('tui.dialogs.settingsSelector.permission'),
      description: t('tui.dialogs.settingsSelector.permissionDesc'),
    },
    {
      value: 'theme',
      label: t('tui.dialogs.settingsSelector.theme'),
      description: t('tui.dialogs.settingsSelector.themeDesc'),
    },
    {
      value: 'tuiMode',
      label: t('tui.dialogs.settingsSelector.tuiMode'),
      description: t('tui.dialogs.settingsSelector.tuiModeDesc'),
    },
    {
      value: 'mermaid',
      label: t('tui.dialogs.settingsSelector.mermaid'),
      description: t('tui.dialogs.settingsSelector.mermaidDesc'),
    },
    {
      value: 'language',
      label: t('tui.dialogs.settingsSelector.language'),
      description: t('tui.dialogs.settingsSelector.languageDesc'),
    },
    {
      value: 'editor',
      label: t('tui.dialogs.settingsSelector.editor'),
      description: t('tui.dialogs.settingsSelector.editorDesc'),
    },
    {
      value: 'survey',
      label: t('tui.dialogs.settingsSelector.survey'),
      description: t('tui.dialogs.settingsSelector.surveyDesc'),
    },
    {
      value: 'experiments',
      label: t('tui.dialogs.settingsSelector.experiments'),
      description: t('tui.dialogs.settingsSelector.experimentsDesc'),
    },
    {
      value: 'upgrade',
      label: t('tui.dialogs.settingsSelector.upgrade'),
      description: t('tui.dialogs.settingsSelector.upgradeDesc'),
    },
    {
      value: 'usage',
      label: t('tui.dialogs.settingsSelector.usage'),
      description: t('tui.dialogs.settingsSelector.usageDesc'),
    },
    {
      value: 'github_token',
      label: t('tui.dialogs.settingsSelector.githubToken'),
      description: t('tui.dialogs.settingsSelector.githubTokenDesc'),
    },
  ];
  // Astron settings are gated behind the same experimental flag as the
  // /login Astron platform option.
  if (isExperimentalFlagEnabled('xunfei_coding_plan')) {
    options.push({
      value: 'astron',
      label: t('tui.dialogs.settingsSelector.astron'),
      description: t('tui.dialogs.settingsSelector.astronDesc'),
    });
  }
  if (isExperimentalFlagEnabled('prompt_optimizer')) {
    options.push({
      value: 'promptOptimizer',
      label: t('tui.dialogs.settingsSelector.promptOptimizer'),
      description: t('tui.dialogs.settingsSelector.promptOptimizerDesc'),
    });
  }
  return options;
}

function isSettingsSelection(value: string): value is SettingsSelection {
  return (SETTINGS_SELECTION_MEMBERS as readonly string[]).includes(value);
}

export interface SettingsSelectorOptions {
  readonly onSelect: (value: SettingsSelection) => void;
  readonly onCancel: () => void;
}

export class SettingsSelectorComponent extends ChoicePickerComponent {
  constructor(opts: SettingsSelectorOptions) {
    super({
      title: t('tui.dialogs.settingsSelector.title'),
      options: [...getSettingsOptions()],
      onSelect: (value) => {
        if (isSettingsSelection(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
