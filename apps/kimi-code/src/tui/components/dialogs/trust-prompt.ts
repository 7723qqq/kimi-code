import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import type { WorkspaceTrustInfo } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme, type ColorToken } from '#/tui/theme';
import { pageView } from '#/tui/utils/paging';

export type TrustPromptChoice = 'trust' | 'distrust';

export interface TrustPromptOptions {
  readonly workDir: string;
  readonly info: WorkspaceTrustInfo;
  readonly getAvailableRows?: () => number;
  readonly onSelect: (choice: TrustPromptChoice) => void;
}

function getOptions(): readonly { value: TrustPromptChoice; label: string }[] {
  return [
    { value: 'trust', label: t('tui.dialogs.trustPrompt.trustLabel') },
    { value: 'distrust', label: t('tui.dialogs.trustPrompt.distrustLabel') },
  ];
}

export class TrustPromptComponent implements Component, Focusable {
  focused = false;
  private selectedIndex = 0;
  private disclosureIndex = 0;
  private disclosurePageSize = 1;
  private canConfirm = true;

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
    const previousPage = matchesKey(data, Key.left) || matchesKey(data, Key.pageUp);
    const nextPage = matchesKey(data, Key.right) || matchesKey(data, Key.pageDown);
    if (previousPage || nextPage) {
      this.disclosureIndex = Math.max(
        0,
        this.disclosureIndex + (previousPage ? -1 : 1) * this.disclosurePageSize,
      );
      return;
    }
    if (this.canConfirm && (matchesKey(data, Key.enter) || matchesKey(data, Key.space))) {
      this.opts.onSelect(getOptions()[this.selectedIndex]!.value);
    }
  }

  render(width: number): string[] {
    const rule = currentTheme.fg('primary', '─'.repeat(width));
    const availableRows = Math.max(0, Math.floor(this.opts.getAvailableRows?.() ?? Infinity));
    const header = [
      rule,
      currentTheme.boldFg('primary', t('tui.dialogs.trustPrompt.title')),
      currentTheme.fg('textMuted', t('tui.dialogs.trustPrompt.navHint')),
      '',
    ];
    const body = [
      ...wrap(this.opts.workDir, 1, width, 'textStrong'),
      '',
      ...this.renderDisclosure(width),
    ];
    const footer = [
      ...wrap(t('tui.dialogs.trustPrompt.remembered'), 1, width, 'textMuted'),
      ...wrap(t('tui.dialogs.trustPrompt.approvals'), 1, width, 'textMuted'),
      '',
      ...getOptions().map((option, i) => {
        const selected = i === this.selectedIndex;
        const pointer = selected ? SELECT_POINTER : ' ';
        const label = selected
          ? currentTheme.boldFg('primary', option.label)
          : currentTheme.fg('text', option.label);
        return currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `) + label;
      }),
      rule,
    ];
    this.canConfirm = header.length + footer.length + 2 <= availableRows;
    if (!this.canConfirm) {
      return [header[1]!, ` ${t('tui.dialogs.trustPrompt.enlargeTerminal')}`]
        .slice(0, availableRows)
        .map((line) => truncateToWidth(line, width));
    }
    const needsPaging = header.length + body.length + footer.length > availableRows;
    this.disclosurePageSize = needsPaging
      ? availableRows - header.length - footer.length - 1
      : body.length;
    const page = pageView(body.length, this.disclosureIndex, this.disclosurePageSize);
    this.disclosureIndex = page.start;
    const lines = [...header, ...body.slice(page.start, page.end)];
    while (lines.length < header.length + this.disclosurePageSize) lines.push('');
    if (page.pageCount > 1)
      lines.push(
        currentTheme.fg(
          'textMuted',
          t('tui.dialogs.trustPrompt.pageIndicator', {
            page: page.page + 1,
            total: page.pageCount,
          }),
        ),
      );
    lines.push(...footer);
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderDisclosure(width: number): string[] {
    const {
      gatedMcpServers,
      gatedAdditionalDirs,
      additionalDirSources,
      instructionSources,
      warnings,
    } = this.opts.info;
    const lines: string[] = [];
    if (gatedMcpServers.length > 0) {
      lines.push(
        ...wrap(
          t(
            gatedMcpServers.length === 1
              ? 'tui.dialogs.trustPrompt.startMcpServers_one'
              : 'tui.dialogs.trustPrompt.startMcpServers_other',
            { count: gatedMcpServers.length },
          ),
          1,
          width,
          'warning',
        ),
      );
      const origins = [...new Set(gatedMcpServers.map((server) => server.origin))];
      lines.push(
        ...wrap(
          t('tui.dialogs.trustPrompt.configSources', {
            paths: origins.map((path) => relativize(this.opts.workDir, path)).join(', '),
          }),
          3,
          width,
          'textMuted',
        ),
        '',
      );
    }
    if (gatedAdditionalDirs.length > 0) {
      lines.push(
        ...wrap(
          t(
            gatedAdditionalDirs.length === 1
              ? 'tui.dialogs.trustPrompt.accessFolders_one'
              : 'tui.dialogs.trustPrompt.accessFolders_other',
            { count: gatedAdditionalDirs.length },
          ),
          1,
          width,
          'warning',
        ),
      );
      if (additionalDirSources.length > 0) {
        lines.push(
          ...wrap(
            t('tui.dialogs.trustPrompt.configSources', {
              paths: additionalDirSources
                .map((path) => relativize(this.opts.workDir, path))
                .join(', '),
            }),
            3,
            width,
            'textMuted',
          ),
        );
      }
      lines.push('');
    }
    if (instructionSources.paths.length > 0) {
      const hasInstructions =
        instructionSources.agentsMdPaths.length > 0 || instructionSources.skills.length > 0;
      const subject = hasInstructions
        ? instructionSources.agentProfiles.length > 0
          ? t('tui.dialogs.trustPrompt.subjectInstructionsAndProfiles')
          : t('tui.dialogs.trustPrompt.subjectInstructions')
        : t('tui.dialogs.trustPrompt.subjectAgentProfiles');
      lines.push(
        ...wrap(t('tui.dialogs.trustPrompt.loadProjectSources', { subject }), 1, width, 'text'),
      );
      lines.push(
        ...wrap(
          t('tui.dialogs.trustPrompt.checkSources', {
            paths: instructionSources.paths
              .map((path) => relativize(this.opts.workDir, path))
              .join(' · '),
          }),
          3,
          width,
          'textMuted',
        ),
        '',
      );
    }
    for (const warning of warnings) lines.push(...wrap(warning, 1, width, 'warning'));
    if (lines.length === 0)
      lines.push(...wrap(t('tui.dialogs.trustPrompt.noProjectSources'), 1, width, 'textMuted'), '');
    return lines;
  }
}

function wrap(text: string, indent: number, width: number, color: ColorToken): string[] {
  return wrapTextWithAnsi(sanitizeForDisplay(text), Math.max(1, width - indent)).map(
    (line) => `${' '.repeat(indent)}${currentTheme.fg(color, line)}`,
  );
}

function relativize(workDir: string, path: string): string {
  const normalizedDir = workDir.replaceAll('\\', '/');
  const normalizedPath = path.replaceAll('\\', '/');
  const prefix = normalizedDir.endsWith('/') ? normalizedDir : `${normalizedDir}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath;
}

function sanitizeForDisplay(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    result += char;
  }
  return result;
}
