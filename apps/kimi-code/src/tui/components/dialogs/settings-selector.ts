import { t } from '#/i18n';
import type { ThinkingDisplay, ToolCallDensity, TranscriptConfig } from '#/tui/config';

import { isExperimentalFlagEnabled } from '../../commands/experimental-flags';
import type { DockLayout } from '../chrome/dock-section';
import {
  ChoicePickerComponent,
  PreviewChoicePickerComponent,
  type ChoiceOption,
} from './choice-picker';
import { TranscriptPreview } from './transcript-preview';

const SETTINGS_SELECTION_MEMBERS = [
  'model',
  'theme',
  'tuiMode',
  'toolCallDensity',
  'thinking',
  'copyOnSelect',
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
      value: 'toolCallDensity',
      label: t('tui.dialogs.settingsSelector.toolCallDensity'),
      description: t('tui.dialogs.settingsSelector.toolCallDensityDesc'),
    },
    {
      value: 'thinking',
      label: t('tui.dialogs.settingsSelector.thinking'),
      description: t('tui.dialogs.settingsSelector.thinkingDesc'),
    },
    {
      value: 'copyOnSelect',
      label: t('tui.dialogs.settingsSelector.copyOnSelect'),
      description: t('tui.dialogs.settingsSelector.copyOnSelectDesc'),
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
  readonly fullscreen?: boolean;
  readonly onSelect: (value: SettingsSelection) => void;
  readonly onCancel: () => void;
}

export class SettingsSelectorComponent extends ChoicePickerComponent {
  constructor(opts: SettingsSelectorOptions) {
    super({
      title: t('tui.dialogs.settingsSelector.title'),
      options: getSettingsOptions().filter(
        (option) =>
          opts.fullscreen === true ||
          (option.value !== 'toolCallDensity' &&
            option.value !== 'thinking' &&
            option.value !== 'copyOnSelect'),
      ),
      onSelect: (value) => {
        if (isSettingsSelection(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}

type PickableToolCallDensity = Exclude<ToolCallDensity, 'ungrouped'>;

const TOOL_CALL_DENSITY_OPTIONS = [
  {
    value: 'compact',
    label: t('tui.dialogs.toolCallDensitySelector.compact'),
    description: t('tui.dialogs.toolCallDensitySelector.compactDesc'),
  },
  {
    value: 'balanced',
    label: t('tui.dialogs.toolCallDensitySelector.balanced'),
    description: t('tui.dialogs.toolCallDensitySelector.balancedDesc'),
  },
  {
    value: 'detailed',
    label: t('tui.dialogs.toolCallDensitySelector.detailed'),
    description: t('tui.dialogs.toolCallDensitySelector.detailedDesc'),
  },
] as const satisfies readonly (ChoiceOption & { readonly value: PickableToolCallDensity })[];

const THINKING_OPTIONS = [
  {
    value: 'grouped',
    label: t('tui.dialogs.thinkingDisplaySelector.grouped'),
    description: t('tui.dialogs.thinkingDisplaySelector.groupedDesc'),
  },
  {
    value: 'ungrouped',
    label: t('tui.dialogs.thinkingDisplaySelector.ungrouped'),
    description: t('tui.dialogs.thinkingDisplaySelector.ungroupedDesc'),
  },
] as const satisfies readonly (ChoiceOption & { readonly value: ThinkingDisplay })[];

export interface TranscriptSettingSelectorOptions<V> {
  readonly current: TranscriptConfig;
  readonly layout?: DockLayout;
  readonly onSelect: (value: V) => void;
  readonly onCancel: () => void;
}

export class ToolCallDensitySelectorComponent extends PreviewChoicePickerComponent {
  constructor(opts: TranscriptSettingSelectorOptions<PickableToolCallDensity>) {
    super({
      title: t('tui.dialogs.toolCallDensitySelector.title'),
      options: TOOL_CALL_DENSITY_OPTIONS,
      currentValue: opts.current.toolCallDensity,
      onSelect: (value) => {
        const option = TOOL_CALL_DENSITY_OPTIONS.find((candidate) => candidate.value === value);
        if (option !== undefined) opts.onSelect(option.value);
      },
      onCancel: opts.onCancel,
      preview: new TranscriptPreview(new Map(TOOL_CALL_DENSITY_OPTIONS.map(
        (option) => [option.value, { ...opts.current, toolCallDensity: option.value }],
      ))),
      layout: opts.layout,
    });
  }
}

export class ThinkingDisplaySelectorComponent extends PreviewChoicePickerComponent {
  constructor(opts: TranscriptSettingSelectorOptions<ThinkingDisplay>) {
    super({
      title: t('tui.dialogs.thinkingDisplaySelector.title'),
      options: THINKING_OPTIONS,
      currentValue: opts.current.thinking,
      onSelect: (value) => {
        const option = THINKING_OPTIONS.find((candidate) => candidate.value === value);
        if (option !== undefined) opts.onSelect(option.value);
      },
      onCancel: opts.onCancel,
      preview: new TranscriptPreview(new Map(THINKING_OPTIONS.map(
        (option) => [option.value, { ...opts.current, thinking: option.value }],
      ))),
      layout: opts.layout,
    });
  }
}

const COPY_ON_SELECT_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'on',
    label: t('tui.dialogs.copyOnSelectSelector.on'),
    description: t('tui.dialogs.copyOnSelectSelector.onDesc'),
  },
  {
    value: 'off',
    label: t('tui.dialogs.copyOnSelectSelector.off'),
    description: t('tui.dialogs.copyOnSelectSelector.offDesc'),
  },
];

export interface CopyOnSelectSelectorOptions {
  readonly currentValue: boolean;
  readonly onSelect: (value: boolean) => void;
  readonly onCancel: () => void;
}

export class CopyOnSelectSelectorComponent extends ChoicePickerComponent {
  constructor(opts: CopyOnSelectSelectorOptions) {
    super({
      title: t('tui.dialogs.copyOnSelectSelector.title'),
      options: COPY_ON_SELECT_OPTIONS,
      currentValue: opts.currentValue ? 'on' : 'off',
      onSelect: (value) => {
        if (value === 'on' || value === 'off') opts.onSelect(value === 'on');
      },
      onCancel: opts.onCancel,
    });
  }
}
