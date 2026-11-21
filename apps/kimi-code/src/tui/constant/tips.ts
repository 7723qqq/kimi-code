import { t } from '#/i18n';
export interface ToolbarTip {
  readonly text: string;
  readonly solo?: boolean;
  readonly priority?: number;
}

export const WORKING_TIPS: readonly ToolbarTip[] = [
  { text: t('tui.chrome.tips.ctrlSAddGuidance'), priority: 2, solo: true },
  { text: '/tasks to check agent activity and background tasks', priority: 2 },
  { text: t('tui.chrome.tips.initGenerateAgents'), priority: 2 },
  {
    text: t('tui.chrome.tips.pluginsKimiDatasource'),
    solo: true,
    priority: 3,
  },
  { text: 'ask Kimi to schedule tasks, e.g. "remind me at 5pm"', solo: true, priority: 3 },
  { text: t('tui.chrome.tips.sessionsBrowse'), solo: true },
  { text: t('tui.chrome.tips.goalMultiStep'), priority: 2, solo: true  },
  { text: t('tui.chrome.tips.goalNext'), solo: true },
  { text: t('tui.chrome.tips.webUi'), solo: true },
  { text: t('tui.chrome.tips.mentionFiles'), priority: 2 },
  { text: t('tui.chrome.tips.runShellCommand'), priority: 2 },
];

export const TRANSCRIPT_GROUPING_TIP: ToolbarTip = {
  text: t('tui.chrome.tips.transcriptGrouping'),
  priority: 2,
};

export const ALL_TIPS: readonly ToolbarTip[] = [
  ...WORKING_TIPS,
  { text: t('tui.chrome.tips.shiftEnterNewline') },
  { text: t('tui.chrome.tips.ctrlCCancel') },
  { text: t('tui.chrome.tips.themeSwitch') },
  { text: '/auto when you want Kimi to handle approvals and keep going; only plans in Plan mode wait for you' },
  { text: t('tui.chrome.tips.yoloMode') },
  { text: t('tui.chrome.tips.helpCommands') },
  { text: t('tui.chrome.tips.compactContext'), priority: 2 },
  { text: t('tui.chrome.tips.ctrlOToolOutput'), priority: 2 },
  { text: 'shift-tab to Plan mode to review the approach before Kimi edits files.', priority: 2 },
  { text: t('tui.chrome.tips.modelSwitch'), priority: 2 },
];
