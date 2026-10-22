import { visibleWidth } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it } from 'bun:test';

import { setLocale, t } from '#/i18n';
import { buildMcpStatusReportLines } from '#/tui/components/messages/mcp-status-panel';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

afterEach(() => {
  setLocale('en');
});

describe('buildMcpStatusReportLines', () => {
  it('folds a multi-line server error onto one row so the panel box stays intact', () => {
    const lines = buildMcpStatusReportLines({
      servers: [
        {
          name: 'ghidra',
          transport: 'stdio',
          status: 'failed',
          toolCount: 0,
          error:
            'MCP error -32000: Connection closed\nstderr: usage: bridge_mcp_ghidra.py [-h] [--mcp-host MCP_HOST]',
        },
      ],
    }).map(strip);

    // The box renderer (UsagePanelComponent.render) treats each returned string
    // as exactly one row, so an embedded newline would punch through the border.
    for (const line of lines) {
      expect(line).not.toContain('\n');
    }

    const errorLine = lines.find((line) => line.includes('error:'));
    expect(errorLine).toContain(
      'MCP error -32000: Connection closed stderr: usage: bridge_mcp_ghidra.py [-h] [--mcp-host MCP_HOST]',
    );
  });

  it('trims and keeps a single-line error intact', () => {
    const lines = buildMcpStatusReportLines({
      servers: [
        {
          name: 'ida',
          transport: 'http',
          status: 'failed',
          toolCount: 0,
          error: '  fetch failed  ',
        },
      ],
    }).map(strip);

    const errorLine = lines.find((line) => line.includes('error:'));
    expect(errorLine).toContain('error: fetch failed');
  });

  it('renders the removed status through the locale instead of a hardcoded label', () => {
    setLocale('zh');
    const lines = buildMcpStatusReportLines({
      servers: [{ name: 'legacy', transport: 'stdio', status: 'removed', toolCount: 0 }],
    }).map(strip);

    expect(t('tui.messages.mcpStatusPanel.status.removed')).toBe('已移除');
    const row = lines.find((line) => line.trimStart().startsWith('legacy'))!;
    expect(row).toContain('已移除');
    expect(row).not.toContain('removed');
  });

  it('aligns the status and transport columns for CJK server names', () => {
    setLocale('zh');
    const lines = buildMcpStatusReportLines({
      servers: [
        { name: '飞书日历', transport: 'stdio', status: 'connected', toolCount: 3 },
        { name: 'local', transport: 'http', status: 'failed', toolCount: 0, error: 'boom' },
      ],
    }).map(strip);

    const rows = lines.filter(
      (line) => line.startsWith('  飞书日历') || line.startsWith('  local'),
    );
    expect(rows).toHaveLength(2);

    const columnOf = (line: string, value: string): number => {
      const index = line.indexOf(value);
      expect(index).toBeGreaterThanOrEqual(0);
      return visibleWidth(line.slice(0, index));
    };
    // `飞书日历` is 8 columns wide while `local` is only 5, so every later
    // column must be padded by visible width to stay aligned.
    const statusColumns = rows.map((line) =>
      columnOf(line, line.includes('已连接') ? '已连接' : '失败'),
    );
    const transportColumns = rows.map((line) =>
      columnOf(line, line.includes('stdio') ? 'stdio' : 'http'),
    );
    expect(new Set(statusColumns).size).toBe(1);
    expect(new Set(transportColumns).size).toBe(1);
    expect(new Set(rows.map((line) => visibleWidth(line))).size).toBe(1);
  });
});
