/**
 * AgentPaneComponent — live agent status list.
 *
 * Mirrors the opencode-style agent panel: the main agent plus every running
 * or finished subagent, each with a status icon (spinner / ✓ / ✗) and a
 * one-line activity detail. The host aggregates the items from the transcript
 * (`updateAgentPane`) and pushes them via `setItems`; the pane is purely
 * presentational.
 */

import { Container, truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { currentTheme } from '#/tui/theme';

export type AgentStatus = 'active' | 'waiting' | 'done' | 'error';

export interface AgentPaneItem {
  readonly id: string;
  readonly name: string;
  readonly status: AgentStatus;
  /** One-line activity detail (e.g. the latest tool call). */
  readonly detail: string | undefined;
}

const PANE_TITLE = 'Agents';
const ITEM_INDENT = '  ';
const DETAIL_INDENT = '    ';

export class AgentPaneComponent extends Container {
  private items: AgentPaneItem[] = [];

  setItems(items: AgentPaneItem[]): void {
    this.items = items;
  }

  getItems(): readonly AgentPaneItem[] {
    return this.items;
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const border = currentTheme.fg('border', '─'.repeat(safeWidth));
    const lines: string[] = [
      border,
      currentTheme.boldFg('primary', ` ${PANE_TITLE}`),
      border,
    ];

    if (this.items.length === 0) {
      lines.push(
        currentTheme.fg('textMuted', `  ${t('tui.panes.agentPane.empty')}`),
        border,
      );
      return lines;
    }

    for (const item of this.items) {
      lines.push(this.renderItem(item, safeWidth));
      if (item.detail !== undefined && item.detail.length > 0) {
        const detailWidth = Math.max(1, safeWidth - visibleWidth(DETAIL_INDENT));
        lines.push(
          DETAIL_INDENT +
            currentTheme.fg('textDim', truncateToWidth(item.detail, detailWidth, '…')),
        );
      }
    }
    lines.push(border);
    return lines;
  }

  private renderItem(item: AgentPaneItem, width: number): string {
    const icon = statusIcon(item.status);
    const nameWidth = Math.max(1, width - visibleWidth(ITEM_INDENT) - visibleWidth(icon) - 1);
    const name = truncateToWidth(item.name, nameWidth, '…');
    return `${ITEM_INDENT}${icon} ${currentTheme.fg('text', name)}`;
  }
}

function statusIcon(status: AgentStatus): string {
  switch (status) {
    case 'active':
      return currentTheme.fg('accent', '●');
    case 'waiting':
      return currentTheme.fg('textDim', '○');
    case 'done':
      return currentTheme.fg('success', '✓');
    case 'error':
      return currentTheme.fg('error', '✗');
  }
}
