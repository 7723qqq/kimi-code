/**
 * Status report line builder for `/status`.
 *
 * It mirrors `/usage` visual language but keeps runtime status formatting
 * separate from the TUI orchestration layer.
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
import type { EngineExecution } from '#/utils/engine-execution';
import { currentTheme } from '#/tui/theme';
import {
  formatTokenCount,
  ratioSeverity,
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
  readonly towerMode: boolean;
  /** Whether the tower experiment is enabled on engine v2 — gates the Tower mode row. */
  readonly towerAvailable: boolean;
  readonly contextUsage: number;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly availableModels: Record<string, ModelAlias>;
  readonly status?: SessionStatus;
  readonly statusError?: string;
  /** Which executor ran the last turn; `undefined` when that is unknown. */
  readonly engine?: EngineExecution;
  readonly managedUsage?: ManagedUsageReport;
  readonly managedUsageError?: string;
}

type Colorize = (text: string) => string;

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

function formatEngineStatus(engine: EngineExecution | undefined): string | undefined {
  if (engine === undefined) return undefined;
  if (!engine.rust) return t('tui.messages.statusPanel.engineJsLoop');
  if (engine.transport === undefined) return t('tui.messages.statusPanel.enginePending');

  const parts = ['rust', engine.transport];
  if (engine.llmTransport !== undefined) {
    parts.push(t('tui.messages.statusPanel.engineLlm', { transport: engine.llmTransport }));
  }
  if (engine.nativeToolCalls !== undefined) {
    parts.push(
      t('tui.messages.statusPanel.engineNativeTools', { count: engine.nativeToolCalls }),
    );
  }
  return parts.join(' | ');
}

function addFieldRows(
  lines: string[],
  rows: readonly FieldRow[],
  muted: Colorize,
  value: Colorize,
  errorStyle: Colorize,
): void {
  const labelWidth = Math.max(10, ...rows.map((row) => row.label.length));
  for (const row of rows) {
    const colorize = row.severity === 'error' ? errorStyle : value;
    lines.push(`  ${muted(row.label.padEnd(labelWidth, ' '))}  ${colorize(row.value)}`);
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
  const accent = (text: string) => currentTheme.boldFg('primary', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const errorStyle = (text: string) => currentTheme.fg('error', text);
  const severityToken = (sev: 'ok' | 'warn' | 'danger'): 'error' | 'warning' | 'success' =>
    sev === 'danger' ? 'error' : sev === 'warn' ? 'warning' : 'success';

  const permission = options.status?.permission ?? options.permissionMode;
  const planMode = options.status?.planMode ?? options.planMode;
  const towerMode = options.status?.towerMode ?? options.towerMode;
  const sessionId = options.sessionId.trim().length > 0 ? options.sessionId : 'none';
  const rows: FieldRow[] = [
    { label: 'Model', value: formatModelStatus(options) },
    { label: 'Directory', value: options.workDir },
    { label: 'Permissions', value: permission },
    { label: t('tui.messages.statusPanel.planModeLabel'), value: planMode ? 'on' : 'off' },
  ];
  if (options.towerAvailable) {
    rows.push({ label: 'Tower mode', value: towerMode ? 'on' : 'off' });
  }
  const engine = formatEngineStatus(options.engine);
  if (engine !== undefined) {
    rows.push({ label: t('tui.messages.statusPanel.engineLabel'), value: engine });
  }
  rows.push({ label: 'Session', value: sessionId });
  const title = options.sessionTitle?.trim();
  if (title !== undefined && title.length > 0) rows.push({ label: 'Title', value: title });
  if (options.statusError !== undefined) {
    rows.push({ label: 'Warning', value: options.statusError, severity: 'error' });
  }

  const lines: string[] = [`${accent(`>_ ${PRODUCT_NAME}`)} ${muted(`(v${options.version})`)}`, ''];
  addFieldRows(lines, rows, muted, value, errorStyle);

  const { ratio, tokens, maxTokens } = contextValues(options);
  lines.push('');
  lines.push(accent('Context window'));
  if (maxTokens > 0) {
    const safeRatio = safeUsageRatio(ratio);
    const bar = renderProgressBar(safeRatio, 20);
    const barColoured = currentTheme.fg(severityToken(ratioSeverity(safeRatio)), bar);
    lines.push(
      `  ${barColoured}  ${value(`${String(usagePercent(tokens, maxTokens))}%`.padStart(6, ' '))}  ` +
        muted(`(${formatTokenCount(tokens)} / ${formatTokenCount(maxTokens)})`),
    );
  } else {
    lines.push(`  ${muted(t('tui.messages.statusPanel.noContextData'))}`);
  }

  const managedSection = buildManagedUsageReportLines({
    managedUsage: options.managedUsage,
    managedUsageError: options.managedUsageError,
  });
  if (managedSection.length > 0) {
    lines.push('');
    lines.push(...managedSection);
  }

  const extraSection = buildExtraUsageSection(
    options.managedUsage?.extraUsage,
    accent,
    value,
    muted,
  );
  if (extraSection.length > 0) {
    lines.push('');
    lines.push(...extraSection);
  }

  return lines;
}
