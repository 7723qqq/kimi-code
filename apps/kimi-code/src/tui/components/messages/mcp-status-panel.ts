import type { McpServerInfo } from '@moonshot-ai/kimi-code-sdk';

import { currentTheme } from '#/tui/theme';
import { t } from '#/i18n';

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

const STATUS_LABEL: Record<McpServerInfo['status'], string> = {
  connected: t('tui.messages.mcpStatusPanel.status.connected'),
  pending: t('tui.messages.mcpStatusPanel.status.pending'),
  'needs-auth': t('tui.messages.mcpStatusPanel.status.needsAuth'),
  failed: t('tui.messages.mcpStatusPanel.status.failed'),
  disabled: t('tui.messages.mcpStatusPanel.status.disabled'),
  removed: t('tui.messages.mcpStatusPanel.status.removed'),
};

const SUMMARY_ORDER: readonly McpServerInfo['status'][] = [
  'connected',
  'pending',
  'needs-auth',
  'failed',
  'disabled',
  'removed',
];

function statusPainter(
  status: McpServerInfo['status'],
): (text: string) => string {
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
  if (server.status === 'disabled' || server.status === 'removed') return t('tui.messages.mcpStatusPanel.disabledToolCount');
  return `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`;
}

function formatToolsAvailable(count: number): string {
  return `${count} tool${count === 1 ? '' : 's'} available`;
}

function formatErrorLine(error: string): string {
  return error.trim().replaceAll(/\s+/g, ' ');
}

function sortedServers(servers: readonly McpServerInfo[]): McpServerInfo[] {
  return servers.toSorted(
    (a, b) =>
      STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || a.name.localeCompare(b.name),
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
    parts.push(`${n} ${STATUS_LABEL[status]}`);
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
    lines.push(muted(t('tui.messages.mcpStatusPanel.noServers')));
    return lines;
  }

  const nameWidth = Math.max(t('tui.messages.mcpStatusPanel.nameLabel').length, ...servers.map((server) => server.name.length));
  const statusWidth = Math.max(
    t('tui.messages.mcpStatusPanel.statusLabel').length,
    ...servers.map((server) => STATUS_LABEL[server.status].length),
  );
  const transportWidth = Math.max(
    t('tui.messages.mcpStatusPanel.transportLabel').length,
    ...servers.map((server) => server.transport.length),
  );

  lines.push(
    `  ${muted(t('tui.messages.mcpStatusPanel.nameLabel').padEnd(nameWidth))}  ${muted(t('tui.messages.mcpStatusPanel.statusLabel').padEnd(statusWidth))}  ${muted(
      t('tui.messages.mcpStatusPanel.transportLabel').padEnd(transportWidth),
    )}  ${muted(t('tui.messages.mcpStatusPanel.toolsLabel'))}`,
  );

  for (const server of servers) {
    const status = statusPainter(
      server.status,
    )(STATUS_LABEL[server.status].padEnd(statusWidth));
    lines.push(
      `  ${value(server.name.padEnd(nameWidth))}  ${status}  ${muted(
        server.transport.padEnd(transportWidth),
      )}  ${value(formatToolCount(server))}`,
    );

    if (
      server.status === 'failed' &&
      server.error !== undefined &&
      server.error.trim().length > 0
    ) {
      lines.push(`    ${muted(t('tui.messages.mcpStatusPanel.errorLabel'))} ${error(formatErrorLine(server.error))}`);
    }
    if (server.status === 'needs-auth') {
      lines.push(`    ${muted(t('tui.messages.mcpStatusPanel.actionLabel'))} ${value(`run /mcp-config login ${server.name}`)}`);
    }
  }

  lines.push('');
  lines.push(`  ${value(buildSummary(servers))}`);
  lines.push(`  ${muted(t('tui.messages.mcpStatusPanel.configureWith'))} ${value('/mcp-config')}`);

  return lines;
}
