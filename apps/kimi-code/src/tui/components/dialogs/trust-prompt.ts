import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import type { WorkspaceTrustMcpServerInfo } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

export type TrustPromptChoice = 'trust' | 'distrust';

export interface TrustPromptOptions {
  readonly workDir: string;
  /** Project-level MCP servers that trusting would enable; may be empty. */
  readonly gatedMcpServers: readonly WorkspaceTrustMcpServerInfo[];
  /** Esc resolves to 'distrust' as well. */
  readonly onSelect: (choice: TrustPromptChoice) => void;
}

interface TrustPromptOption {
  readonly value: TrustPromptChoice;
  readonly label: string;
  readonly description: string;
}

function getOptions(): readonly TrustPromptOption[] {
  return [
    {
      value: 'trust',
      label: t('tui.dialogs.trustPrompt.trustLabel'),
      description: t('tui.dialogs.trustPrompt.trustDesc'),
    },
    {
      value: 'distrust',
      label: t('tui.dialogs.trustPrompt.distrustLabel'),
      description: t('tui.dialogs.trustPrompt.distrustDesc'),
    },
  ];
}

export class TrustPromptComponent implements Component, Focusable {
  focused = false;
  private selectedIndex = 1;

  constructor(private readonly opts: TrustPromptOptions) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onSelect('distrust');
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(getOptions().length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      this.opts.onSelect(getOptions()[this.selectedIndex]!.value);
    }
  }

  render(width: number): string[] {
    const rule = currentTheme.fg('primary', '─'.repeat(width));
    const lines = [
      rule,
      currentTheme.boldFg('primary', t('tui.dialogs.trustPrompt.title')),
      currentTheme.fg('textMuted', t('tui.dialogs.trustPrompt.navHint')),
      '',
      ...wrapTextWithAnsi(this.opts.workDir, Math.max(20, width - 2)).map(
        (line) => ` ${currentTheme.fg('textStrong', line)}`,
      ),
      '',
    ];

    const notice = t('tui.dialogs.trustPrompt.notice');
    for (const line of wrapTextWithAnsi(notice, Math.max(20, width - 2))) {
      lines.push(` ${currentTheme.fg('textMuted', line)}`);
    }
    if (this.opts.gatedMcpServers.length > 0) {
      lines.push(` ${currentTheme.fg('warning', t('tui.dialogs.trustPrompt.projectMcpTargets'))}`);
      for (const server of this.opts.gatedMcpServers) {
        const details = formatMcpTarget(server);
        for (const line of wrapTextWithAnsi(details, Math.max(20, width - 4))) {
          lines.push(`   ${currentTheme.fg('warning', line)}`);
        }
      }
    }
    lines.push('');

    const options = getOptions();
    for (let i = 0; i < options.length; i += 1) {
      const option = options[i]!;
      const selected = i === this.selectedIndex;
      const pointer = selected ? SELECT_POINTER : ' ';
      const label = selected
        ? currentTheme.boldFg('primary', option.label)
        : currentTheme.fg('text', option.label);
      lines.push(currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `) + label);
      for (const line of wrapTextWithAnsi(option.description, Math.max(20, width - 4))) {
        lines.push(`    ${currentTheme.fg('textMuted', line)}`);
      }
      lines.push('');
    }

    lines.push(rule);
    return lines.map((line) => truncateToWidth(line, width));
  }
}

function formatMcpTarget(server: WorkspaceTrustMcpServerInfo): string {
  if (server.transport === 'stdio') {
    const args = server.args === undefined ? '' : ` args=${JSON.stringify(server.args)}`;
    const cwd = server.cwd === undefined ? '' : ` cwd=${server.cwd}`;
    return sanitizeForDisplay(`${server.name} (stdio): command=${server.command ?? ''}${args}${cwd}`);
  }
  return sanitizeForDisplay(`${server.name} (${server.transport}): url=${server.url ?? ''}`);
}

/**
 * Drops C0/C1 control characters (including ESC) from workspace-supplied text:
 * the trust prompt renders before the workspace is trusted, so a planted
 * `.mcp.json` must not inject terminal control sequences into it.
 */
function sanitizeForDisplay(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    result += char;
  }
  return result;
}
