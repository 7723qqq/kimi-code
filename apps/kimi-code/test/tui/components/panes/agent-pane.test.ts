import chalk from 'chalk';
import { describe, expect, it, vi } from 'vitest';

import { AgentPaneComponent, type AgentPaneItem } from '#/tui/components/panes/agent-pane';

vi.mock('#/i18n', () => ({
  t: (key: string) => key,
  setLocale: vi.fn(),
  getLocale: () => 'en',
}));

function stripAnsi(text: string): string {
  return text.replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

describe('AgentPaneComponent', () => {
  it('renders an empty state when there are no agents', () => {
    const pane = new AgentPaneComponent();
    pane.setItems([]);
    const out = stripAnsi(pane.render(28).join('\n'));
    expect(out).toContain('tui.panes.agentPane.empty');
  });

  it('renders each agent with a status icon and name', () => {
    const previousChalkLevel = chalk.level;
    chalk.level = 3;
    try {
      const pane = new AgentPaneComponent();
      const items: AgentPaneItem[] = [
        { id: 'main', name: 'main', status: 'active', detail: 'thinking' },
        { id: 'a1', name: 'explorer', status: 'done', detail: 'searched 3 files' },
        { id: 'a2', name: 'coder', status: 'error', detail: undefined },
      ];
      pane.setItems(items);
      const out = stripAnsi(pane.render(28).join('\n'));
      expect(out).toContain('main');
      expect(out).toContain('explorer');
      expect(out).toContain('coder');
      expect(out).toContain('thinking');
      expect(out).toContain('searched 3 files');
    } finally {
      chalk.level = previousChalkLevel;
    }
  });

  it('uses distinct icons per status', () => {
    const previousChalkLevel = chalk.level;
    chalk.level = 3;
    try {
      const pane = new AgentPaneComponent();
      pane.setItems([
        { id: 'a', name: 'active', status: 'active', detail: undefined },
        { id: 'w', name: 'waiting', status: 'waiting', detail: undefined },
        { id: 'd', name: 'done', status: 'done', detail: undefined },
        { id: 'e', name: 'error', status: 'error', detail: undefined },
      ]);
      const out = pane.render(28).join('\n');
      // active: accent ●, waiting: dim ○, done: success ✓, error: error ✗
      expect(out).toContain('\u001B[38;2;91;192;190m●'); // accent
      expect(out).toContain('○');
      expect(out).toContain('✓');
      expect(out).toContain('✗');
    } finally {
      chalk.level = previousChalkLevel;
    }
  });
});
