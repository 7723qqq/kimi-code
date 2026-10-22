/**
 * Single source of truth for background-task status semantics and for the
 * display projections the tasks panel renders.
 *
 * The terminal-status set used to be re-implemented in six places (the tasks
 * browser, the output viewer, the message replay projection, the background
 * task status util, the session event handler and the subagent event
 * handler). Every caller that only needs "has this task settled?" asks here,
 * so a new terminal status cannot end up half-covered.
 */

import type { BackgroundTaskInfo, BackgroundTaskStatus } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';
import { currentTheme } from '#/tui/theme';

import { formatBytes } from './format-bytes';

const TERMINAL_TASK_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set<BackgroundTaskStatus>([
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]);

/** True once the task has settled — it will not change status again. */
export function isTerminalTaskStatus(status: BackgroundTaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

/** True while the task is still running (or otherwise not settled yet). */
export function isActiveTaskStatus(status: BackgroundTaskStatus): boolean {
  return !TERMINAL_TASK_STATUSES.has(status);
}

/** Semantic colour token for a task status. */
export type TaskStatusToken = 'success' | 'textMuted' | 'error';

export function taskStatusToken(status: BackgroundTaskStatus): TaskStatusToken {
  switch (status) {
    case 'running':
      return 'success';
    case 'completed':
      return 'textMuted';
    case 'failed':
    case 'timed_out':
    case 'killed':
    case 'lost':
      return 'error';
  }
}

/** Localized label for a task status. */
export function taskStatusLabel(status: BackgroundTaskStatus): string {
  switch (status) {
    case 'running':
      return t('tui.dialogs.tasksBrowser.statusRunning');
    case 'completed':
      return t('tui.dialogs.tasksBrowser.statusCompleted');
    case 'failed':
      return t('tui.dialogs.tasksBrowser.statusFailed');
    case 'timed_out':
      return t('tui.dialogs.tasksBrowser.statusTimedOut');
    case 'killed':
      return t('tui.dialogs.tasksBrowser.statusKilled');
    case 'lost':
      return t('tui.dialogs.tasksBrowser.statusLost');
  }
}

/** Collapse a description / command into the single line shown in the list. */
export function taskRowText(task: BackgroundTaskInfo): string {
  const description = singleLine(task.description);
  if (description.length > 0) return description;
  if (task.kind === 'process') return singleLine(task.command);
  return t('tui.dialogs.tasksBrowser.noDescription');
}

/** How long the task has been running, or how long it ran. */
export function taskElapsedLabel(task: BackgroundTaskInfo, now = Date.now()): string {
  const startedAt = task.startedAt;
  if (!Number.isFinite(startedAt) || startedAt <= 0) return '';
  if (isActiveTaskStatus(task.status)) {
    return relativeTime(now - startedAt);
  }
  const endedAt = task.endedAt;
  if (endedAt === null || endedAt === undefined || !Number.isFinite(endedAt)) return '';
  return durationLabel(Math.max(0, endedAt - startedAt));
}

/** "just now" / "3m ago" — a point in time relative to now. */
export function relativeTime(elapsedMs: number): string {
  const diffSec = Math.floor(Math.max(0, elapsedMs) / 1000);
  if (diffSec < 60) return t('tui.dialogs.tasksBrowser.relativeTimeJustNow');
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 60) return t('tui.dialogs.tasksBrowser.relativeTimeMins', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('tui.dialogs.tasksBrowser.relativeTimeHours', { hours });
  const days = Math.floor(hours / 24);
  return t('tui.dialogs.tasksBrowser.relativeTimeDays', { days });
}

/** A duration, not a point in time: "45s" / "3m 20s" / "2h 5m". */
export function durationLabel(elapsedMs: number): string {
  const totalSec = Math.floor(Math.max(0, elapsedMs) / 1000);
  if (totalSec < 60) return t('tui.dialogs.tasksBrowser.durationSeconds', { seconds: totalSec });
  const minutes = Math.floor(totalSec / 60);
  if (minutes < 60) {
    return t('tui.dialogs.tasksBrowser.durationMinutes', {
      minutes,
      seconds: totalSec % 60,
    });
  }
  const hours = Math.floor(minutes / 60);
  return t('tui.dialogs.tasksBrowser.durationHours', { hours, minutes: minutes % 60 });
}

/** Extra context the panel needs but the task record does not carry. */
export interface TaskDetailContext {
  /** Directory the task ran in. */
  readonly cwd?: string | undefined;
  /** Bytes of captured output produced so far. */
  readonly outputBytes?: number | undefined;
  /** Display name of the agent's model, resolved through the model catalog. */
  readonly modelName?: string | undefined;
}

/** One labelled group of detail lines. */
export interface TaskDetailSection {
  /** Section label, already localized and styled. */
  readonly label: string;
  /** Body lines, already styled; the panel indents them. */
  readonly lines: readonly string[];
}

/**
 * Build the detail projection of a task: what it is, where it ran and how far
 * it got, and how it ended. The narrative order is fixed — the answer to
 * "what is this doing" comes before "where is it" and "how did it end".
 */
export function taskDetailSections(
  task: BackgroundTaskInfo,
  context: TaskDetailContext = {},
): TaskDetailSection[] {
  const sections: TaskDetailSection[] = [];

  const what: string[] = [];
  const headline =
    task.kind === 'process' ? singleLine(task.command) : singleLine(task.description);
  what.push(
    currentTheme.fg('text', headline.length > 0 ? headline : t('tui.dialogs.tasksBrowser.noDescription')),
  );
  const tags: string[] = [];
  if (task.kind === 'agent') {
    if (task.subagentType !== undefined && task.subagentType.length > 0) {
      tags.push(
        `${currentTheme.fg('textMuted', t('tui.dialogs.tasksBrowser.labelType'))}: ${currentTheme.fg('accent', task.subagentType)}`,
      );
    }
    const model = context.modelName ?? task.model;
    if (model !== undefined && model.length > 0) {
      tags.push(
        `${currentTheme.fg('textMuted', t('tui.dialogs.tasksBrowser.labelModel'))}: ${currentTheme.fg('accent', model)}`,
      );
    }
  }
  if (tags.length > 0) what.push(tags.join(' · '));
  sections.push({ label: sectionLabel('sectionWhat'), lines: what });

  const where: string[] = [];
  if (context.cwd !== undefined && context.cwd.length > 0) {
    where.push(currentTheme.fg('textDim', context.cwd));
  }
  const elapsed = taskElapsedLabel(task);
  if (elapsed.length > 0) where.push(currentTheme.fg('textMuted', elapsed));
  if (context.outputBytes !== undefined && context.outputBytes > 0) {
    where.push(currentTheme.fg('textMuted', formatBytes(context.outputBytes)));
  }
  if (where.length > 0) {
    sections.push({ label: sectionLabel('sectionWhere'), lines: [where.join(' · ')] });
  }

  if (isTerminalTaskStatus(task.status)) {
    const outcome: string[] = [];
    if (task.kind === 'process' && task.exitCode !== null) {
      outcome.push(
        `${currentTheme.fg('textMuted', t('tui.dialogs.tasksBrowser.labelExitCode'))}: ${currentTheme.fg('text', String(task.exitCode))}`,
      );
    }
    if (task.stopReason !== undefined && task.stopReason.length > 0) {
      outcome.push(
        `${currentTheme.fg('textMuted', t('tui.dialogs.tasksBrowser.labelReason'))}: ${currentTheme.fg('text', task.stopReason)}`,
      );
    }
    if (outcome.length > 0) {
      sections.push({ label: sectionLabel('sectionOutcome'), lines: [outcome.join(' · ')] });
    }
  }

  return sections;
}

/**
 * The noisy identifier fields, hidden by default and revealed by the raw
 * view. The task id is not part of this group — it is demoted to the last
 * line of the detail instead.
 */
export function taskRawFields(task: BackgroundTaskInfo): TaskDetailSection {
  const lines: string[] = [];
  if (task.kind === 'process' && task.pid > 0) {
    lines.push(
      `${currentTheme.fg('textMuted', t('tui.dialogs.tasksBrowser.labelPid'))}: ${currentTheme.fg('text', String(task.pid))}`,
    );
  }
  if (task.kind === 'agent' && task.agentId !== undefined) {
    lines.push(
      `${currentTheme.fg('textMuted', t('tui.dialogs.tasksBrowser.labelAgentId'))}: ${currentTheme.fg('text', task.agentId)}`,
    );
  }
  if (task.kind === 'agent' && task.thinkingEffort !== undefined) {
    lines.push(
      `${currentTheme.fg('textMuted', t('tui.dialogs.tasksBrowser.labelEffort'))}: ${currentTheme.fg('text', task.thinkingEffort)}`,
    );
  }
  if (task.kind === 'question' && task.toolCallId !== undefined) {
    lines.push(
      `${currentTheme.fg('textMuted', t('tui.dialogs.tasksBrowser.labelToolCall'))}: ${currentTheme.fg('text', task.toolCallId)}`,
    );
  }
  return { label: sectionLabel('sectionRaw'), lines };
}

/** The task id, demoted to the last line of the detail. */
export function taskIdLine(task: BackgroundTaskInfo): string {
  return `${currentTheme.fg('textMuted', t('tui.dialogs.tasksBrowser.labelTaskId'))}: ${currentTheme.fg('textDim', task.taskId)}`;
}

function sectionLabel(key: 'sectionWhat' | 'sectionWhere' | 'sectionOutcome' | 'sectionRaw'): string {
  switch (key) {
    case 'sectionWhat':
      return currentTheme.boldFg('textStrong', t('tui.dialogs.tasksBrowser.sectionWhat'));
    case 'sectionWhere':
      return currentTheme.boldFg('textStrong', t('tui.dialogs.tasksBrowser.sectionWhere'));
    case 'sectionOutcome':
      return currentTheme.boldFg('textStrong', t('tui.dialogs.tasksBrowser.sectionOutcome'));
    case 'sectionRaw':
      return currentTheme.boldFg('textStrong', t('tui.dialogs.tasksBrowser.sectionRaw'));
  }
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}
