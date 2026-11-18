import { formatWithOptions } from 'node:util';

import { log, onDiagnosticLogFailure, redact } from '@moonshot-ai/kimi-code-sdk';
import { ProcessTerminal } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { DIAGNOSTIC_CONSOLE_LEVELS } from '#/tui/constant/terminal';

const diagnosticTerminals: DiagnosticTerminal[] = [];
let restoreOutput: (() => void) | undefined;

export class DiagnosticTerminal extends ProcessTerminal {
  onDiagnostic?: (message: string) => void;
  private restoreDiagnostics?: () => void;
  private reporting = false;
  private noticePending = false;
  private notifying = false;
  private logUnavailable = false;

  override start(onInput: (data: string) => void, onResize: () => void): void {
    if (this.restoreDiagnostics !== undefined) return;
    const restore = this.captureDiagnostics();
    this.restoreDiagnostics = restore;
    try {
      super.start(onInput, onResize);
    } catch (error) {
      try {
        super.stop();
      } catch (cleanupError) {
        this.record('error', [t('tui.statusMessages.terminalCleanupFailed'), cleanupError]);
      } finally {
        restore();
        this.restoreDiagnostics = undefined;
      }
      throw error;
    }
  }

  override stop(): void {
    if (this.restoreDiagnostics === undefined) return;
    try {
      super.stop();
    } finally {
      this.restoreDiagnostics();
      this.restoreDiagnostics = undefined;
    }
  }

  private captureDiagnostics(): () => void {
    diagnosticTerminals.push(this);
    restoreOutput ??= DiagnosticTerminal.captureOutput();
    return () => {
      const index = diagnosticTerminals.indexOf(this);
      if (index >= 0) diagnosticTerminals.splice(index, 1);
      if (diagnosticTerminals.length === 0) {
        restoreOutput?.();
        restoreOutput = undefined;
      }
    };
  }

  private static captureOutput(): () => void {
    const restorers: (() => void)[] = [];
    for (const [method, level] of Object.entries(DIAGNOSTIC_CONSOLE_LEVELS)) {
      const key = method as keyof typeof DIAGNOSTIC_CONSOLE_LEVELS;
      const original = console[key];
      const capture = (...args: unknown[]): void => {
        diagnosticTerminals.at(-1)?.record(level, args);
      };
      console[key] = capture;
      restorers.push(() => {
        if (console[key] === capture) console[key] = original;
      });
    }
    const stderr = process.stderr;
    // oxlint-disable-next-line typescript/unbound-method
    const originalWrite = stderr.write;
    const captureWrite: typeof stderr.write = (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) => {
      diagnosticTerminals
        .at(-1)
        ?.record('warn', [typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')]);
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      if (done !== undefined)
        queueMicrotask(() => {
          done();
        });
      return true;
    };
    stderr.write = captureWrite;
    restorers.push(() => {
      if (stderr.write === captureWrite) stderr.write = originalWrite;
    });
    restorers.push(
      onDiagnosticLogFailure(() => {
        diagnosticTerminals.at(-1)?.notify(true);
      }),
    );
    return () => {
      for (const restore of restorers.reverse()) restore();
    };
  }

  private record(level: 'error' | 'warn' | 'info' | 'debug', args: readonly unknown[]): void {
    if (this.reporting) {
      this.notify(true);
      return;
    }
    this.reporting = true;
    try {
      const error = args.find((value): value is Error => value instanceof Error);
      const context = args.map((value) => {
        if (!(value instanceof Error)) return value;
        return {
          ...Object.fromEntries(Object.entries(value)),
          name: value.name,
          message: value.message,
        };
      });
      const output = formatWithOptions(
        {
          colors: false,
          depth: 4,
          maxArrayLength: 30,
          maxStringLength: 2048,
          getters: false,
          customInspect: false,
        },
        ...redact(context),
      );
      log[level]('diagnostic-output', { output, error });
      if (level === 'error' || level === 'warn') this.notify(false);
    } catch {
      this.notify(true);
    } finally {
      this.reporting = false;
    }
  }

  private notify(unavailable: boolean): void {
    this.logUnavailable ||= unavailable;
    if (this.noticePending || this.notifying) return;
    this.noticePending = true;
    queueMicrotask(() => {
      this.noticePending = false;
      if (this.restoreDiagnostics === undefined) return;
      this.notifying = true;
      try {
        this.onDiagnostic?.(
          t(
            this.logUnavailable
              ? 'tui.statusMessages.diagnosticLogUnavailable'
              : 'tui.statusMessages.diagnosticsCaptured',
          ),
        );
      } catch {
        this.logUnavailable = true;
      } finally {
        this.notifying = false;
      }
    });
  }
}
