import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { setLocale } from '#/i18n';
import {
  buildStatusReportLines,
  type StatusReportOptions,
} from '#/tui/components/messages/status-panel';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function statusOptions(overrides: Partial<StatusReportOptions> = {}): StatusReportOptions {
  return {
    version: '1.2.3',
    model: 'k2',
    workDir: '/tmp/project',
    sessionId: 'ses-1',
    sessionTitle: null,
    thinkingEffort: 'off',
    permissionMode: 'manual',
    planMode: false,
    towerMode: false,
    specMode: false,
    swarmMode: false,
    towerAvailable: false,
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    availableModels: {},
    ...overrides,
  };
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
      specMode: false,
      swarmMode: false,
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
        rows: [
          {
            name: '5h limit',
            usedRatio: 0.08,
            resetAt: new Date(Date.now() + 3600_000).toISOString(),
          },
        ],
      },
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('>_ Kimi Code (v1.2.3)');
    expect(output).toContain('Model        Kimi K2 (thinking high)');
    expect(output).toContain('Directory    /tmp/project');
    expect(output).toContain('Permissions  Never Ask');
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
      specMode: false,
      swarmMode: false,
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
        specMode: false,
        swarmMode: false,
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
      specMode: false,
      swarmMode: false,
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
      specMode: false,
      swarmMode: false,
      towerAvailable: true,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {},
      managedUsage: {
        rows: [],
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
      specMode: false,
      swarmMode: false,
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

  it('reports spec and swarm mode alongside plan mode', () => {
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
      specMode: true,
      swarmMode: false,
      towerAvailable: false,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {},
    }).map(strip);

    // `/status` must not report `Plan mode: off` while the footer shows a spec
    // badge — every mode the footer renders is visible here too.
    expect(lines.join('\n')).toContain('Spec mode    on');
  });

  it('lets live status override the mode snapshot', () => {
    const lines = buildStatusReportLines({
      version: '1.2.3',
      model: 'k2',
      workDir: '/tmp/project',
      sessionId: 'ses-1',
      sessionTitle: null,
      thinkingEffort: 'off',
      permissionMode: 'manual',
      planMode: true,
      towerMode: false,
      specMode: true,
      swarmMode: true,
      towerAvailable: false,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {},
      status: {
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: true,
        specMode: false,
        swarmMode: true,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      },
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('Spec mode    off');
    expect(output).toContain('Swarm mode   on');
  });

  it('keeps zh field labels aligned with their values', () => {
    setLocale('zh');
    try {
      const lines = buildStatusReportLines(
        statusOptions({
          planMode: true,
          availableModels: {
            k2: {
              provider: 'managed:kimi-code',
              model: 'kimi-k2',
              maxContextSize: 10000,
              displayName: 'Kimi K2',
            },
          },
        }),
      ).map(strip);

      const rowOf = (label: string): string => {
        const row = lines.find((line) => line.trimStart().startsWith(label));
        if (row === undefined) throw new Error(`row not found: ${label}`);
        return row;
      };
      const columnOf = (row: string, value: string): number => {
        const index = row.indexOf(value);
        expect(index).toBeGreaterThanOrEqual(0);
        return visibleWidth(row.slice(0, index));
      };

      // `模型` is only 4 columns wide while `计划模式` is 8 — the values must all
      // still start at the same visible column.
      expect(columnOf(rowOf('模型'), 'Kimi K2')).toBe(14);
      expect(columnOf(rowOf('计划模式'), '开')).toBe(14);
      expect(columnOf(rowOf('会话'), 'ses-1')).toBe(14);
    } finally {
      setLocale('en');
    }
  });

  it('folds a multi-line status error onto one field row', () => {
    const lines = buildStatusReportLines(
      statusOptions({ statusError: 'No active session\n  retry later' }),
    ).map(strip);

    const warning = lines.find((line) => line.includes('Warning'))!;
    expect(warning).toContain('No active session retry later');
    for (const line of lines) expect(line).not.toContain('\n');
  });
});
