/**
 * ImportSessionsScreenComponent — the page behind `/import-sessions` and
 * `kimi import-sessions`: scan → choose a window → import with progress →
 * summary. Rendering follows the migration screen conventions.
 */
import { basename } from 'node:path';

import { Container, matchesKey, Key, truncateToWidth, type Focusable } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { t } from '#/i18n';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';

import {
  candidatesWithin,
  IMPORT_BATCH_LIMIT,
  IMPORT_WINDOW_DAYS,
  type ImportCandidate,
  type ImportProgress,
  type ImportReport,
  type ImportScan,
} from './run-import';

type Phase = 'scanning' | 'choose' | 'importing' | 'done' | 'failed';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const SPINNER_INTERVAL_MS = 80;
const SOURCE_LABEL_KEYS = {
  'claude-code': 'tui.messages.importSessions.sourceClaudeCode',
  codex: 'tui.messages.importSessions.sourceCodex',
} as const;
const MAX_LISTED_FAILURES = 3;
const LONGEST_WINDOW_DAYS = Math.max(...IMPORT_WINDOW_DAYS);

export interface ImportSessionsScreenOptions {
  readonly now: number;
  readonly scan: () => Promise<ImportScan>;
  readonly run: (
    candidates: readonly ImportCandidate[],
    hooks: { readonly onProgress: (progress: ImportProgress) => void; readonly shouldStop: () => boolean },
  ) => Promise<ImportReport>;
  /** Called once when the page closes; `report` is absent when nothing was imported. */
  readonly onClose: (report: ImportReport | undefined) => void;
  readonly requestRender?: () => void;
  readonly colors?: ColorPalette;
}

interface Choice {
  readonly label: string;
  readonly days?: number;
}

function sessions(count: number): string {
  return count === 1
    ? t('tui.messages.importSessions.sessionCount_one', { count })
    : t('tui.messages.importSessions.sessionCount_other', { count });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ImportSessionsScreenComponent extends Container implements Focusable {
  focused = false;
  private readonly options: ImportSessionsScreenOptions;
  private phase: Phase = 'scanning';
  private scan: ImportScan | undefined;
  private selectedIndex = 0;
  private progress: ImportProgress | undefined;
  private stopRequested = false;
  private report: ImportReport | undefined;
  private failure: string | undefined;
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(options: ImportSessionsScreenOptions) {
    super();
    this.options = options;
    this.startSpinner();
    void options.scan().then(
      (scan) => {
        this.scan = scan;
        this.phase = 'choose';
        this.selectedIndex = this.count(IMPORT_WINDOW_DAYS[0]) === 0 && this.count(IMPORT_WINDOW_DAYS[1]) > 0 ? 1 : 0;
        this.settle();
      },
      (error: unknown) => {
        this.failure = errorMessage(error);
        this.phase = 'failed';
        this.settle();
      },
    );
  }

  handleInput(data: string): void {
    const cancel = matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'));
    if (this.phase === 'scanning') {
      if (cancel) this.close();
      return;
    }
    if (this.phase === 'importing') {
      if (cancel && !this.stopRequested) {
        this.stopRequested = true;
        this.requestRender();
      }
      return;
    }
    if (this.phase === 'done' || this.phase === 'failed') {
      if (cancel || matchesKey(data, Key.enter)) this.close();
      return;
    }
    const choices = this.choices();
    if (cancel) {
      this.close();
    } else if (matchesKey(data, Key.up)) {
      this.selectedIndex = (this.selectedIndex - 1 + choices.length) % choices.length;
      this.requestRender();
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = (this.selectedIndex + 1) % choices.length;
      this.requestRender();
    } else if (matchesKey(data, Key.enter)) {
      const days = choices[this.selectedIndex]?.days;
      if (days === undefined) this.close();
      else this.start(days);
    }
  }

  override render(width: number): string[] {
    const colors = this.options.colors ?? currentTheme.palette;
    const title =
      this.phase === 'importing'
        ? t('tui.messages.importSessions.importing')
        : this.phase === 'done' || this.phase === 'failed'
          ? t('tui.messages.importSessions.summary')
          : t('tui.messages.importSessions.title');
    const lines = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(` ${title}`),
      '',
      ...this.body(colors),
      chalk.hex(colors.primary)('─'.repeat(width)),
    ];
    return lines.map((line) => truncateToWidth(line, width));
  }

  private body(colors: ColorPalette): string[] {
    const text = chalk.hex(colors.text);
    const muted = chalk.hex(colors.textMuted);
    const spinner = chalk.hex(colors.accent)(SPINNER_FRAMES[this.spinnerFrame] ?? SPINNER_FRAMES[0]);
    switch (this.phase) {
      case 'scanning':
        return [
          `  ${spinner}  ${text(t('tui.messages.importSessions.scanning'))}`,
          '',
          muted(` ${t('tui.messages.importSessions.escCancel')}`),
        ];
      case 'choose':
        return this.chooseBody(colors);
      case 'importing': {
        const progress = this.progress;
        const current =
          progress === undefined
            ? t('tui.messages.importSessions.preparing')
            : `${String(progress.index + 1)}/${String(progress.total)} · ${basename(progress.candidate.cwd)} (${t(SOURCE_LABEL_KEYS[progress.candidate.source])})`;
        return [
          `  ${spinner}  ${text(current)}`,
          '',
          muted(
            this.stopRequested
              ? ` ${t('tui.messages.importSessions.stopping')}`
              : ` ${t('tui.messages.importSessions.stopHint')}`,
          ),
        ];
      }
      case 'done':
        return this.reportBody(colors);
      case 'failed':
        return [
          chalk.hex(colors.error)(
            ` ${t('tui.messages.importSessions.importFailed', {
              reason: this.failure ?? t('tui.messages.importSessions.unknownError'),
            })}`,
          ),
          '',
          muted(` ${t('tui.messages.importSessions.enterClose')}`),
        ];
    }
  }

  private chooseBody(colors: ColorPalette): string[] {
    const text = chalk.hex(colors.text);
    const muted = chalk.hex(colors.textMuted);
    const choices = this.choices();
    const alreadyImported = this.scan?.alreadyImported ?? 0;
    const missingFolder = this.scan?.missingFolder ?? 0;
    const notCounted = [
      ...(alreadyImported > 0
        ? [t('tui.messages.importSessions.alreadyImportedCount', { count: alreadyImported })]
        : []),
      ...(missingFolder > 0
        ? [t('tui.messages.importSessions.missingFolderCount', { count: missingFolder })]
        : []),
    ];
    const lines = choices.map((choice, index) => {
      const selected = index === this.selectedIndex;
      const pointer = chalk.hex(selected ? colors.primary : colors.textDim)(`  ${selected ? '❯' : ' '} `);
      const label = (selected ? chalk.hex(colors.primary).bold : text)(choice.label.padEnd(14));
      if (choice.days === undefined) return pointer + label;
      const count = this.count(choice.days);
      const limit =
        count > IMPORT_BATCH_LIMIT
          ? t('tui.messages.importSessions.newestThisRun', { count: IMPORT_BATCH_LIMIT })
          : '';
      return pointer + label + muted(`${sessions(count)}${limit}`);
    });
    if (this.count(LONGEST_WINDOW_DAYS) === 0) {
      const reasons = notCounted.length > 0 ? ` ${notCounted.join(', ')}.` : '';
      return [
        text(
          ` ${t('tui.messages.importSessions.noSessions', { days: LONGEST_WINDOW_DAYS })}${reasons}`,
        ),
        '',
        ...lines,
        '',
        muted(` ${t('tui.messages.importSessions.enterClose')}`),
      ];
    }
    const recent = candidatesWithin(this.scan!, LONGEST_WINDOW_DAYS, this.options.now);
    const bySource = (['claude-code', 'codex'] as const)
      .map(
        (source) =>
          [t(SOURCE_LABEL_KEYS[source]), recent.filter((candidate) => candidate.source === source).length] as const,
      )
      .filter(([, count]) => count > 0)
      .map(([label, count]) => `${label} ${String(count)}`);
    const summary = [
      ...bySource,
      ...(notCounted.length > 0
        ? [t('tui.messages.importSessions.notCounted', { count: notCounted.join(', ') })]
        : []),
    ];
    return [
      text(` ${t('tui.messages.importSessions.localNote')}`),
      '',
      ...lines,
      '',
      muted(` ${summary.join(' · ')}`),
      muted(` ${t('tui.messages.importSessions.moveHint')}`),
    ];
  }

  private reportBody(colors: ColorPalette): string[] {
    const report = this.report!;
    const text = chalk.hex(colors.text);
    const muted = chalk.hex(colors.textMuted);
    const importedCount = report.imported.length;
    const headline = report.stopped
      ? importedCount === 1
        ? t('tui.messages.importSessions.stopped_one', { count: importedCount })
        : t('tui.messages.importSessions.stopped_other', { count: importedCount })
      : importedCount > 0
        ? importedCount === 1
          ? t('tui.messages.importSessions.imported_one', { count: importedCount })
          : t('tui.messages.importSessions.imported_other', { count: importedCount })
        : t('tui.messages.importSessions.noneImported');
    const skipped = [
      [report.missingFolder, t('tui.messages.importSessions.missingFolder')],
      [report.inUse, t('tui.messages.importSessions.inUse')],
      [report.unsupported, t('tui.messages.importSessions.unsupported')],
      [report.empty, t('tui.messages.importSessions.empty')],
      [report.alreadyImported, t('tui.messages.importSessions.alreadyImported')],
    ] as const;
    const skippedTotal = skipped.reduce((total, [count]) => total + count, 0);
    const lines = [chalk.hex(report.imported.length > 0 ? colors.success : colors.text)(` ${headline}`)];
    if (skippedTotal > 0) {
      lines.push(text(` ${t('tui.messages.importSessions.skipped', { count: skippedTotal })}`));
      for (const [count, reason] of skipped) {
        if (count > 0) lines.push(muted(`   ${String(count)} ${reason}`));
      }
    }
    if (report.failed.length > 0) {
      lines.push(
        chalk.hex(colors.warning)(
          ` ${t('tui.messages.importSessions.failed', { count: report.failed.length })}`,
        ),
      );
      for (const failure of report.failed.slice(0, MAX_LISTED_FAILURES)) {
        lines.push(muted(`   ${basename(failure.path)}: ${failure.message}`));
      }
      if (report.failed.length > MAX_LISTED_FAILURES) {
        lines.push(
          muted(
            `   ${t('tui.messages.importSessions.more', {
              count: report.failed.length - MAX_LISTED_FAILURES,
            })}`,
          ),
        );
      }
    }
    if (report.imported.length > 0) {
      lines.push('', muted(` ${t('tui.messages.importSessions.findThem')}`));
    }
    return [...lines, '', muted(` ${t('tui.messages.importSessions.enterClose')}`)];
  }

  private choices(): Choice[] {
    if (this.count(LONGEST_WINDOW_DAYS) === 0) {
      return [{ label: t('tui.messages.importSessions.close') }];
    }
    return [
      ...IMPORT_WINDOW_DAYS.map((days) => ({
        label: t('tui.messages.importSessions.lastDays', { days }),
        days,
      })),
      { label: t('tui.messages.importSessions.cancel') },
    ];
  }

  private count(days: number): number {
    return this.scan === undefined ? 0 : candidatesWithin(this.scan, days, this.options.now).length;
  }

  private start(days: number): void {
    const candidates = candidatesWithin(this.scan!, days, this.options.now);
    this.phase = 'importing';
    this.startSpinner();
    this.requestRender();
    void this.options
      .run(candidates, {
        onProgress: (progress) => {
          this.progress = progress;
          this.requestRender();
        },
        shouldStop: () => this.stopRequested,
      })
      .then(
        (report) => {
          this.report = report;
          this.phase = 'done';
        },
        (error: unknown) => {
          this.failure = errorMessage(error);
          this.phase = 'failed';
        },
      )
      .finally(() => {
        this.settle();
      });
  }

  private settle(): void {
    this.stopSpinner();
    this.requestRender();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopSpinner();
    this.options.onClose(this.report);
  }

  private startSpinner(): void {
    if (this.spinnerTimer !== undefined) return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.requestRender();
    }, SPINNER_INTERVAL_MS);
    this.spinnerTimer.unref();
  }

  private stopSpinner(): void {
    if (this.spinnerTimer === undefined) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  private requestRender(): void {
    this.options.requestRender?.();
  }
}
