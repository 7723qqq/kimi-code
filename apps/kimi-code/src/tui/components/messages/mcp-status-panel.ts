import type { McpServerInfo } from '@moonshot-ai/kimi-code-sdk';
import { visibleWidth } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { currentTheme } from '#/tui/theme';

import { foldToSingleLine } from './usage-panel';

/** Pad `text` to `width` visible columns (CJK-safe, unlike `padEnd`). */
function padEndVisible(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
}

export interface McpStatusReportOptions {
  readonly servers: readonly McpServerInfo[];
}

const STATUS_PRIORITY: Record<McpServerInfo['status'], number> = {
  failed: 0,
  'needs-auth': 1,
  pending: 2,
  connected: 3,
  disabled: 4,
  removed: 5,
};

function statusLabel(status: McpServerInfo['status']): string {
  switch (status) {
    case 'connected':
      return t('tui.messages.mcpStatusPanel.status.connected');
    case 'pending':
      return t('tui.messages.mcpStatusPanel.status.pending');
    case 'needs-auth':
      return t('tui.messages.mcpStatusPanel.status.needsAuth');
    case 'failed':
      return t('tui.messages.mcpStatusPanel.status.failed');
    case 'disabled':
      return t('tui.messages.mcpStatusPanel.status.disabled');
    case 'removed':
      return t('tui.messages.mcpStatusPanel.status.removed');
  }
}

const SUMMARY_ORDER: readonly McpServerInfo['status'][] = [
  'connected',
  'pending',
  'needs-auth',
  'failed',
  'disabled',
  'removed',
];

function statusPainter(status: McpServerInfo['status']): (text: string) => string {
  switch (status) {
    case 'connected':
      return (text) => currentTheme.fg('success', text);
    case 'failed':
      return (text) => currentTheme.fg('error', text);
    case 'needs-auth':
    case 'pending':
      return (text) => currentTheme.fg('warning', text);
    case 'disabled':
    case 'removed':
      return (text) => currentTheme.fg('textDim', text);
  }
}

function formatToolCount(server: McpServerInfo): string {
  if (server.status === 'disabled' || server.status === 'removed') {
    return t('tui.messages.mcpStatusPanel.disabledToolCount');
  }
  return t(
    server.toolCount === 1
      ? 'tui.messages.mcpStatusPanel.tool_one'
      : 'tui.messages.mcpStatusPanel.tool_other',
    { count: server.toolCount },
  );
}

function formatToolsAvailable(count: number): string {
  return t('tui.messages.mcpStatusPanel.toolsAvailable', { count });
}

function sortedServers(servers: readonly McpServerInfo[]): McpServerInfo[] {
  return servers.toSorted(
    (a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || a.name.localeCompare(b.name),
  );
}

function buildSummary(servers: readonly McpServerInfo[]): string {
  const counts: Partial<Record<McpServerInfo['status'], number>> = {};
  let toolsAvailable = 0;
  for (const server of servers) {
    counts[server.status] = (counts[server.status] ?? 0) + 1;
    if (server.status === 'connected') toolsAvailable += server.toolCount;
  }
  const parts: string[] = [];
  for (const status of SUMMARY_ORDER) {
    const n = counts[status];
    if (n === undefined || n === 0) continue;
    parts.push(`${n} ${statusLabel(status)}`);
  }
  parts.push(formatToolsAvailable(toolsAvailable));
  return parts.join(' · ');
}

export function buildMcpStatusReportLines(options: McpStatusReportOptions): string[] {
  const servers = sortedServers(options.servers);
  const accent = (text: string) => currentTheme.boldFg('primary', text);
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const error = (text: string) => currentTheme.fg('error', text);

  const lines: string[] = [accent(t('tui.messages.mcpStatusPanel.servers'))];

  if (servers.length === 0) {
    lines.push(muted(`  ${t('tui.messages.mcpStatusPanel.noServers')}`));
    return lines;
  }

  const nameWidth = Math.max(
    visibleWidth(t('tui.messages.mcpStatusPanel.nameLabel')),
    ...servers.map((server) => visibleWidth(server.name)),
  );
  const statusWidth = Math.max(
    visibleWidth(t('tui.messages.mcpStatusPanel.statusLabel')),
    ...servers.map((server) => visibleWidth(statusLabel(server.status))),
  );
  const transportWidth = Math.max(
    visibleWidth(t('tui.messages.mcpStatusPanel.transportLabel')),
    ...servers.map((server) => visibleWidth(server.transport)),
  );

  lines.push(
    `  ${muted(padEndVisible(t('tui.messages.mcpStatusPanel.nameLabel'), nameWidth))}  ${muted(
      padEndVisible(t('tui.messages.mcpStatusPanel.statusLabel'), statusWidth),
    )}  ${muted(
      padEndVisible(t('tui.messages.mcpStatusPanel.transportLabel'), transportWidth),
    )}  ${muted(t('tui.messages.mcpStatusPanel.toolsLabel'))}`,
  );

  for (const server of servers) {
    const status = statusPainter(server.status)(
      padEndVisible(statusLabel(server.status), statusWidth),
    );
    lines.push(
      `  ${value(padEndVisible(server.name, nameWidth))}  ${status}  ${muted(
        padEndVisible(server.transport, transportWidth),
      )}  ${value(formatToolCount(server))}`,
    );

    if (
      server.status === 'failed' &&
      server.error !== undefined &&
      server.error.trim().length > 0
    ) {
      lines.push(
        `    ${muted(t('tui.messages.mcpStatusPanel.errorLabel'))} ${error(foldToSingleLine(server.error))}`,
      );
    }
    if (server.status === 'needs-auth') {
      lines.push(
        `    ${muted(t('tui.messages.mcpStatusPanel.actionLabel'))} ${value(
          t('tui.messages.mcpStatusPanel.actionLogin', { name: server.name }),
        )}`,
      );
    }
  }

  lines.push('');
  lines.push(`  ${value(buildSummary(servers))}`);
  lines.push(`  ${muted(t('tui.messages.mcpStatusPanel.configureWith'))} ${value('/mcp-config')}`);

  return lines;
}
