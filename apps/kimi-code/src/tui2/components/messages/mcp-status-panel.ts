/**
 * TUI2 MCP status report line builder for `/mcp`.
 *
 * Mirrors `tui/components/messages/mcp-status-panel.ts` with the ANSI
 * colour layer removed: the tui2 transcript stores plain content and
 * opentui cannot render embedded ANSI. Sorting, column alignment, the
 * per-status summary and the error/action sub-lines are preserved;
 * `commands/info.ts` wraps the lines in a `UsagePanelComponent` box.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { McpServerInfo } from '@moonshot-ai/kimi-code-sdk';

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
      return 'removed';
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

/**
 * Collapse a (possibly multi-line) MCP error into a single line. The status
 * panel renders each returned string as exactly one boxed row, so an
 * embedded newline — e.g. the `\nstderr: ...` a failed stdio server
 * appends — would drop the trailing text to column 0 and punch through the
 * border. Folding every run of whitespace to a single space keeps the error
 * on one row, which the panel then truncates to the available width.
 */
function formatErrorLine(error: string): string {
  return error.trim().replaceAll(/\s+/g, ' ');
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

  const lines: string[] = [t('tui.messages.mcpStatusPanel.servers')];

  if (servers.length === 0) {
    lines.push(`  ${t('tui.messages.mcpStatusPanel.noServers')}`);
    return lines;
  }

  const nameWidth = Math.max(
    t('tui.messages.mcpStatusPanel.nameLabel').length,
    ...servers.map((server) => server.name.length),
  );
  const statusWidth = Math.max(
    t('tui.messages.mcpStatusPanel.statusLabel').length,
    ...servers.map((server) => statusLabel(server.status).length),
  );
  const transportWidth = Math.max(
    t('tui.messages.mcpStatusPanel.transportLabel').length,
    ...servers.map((server) => server.transport.length),
  );

  lines.push(
    `  ${t('tui.messages.mcpStatusPanel.nameLabel').padEnd(nameWidth)}  ${t(
      'tui.messages.mcpStatusPanel.statusLabel',
    ).padEnd(statusWidth)}  ${t('tui.messages.mcpStatusPanel.transportLabel').padEnd(transportWidth)}  ${t(
      'tui.messages.mcpStatusPanel.toolsLabel',
    )}`,
  );

  for (const server of servers) {
    lines.push(
      `  ${server.name.padEnd(nameWidth)}  ${statusLabel(server.status).padEnd(statusWidth)}  ${server.transport.padEnd(transportWidth)}  ${formatToolCount(server)}`,
    );

    if (
      server.status === 'failed' &&
      server.error !== undefined &&
      server.error.trim().length > 0
    ) {
      lines.push(
        `    ${t('tui.messages.mcpStatusPanel.errorLabel')} ${formatErrorLine(server.error)}`,
      );
    }
    if (server.status === 'needs-auth') {
      lines.push(
        `    ${t('tui.messages.mcpStatusPanel.actionLabel')} ${t('tui.messages.mcpStatusPanel.actionLogin', { name: server.name })}`,
      );
    }
  }

  lines.push('');
  lines.push(`  ${buildSummary(servers)}`);
  lines.push(`  ${t('tui.messages.mcpStatusPanel.configureWith')} /mcp-config`);

  return lines;
}
