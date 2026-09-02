import { describe, expect, it } from 'vitest';

import { buildStatusReportLines } from '#/tui/components/messages/status-panel';

const newline = String.fromCharCode(10);

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('status panel report lines', () => {
  it('formats runtime status, context, and managed usage without account or AGENTS.md rows', () => {
    const lines = buildStatusReportLines({
      version: '1.2.3',
      model: 'k2',
      workDir: '/tmp/project',
      sessionId: 'ses-1',
      sessionTitle: 'Implement status',
      thinkingEffort: 'on',
      permissionMode: 'manual',
      planMode: false,
      towerMode: false,
      towerAvailable: true,
      contextUsage: 0.25,
      contextTokens: 2500,
      maxContextTokens: 10000,
      availableModels: {
        k2: {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          maxContextSize: 10000,
          displayName: 'Kimi K2',
        },
      },
      status: {
        model: 'k2',
        thinkingEffort: 'high',
        permission: 'auto',
        planMode: true,
        contextTokens: 3000,
        maxContextTokens: 12000,
        contextUsage: 0.25,
      },
      managedUsage: {
        summary: null,
        limits: [
          {
            window: { duration: 5, unit: 'hour' },
            used: 8,
            limit: 100,
            resetAt: new Date(Date.now() + 3600_000).toISOString(),
          },
        ],
      },
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('>_ Kimi Code (v1.2.3)');
    expect(output).toContain('Model        Kimi K2 (thinking high)');
    expect(output).toContain('Directory    /tmp/project');
    expect(output).toContain('Permissions  auto');
    expect(output).toContain('Plan mode    on');
    expect(output).toContain('Session      ses-1');
    expect(output).toContain('Title        Implement status');
    expect(output).toContain('Context window');
    expect(output).toContain('25%');
    expect(output).toContain('(2.9k / 11.7k)');
    expect(output).toContain('Plan usage');
    expect(output).toContain('5h limit');
    expect(output).toContain('8% used');
    expect(output).not.toContain('Account');
    expect(output).not.toContain('AGENTS.md');
    expect(output).not.toContain('Runtime');
  });

  const engineBase = {
    version: '1.2.3',
    model: 'k2',
    workDir: '/tmp/project',
    sessionId: 'ses-1',
    sessionTitle: null,
    thinkingEffort: 'on' as const,
    permissionMode: 'manual' as const,
    planMode: false,
    towerMode: false,
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    availableModels: {},
    towerAvailable: false,
  };

  it('omits the Engine row when no executor decision has been recorded', () => {
    const output = buildStatusReportLines({ ...engineBase }).join(newline);
    expect(output).not.toContain('Engine');
  });

  it('names the JS loop when the engine was declined', () => {
    const output = buildStatusReportLines({ ...engineBase, engine: { rust: false } }).join(newline);
    expect(output).toContain('Engine');
    expect(output).toContain('js (v2 loop)');
  });

  it('says a wired engine has not run a turn yet, rather than guessing a transport', () => {
    const output = buildStatusReportLines({ ...engineBase, engine: { rust: true } }).join(newline);
    expect(output).toContain('rust (wired, no turn yet)');
  });

  it('shows the resolved transport plus the engine-reported llm path and native tool count', () => {
    const output = buildStatusReportLines({
      ...engineBase,
      engine: { rust: true, transport: 'napi', llmTransport: 'native-http', nativeToolCalls: 3 },
    }).join(newline);
    expect(output).toContain('rust | napi | llm native-http | native tools: 3');
  });

  it('keeps a zero native-tool count visible as a fact, not a missing value', () => {
    const output = buildStatusReportLines({
      ...engineBase,
      engine: { rust: true, transport: 'stdio', llmTransport: 'host-proxy', nativeToolCalls: 0 },
    }).join(newline);
    expect(output).toContain('rust | stdio | llm host-proxy | native tools: 0');
  });

  it('explains why the LLM was served through the host proxy', () => {
    const output = buildStatusReportLines({
      ...engineBase,
      engine: {
        rust: true,
        transport: 'napi',
        llmTransport: 'host-proxy',
        llmFallbackReason: 'provider "main" has no static baseUrl + apiKey',
        nativeToolCalls: 0,
      },
    }).join(newline);
    expect(output).toContain('llm host-proxy | llm proxy reason: provider "main" has no static');
    expect(output).toContain('native tools: 0');
  });

  it('prefers the fetched status tower mode over the cached value', () => {
    const lines = buildStatusReportLines({
      version: '1.2.3',
      model: 'k2',
      workDir: '/tmp/project',
      sessionId: 'ses-1',
      sessionTitle: null,
      thinkingEffort: 'off',
      permissionMode: 'manual',
      planMode: false,
      towerMode: false,
      towerAvailable: true,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {},
      status: {
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: false,
        towerMode: true,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      },
    }).map(strip);

    expect(lines.join('\n')).toContain('Tower mode   on');
  });

  it('omits the tower mode row when the experiment is unavailable', () => {
    const lines = buildStatusReportLines({
      version: '1.2.3',
      model: 'k2',
      workDir: '/tmp/project',
      sessionId: 'ses-1',
      sessionTitle: null,
      thinkingEffort: 'off',
      permissionMode: 'manual',
      planMode: false,
      towerMode: false,
      towerAvailable: false,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {},
    }).map(strip);

    expect(lines.join('\n')).not.toContain('Tower mode');
  });

  it('formats extra usage section in status report', () => {
    const lines = buildStatusReportLines({
      version: '1.2.3',
      model: 'k2',
      workDir: '/tmp/project',
      sessionId: 'ses-1',
      sessionTitle: null,
      thinkingEffort: 'off',
      permissionMode: 'manual',
      planMode: false,
      towerMode: false,
      towerAvailable: true,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {},
      managedUsage: {
        summary: null,
        limits: [],
        extraUsage: {
          balanceCents: 15000,
          totalCents: 20000,
          monthlyChargeLimitEnabled: true,
          monthlyChargeLimitCents: 20000,
          monthlyUsedCents: 5000,
          currency: 'USD',
        },
      },
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('Extra Usage');
    expect(output).toContain('Balance');
    expect(output).toContain('150.00');
    expect(output).toContain('Used this month');
    expect(output).toContain('50.00');
    expect(output).toContain('Monthly limit');
    expect(output).toContain('200.00');
  });

  it('falls back to app state and shows status load errors as warnings', () => {
    const lines = buildStatusReportLines({
      version: '1.2.3',
      model: '',
      workDir: '/tmp/project',
      sessionId: '',
      sessionTitle: null,
      thinkingEffort: 'off',
      permissionMode: 'manual',
      planMode: false,
      towerMode: false,
      towerAvailable: true,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {},
      statusError: 'No active session',
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('Model        not set');
    expect(output).toContain('Session      none');
    expect(output).toContain('Warning      No active session');
    expect(output).toContain('No context window data available.');
  });
});
