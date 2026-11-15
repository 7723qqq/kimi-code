import { clearLine, cursorTo, emitKeypressEvents, moveCursor } from 'node:readline';

import chalk from 'chalk';

import { PRODUCT_NAME } from '#/constant/app';
import { HIDE_CURSOR, SHOW_CURSOR } from '#/constant/terminal';
import {
  UPDATE_PROMPT_MUTED,
  UPDATE_PROMPT_PRIMARY,
  UPDATE_PROMPT_SUCCESS,
  UPDATE_PROMPT_TEXT_DIM,
  UPDATE_PROMPT_WARNING,
} from '#/constant/update';
import { t } from '#/i18n';

export type ForcedUpgradePromptAction = 'install' | 'retry' | 'skip' | 'exit';

export interface ForcedUpgradePromptOptions {
  readonly currentVersion: string;
  readonly minimumVersion: string;
  readonly targetVersion?: string;
  readonly error?: string;
  readonly canInstall: boolean;
  readonly skipAvailableAt: number;
  readonly input?: NodeJS.ReadStream;
  readonly output?: NodeJS.WriteStream;
  readonly now?: () => number;
}

export function remainingSkipSeconds(now: number, skipAvailableAt: number): number {
  return Math.max(0, Math.ceil((skipAvailableAt - now) / 1000));
}

function createForcedUpgradeChoices(
  options: ForcedUpgradePromptOptions,
  remainingSeconds: number,
): readonly string[] {
  const choices: string[] = [];
  if (options.canInstall) {
    choices.push(
      options.error === undefined
        ? `${t('tui.statusMessages.updatePromptInstallNow')} (${options.targetVersion})`
        : t('tui.statusMessages.updateForcedRetry'),
    );
  }
  choices.push(
    remainingSeconds === 0
      ? t('tui.statusMessages.updateForcedSkip')
      : t('tui.statusMessages.updateForcedSkipCountdown', { seconds: remainingSeconds }),
  );
  return choices;
}

function renderLines(options: ForcedUpgradePromptOptions, selectedIndex: number): string[] {
  const now = options.now?.() ?? Date.now();
  const remaining = remainingSkipSeconds(now, options.skipAvailableAt);
  const label = chalk.hex(UPDATE_PROMPT_TEXT_DIM).bold;
  const lines = [
    chalk
      .hex(UPDATE_PROMPT_PRIMARY)
      .bold(t('tui.statusMessages.updateForcedTitle', { name: PRODUCT_NAME })),
    chalk.hex(UPDATE_PROMPT_MUTED)(t('tui.statusMessages.updateForcedSubtitle')),
    `${label(t('tui.statusMessages.updatePromptCurrent'))}  ${chalk.hex(UPDATE_PROMPT_WARNING).bold(options.currentVersion)}`,
    `${label(t('tui.statusMessages.updateForcedMinimum'))}  ${chalk.hex(UPDATE_PROMPT_SUCCESS).bold(options.minimumVersion)}`,
    ...(options.targetVersion === undefined
      ? []
      : [`${label(t('tui.statusMessages.updatePromptTarget'))}  ${options.targetVersion}`]),
    ...(options.error === undefined ? [] : ['', chalk.hex(UPDATE_PROMPT_WARNING)(options.error)]),
    '',
    chalk.hex(UPDATE_PROMPT_MUTED)(t('tui.statusMessages.updateForcedNavHint')),
    '',
  ];
  const choices = createForcedUpgradeChoices(options, remaining);
  const normalizedSelected = Math.min(selectedIndex, choices.length - 1);
  for (let index = 0; index < choices.length; index++) {
    const selected = index === normalizedSelected;
    const disabled = index === choices.length - 1 && remaining > 0;
    const content = `${selected ? '❯' : ' '} ${choices[index] ?? ''}`;
    if (disabled) {
      lines.push(chalk.hex(UPDATE_PROMPT_MUTED)(content));
    } else if (selected) {
      lines.push(chalk.hex(UPDATE_PROMPT_PRIMARY).bold(content));
    } else {
      lines.push(chalk.hex(UPDATE_PROMPT_TEXT_DIM)(content));
    }
  }
  return lines;
}

function writeFrame(
  output: NodeJS.WriteStream,
  lines: readonly string[],
  previousLineCount: number,
): number {
  if (previousLineCount > 0) {
    moveCursor(output, 0, -(previousLineCount - 1));
  }

  for (let index = 0; index < lines.length; index++) {
    clearLine(output, 0);
    cursorTo(output, 0);
    output.write(lines[index] ?? '');
    if (index < lines.length - 1) {
      output.write('\n');
    }
  }

  return lines.length;
}

export async function promptForForcedUpgradeChoice(
  options: ForcedUpgradePromptOptions,
): Promise<ForcedUpgradePromptAction> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const choiceCount = options.canInstall ? 2 : 1;
  let selectedIndex = 0;

  return new Promise<ForcedUpgradePromptAction>((resolve) => {
    let lineCount = 0;
    let settled = false;
    const hadRawMode = 'isRaw' in input ? input.isRaw : false;
    const canSetRawMode = typeof input.setRawMode === 'function';

    const render = (): void => {
      lineCount = writeFrame(output, renderLines(options, selectedIndex), lineCount);
    };

    const timer = setInterval(render, 250);

    const cleanup = (): void => {
      clearInterval(timer);
      input.off('keypress', onKeypress);
      if (canSetRawMode) {
        input.setRawMode(hadRawMode);
      }
      output.write(SHOW_CURSOR);
    };

    const finish = (action: ForcedUpgradePromptAction): void => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      resolve(action);
    };

    const onKeypress = (_input: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl === true && key.name === 'c') {
        finish('exit');
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        selectedIndex = (selectedIndex + (key.name === 'up' ? choiceCount - 1 : 1)) % choiceCount;
        render();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const now = options.now?.() ?? Date.now();
        if (
          selectedIndex === choiceCount - 1 &&
          remainingSkipSeconds(now, options.skipAvailableAt) > 0
        ) {
          return;
        }
        if (selectedIndex === choiceCount - 1) {
          finish('skip');
          return;
        }
        finish(options.error === undefined ? 'install' : 'retry');
      }
    };

    emitKeypressEvents(input);
    if (canSetRawMode) {
      input.setRawMode(true);
    }
    input.resume();
    input.on('keypress', onKeypress);
    output.write(HIDE_CURSOR);
    render();
  });
}
