/**
 * Tests for the `/status` report builder (`tui2/components/messages/
 * status-panel.ts`) — pins the tower-mode and packaged-engine rows added for
 * v1 parity (`tui/commands/info.ts`).
 */

import { describe, expect, it } from 'vitest';

import { buildStatusReportLines, type StatusReportOptions } from '@/tui2/components/messages/status-panel'

function baseOptions(overrides: Partial<StatusReportOptions> = {}): StatusReportOptions {
  return {
    version: '0.0.0-test',
    model: '',
    workDir: '/ws',
    sessionId: '',
    sessionTitle: null,
    thinkingEffort: 'off',
    permissionMode: 'manual',
    planMode: false,
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    availableModels: {},
    ...overrides,
  };
}

describe('status report tower rows', () => {
  it('shows the Tower mode row only when tower is available', () => {
    const withoutTower = buildStatusReportLines(baseOptions({ towerAvailable: false, towerMode: true }));
    expect(withoutTower.some((line) => line.includes('Tower mode'))).toBe(false);

    const withTower = buildStatusReportLines(baseOptions({ towerAvailable: true, towerMode: true }));
    expect(withTower.some((line) => line.includes('Tower mode') && line.trimEnd().endsWith('on'))).toBe(true);
  });

  it('prefers the runtime status tower mode over the fallback', () => {
    const lines = buildStatusReportLines(
      baseOptions({
        towerAvailable: true,
        towerMode: true,
        status: {
          thinkingEffort: 'off',
          permission: 'manual',
          planMode: false,
          towerMode: false,
          contextTokens: 0,
          maxContextTokens: 0,
          contextUsage: 0,
        },
      }),
    );
    const row = lines.find((line) => line.includes('Tower mode'));
    expect(row?.trimEnd().endsWith('off')).toBe(true);
  });
});

describe('status report packaged engine row', () => {
  it('renders a Runtime row when running as a packaged binary', () => {
    const lines = buildStatusReportLines(baseOptions({ packagedEngine: 'bun', nativeTools: 'rust' }));
    expect(lines.some((line) => line.includes('Runtime') && line.includes('bun'))).toBe(true);
  });

  it('omits the Runtime row when running from source', () => {
    const lines = buildStatusReportLines(baseOptions({ nativeTools: 'js' }));
    expect(lines.some((line) => line.includes('Runtime'))).toBe(false);
  });
});
