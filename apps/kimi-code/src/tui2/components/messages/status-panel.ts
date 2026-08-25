/**
 * TUI2 status report line builder for `/status`.
 *
 * Mirrors `tui/components/messages/status-panel.ts` with the ANSI colour
 * layer removed: the tui2 transcript stores plain content and opentui
 * cannot render embedded ANSI. Column alignment, the progress bar and
 * the section structure are preserved; `commands/info.ts` wraps the
 * lines in a `UsagePanelComponent` box. The `/status` visual language
 * stays in sync with `/usage`.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import {
  effectiveModelAlias,
  type ModelAlias,
  type PermissionMode,
  type SessionStatus,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';

import { PRODUCT_NAME } from '#/constant/app';
import { t } from '#/i18n';
import {
  formatTokenCount,
  renderProgressBar,
  safeUsageRatio,
  usagePercent,
} from '#/utils/usage/usage-format';

import {
  buildExtraUsageSection,
  buildManagedUsageReportLines,
  type ManagedUsageReport,
} from './usage-panel';

interface FieldRow {
  readonly label: string;
  readonly value: string;
  readonly severity?: 'error';
}

export interface StatusReportOptions {
  readonly version: string;
  readonly model: string;
  readonly workDir: string;
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly thinkingEffort: ThinkingEffort;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  readonly contextUsage: number;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly availableModels: Record<string, ModelAlias>;
  readonly status?: SessionStatus;
  readonly statusError?: string;
  readonly managedUsage?: ManagedUsageReport;
  readonly managedUsageError?: string;
  /**
   * Rust native tools availability, probed at report time
   * (`'rust'` = addon loaded, `'js'` = TypeScript fallback).
   */
  readonly nativeTools?: 'rust' | 'js';
}

function displayModelName(alias: string, models: Record<string, ModelAlias>): string {
  const model = models[alias];
  const effective = model === undefined ? undefined : effectiveModelAlias(model);
  return effective?.displayName ?? effective?.model ?? alias;
}

function formatModelStatus(options: StatusReportOptions): string {
  const model = options.status?.model ?? options.model;
  if (model.trim().length === 0) return t('tui.messages.statusPanel.modelNotSet');

  const effort = options.status?.thinkingEffort ?? options.thinkingEffort;
  return `${displayModelName(model, options.availableModels)} (thinking ${effort})`;
}

function addFieldRows(lines: string[], rows: readonly FieldRow[]): void {
  const labelWidth = Math.max(10, ...rows.map((row) => row.label.length));
  for (const row of rows) {
    lines.push(`  ${row.label.padEnd(labelWidth, ' ')}  ${row.value}`);
  }
}

function contextValues(options: StatusReportOptions): {
  ratio: number;
  tokens: number;
  maxTokens: number;
} {
  return {
    ratio: options.status?.contextUsage ?? options.contextUsage,
    tokens: options.status?.contextTokens ?? options.contextTokens,
    maxTokens: options.status?.maxContextTokens ?? options.maxContextTokens,
  };
}

export function buildStatusReportLines(options: StatusReportOptions): string[] {
  const permission = options.status?.permission ?? options.permissionMode;
  const planMode = options.status?.planMode ?? options.planMode;
  const sessionId =
    options.sessionId.trim().length > 0
      ? options.sessionId
      : t('tui.messages.statusPanel.sessionNone');
  const rows: FieldRow[] = [
    { label: t('tui.messages.statusPanel.modelLabel'), value: formatModelStatus(options) },
    { label: t('tui.messages.statusPanel.directoryLabel'), value: options.workDir },
    { label: t('tui.messages.statusPanel.permissionsLabel'), value: permission },
    {
      label: t('tui.messages.statusPanel.planModeLabel'),
      value: planMode
        ? t('tui.messages.statusPanel.planModeOn')
        : t('tui.messages.statusPanel.planModeOff'),
    },
    {
      label: t('tui.messages.statusPanel.nativeToolsLabel'),
      value:
        options.nativeTools === 'rust'
          ? t('tui.messages.statusPanel.nativeToolsRust')
          : t('tui.messages.statusPanel.nativeToolsJs'),
    },
    { label: t('tui.messages.statusPanel.sessionLabel'), value: sessionId },
  ];
  const title = options.sessionTitle?.trim();
  if (title !== undefined && title.length > 0)
    rows.push({ label: t('tui.messages.statusPanel.titleLabel'), value: title });
  if (options.statusError !== undefined) {
    rows.push({
      label: t('tui.messages.statusPanel.warningLabel'),
      value: options.statusError,
      severity: 'error',
    });
  }

  const lines: string[] = [
    `${t('tui.messages.statusPanel.titlePrefix', { productName: PRODUCT_NAME })} ${t('tui.messages.statusPanel.titleVersion', { version: options.version })}`,
    '',
  ];
  addFieldRows(lines, rows);

  const { ratio, tokens, maxTokens } = contextValues(options);
  lines.push('');
  lines.push(t('tui.messages.statusPanel.contextWindow'));
  if (maxTokens > 0) {
    const safeRatio = safeUsageRatio(ratio);
    const bar = renderProgressBar(safeRatio, 20);
    lines.push(
      `  ${bar}  ${`${String(usagePercent(tokens, maxTokens))}%`.padStart(6, ' ')}  ` +
        `(${formatTokenCount(tokens)} / ${formatTokenCount(maxTokens)})`,
    );
  } else {
    lines.push(`  ${t('tui.messages.statusPanel.noContextData')}`);
  }

  const managedSection = buildManagedUsageReportLines({
    managedUsage: options.managedUsage,
    managedUsageError: options.managedUsageError,
  });
  if (managedSection.length > 0) {
    lines.push('');
    lines.push(...managedSection);
  }

  const extraSection = buildExtraUsageSection(options.managedUsage?.extraUsage);
  if (extraSection.length > 0) {
    lines.push('');
    lines.push(...extraSection);
  }

  return lines;
}
