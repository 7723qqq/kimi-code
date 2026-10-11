import type { PluginInfo } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { buildPluginsInfoLines } from '#/tui/components/messages/plugins-status-panel';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function info(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: 'demo',
    displayName: 'Demo',
    version: '1.0.0',
    enabled: true,
    state: 'ok',
    skillCount: 0,
    mcpServerCount: 0,
    enabledMcpServerCount: 0,
    hookCount: 0,
    commandCount: 0,
    hasErrors: false,
    source: 'local-path',
    root: '/tmp/plugins/demo',
    installedAt: '2026-01-01T00:00:00Z',
    mcpServers: [],
    diagnostics: [],
    ...overrides,
  };
}

describe('buildPluginsInfoLines', () => {
  it('folds a multi-line diagnostic message onto one row', () => {
    const lines = buildPluginsInfoLines({
      info: info({
        hasErrors: true,
        diagnostics: [{ severity: 'error', message: 'failed to load\n  at line 2' }],
      }),
    }).map(strip);

    const row = lines.find((line) => line.includes('[error]'))!;
    expect(row).toContain('failed to load at line 2');
    for (const line of lines) expect(line).not.toContain('\n');
  });

  it('folds a multi-line stdio command onto one row', () => {
    const lines = buildPluginsInfoLines({
      info: info({
        mcpServerCount: 1,
        enabledMcpServerCount: 1,
        mcpServers: [
          {
            name: 'server',
            runtimeName: 'server',
            enabled: true,
            transport: 'stdio',
            command: 'node',
            args: ['bridge.js', '\nmcp-host'],
          },
        ],
      }),
    }).map(strip);

    const row = lines.find((line) => line.includes('bridge.js'))!;
    expect(row).toContain('node bridge.js mcp-host');
    for (const line of lines) expect(line).not.toContain('\n');
  });
});
