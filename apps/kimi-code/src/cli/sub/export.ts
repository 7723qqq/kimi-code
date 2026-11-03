/**
 * `kimi export` sub-command.
 *
 * CLI glue only: session lookup, previous-session confirmation, and output.
 * The actual ZIP/manifest export is owned by the SDK.
 */

import type {
  ExportSessionInput,
  ExportSessionResult,
  SessionSummary,
  ShellEnvironment,
} from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';

import { detectInstallSource } from '#/cli/update/source';
import { t } from '#/i18n';
import { detectShellEnvironment } from '#/utils/process/shell-env';

import { promptYesNo, type ConfirmPromptAnswer } from './confirm';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface PreviousSessionSummary {
  readonly workDir: string;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly title?: string | undefined;
}

export interface ExportDeps {
  readonly listSessions: (workDir: string) => Promise<readonly SessionSummary[]>;
  readonly exportSession: (input: ExportSessionInput) => Promise<ExportSessionResult>;
  readonly confirmPreviousSession: (
    summary: PreviousSessionSummary,
  ) => Promise<ConfirmPromptAnswer>;
  readonly getInstallSource: () => Promise<string>;
  readonly getShellEnv: () => ShellEnvironment;
  readonly version: string;
  readonly cwd: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
}

export interface ExportOptions {
  readonly yes: boolean;
  readonly includeGlobalLog: boolean;
}

export async function handleExport(
  deps: ExportDeps,
  sessionId: string | undefined,
  output: string | undefined,
  opts: ExportOptions,
): Promise<void> {
  const requestedId = normalizeOptionalSessionId(sessionId);
  const previousSummary = requestedId === undefined ? await findPreviousSession(deps) : undefined;

  let resolvedId: string;
  if (requestedId !== undefined) {
    resolvedId = requestedId;
  } else {
    if (previousSummary === undefined) {
      deps.stderr.write(t('tui.statusMessages.exportNoSession') + '\n');
      deps.exit(1);
    }
    resolvedId = previousSummary.id;
    if (!opts.yes) {
      const answer = await deps.confirmPreviousSession(toPreviousSessionSummary(previousSummary));
      if (answer === 'eof') {
        deps.stderr.write(t('tui.statusMessages.confirmPromptEof') + '\n');
        deps.exit(1);
      }
      if (answer === 'no') {
        deps.stdout.write(t('tui.statusMessages.exportCancelled') + '\n');
        return;
      }
    }
  }

  try {
    const installSource = await deps.getInstallSource();
    const shellEnv = deps.getShellEnv();
    const result = await deps.exportSession({
      id: resolvedId,
      version: deps.version,
      installSource,
      shellEnv,
      ...(output === undefined ? {} : { outputPath: output }),
      ...(opts.includeGlobalLog ? { includeGlobalLog: true } : {}),
    });
    deps.stdout.write(`${result.zipPath}\n`);
  } catch (error) {
    deps.stderr.write(`${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export function registerExportCommand(parent: Command, deps?: Partial<ExportDeps>): void {
  parent
    .command('export')
    .description(t('cli.commandDescriptions.exportCmd'))
    .option('-o, --output <path>', t('cli.optionDescriptions.exportOutput'))
    .option('-y, --yes', t('cli.optionDescriptions.exportYes'))
    .option('--no-include-global-log', t('cli.optionDescriptions.exportNoIncludeGlobalLog'))
    .argument('[sessionId]', t('cli.optionDescriptions.exportSessionId'))
    .action(
      async (
        sessionId: string | undefined,
        options: { output?: string; yes?: boolean; includeGlobalLog?: boolean },
      ) => {
        const resolved = await createDefaultExportDeps(deps);
        try {
          await handleExport(resolved, sessionId, options.output, {
            yes: options.yes === true,
            includeGlobalLog: options.includeGlobalLog !== false,
          });
        } finally {
          await resolved.close();
        }
      },
    );
}

async function createDefaultExportDeps(overrides: Partial<ExportDeps> = {}): Promise<
  ExportDeps & {
    readonly close: () => Promise<void>;
  }
> {
  // The harness runtime pulls the engine; load it on dispatch so registering
  // the command stays free of it.
  const { CliHarnessRuntime } = await import('#/cli/harness');
  const runtime = new CliHarnessRuntime();
  return {
    listSessions:
      overrides.listSessions ??
      ((workDir: string) =>
        runtime.getHarness().listSessions({
          workDir,
        })),
    exportSession:
      overrides.exportSession ??
      (async (input: ExportSessionInput) => {
        await runtime.initializeTelemetry();
        try {
          return await runtime.getHarness().exportSession(input);
        } finally {
          await runtime.shutdownTelemetry();
        }
      }),
    version: overrides.version ?? runtime.version,
    getInstallSource: overrides.getInstallSource ?? (() => detectInstallSource()),
    getShellEnv: overrides.getShellEnv ?? detectShellEnvironment,
    confirmPreviousSession: overrides.confirmPreviousSession ?? confirmPreviousSession,
    cwd: overrides.cwd ?? (() => process.cwd()),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
    // The v2 harness boots an engine whose watchers hold the event loop open;
    // close it so a one-shot command can exit. No-op when the run never needed
    // the harness.
    close: () => runtime.close(),
  };
}

async function findPreviousSession(
  deps: Pick<ExportDeps, 'cwd' | 'listSessions'>,
): Promise<SessionSummary | undefined> {
  const sessions = await deps.listSessions(deps.cwd());
  return sessions[0];
}

function toPreviousSessionSummary(summary: SessionSummary): PreviousSessionSummary {
  return {
    workDir: summary.workDir,
    sessionId: summary.id,
    sessionDir: summary.sessionDir,
    ...(summary.title === undefined ? {} : { title: summary.title }),
  };
}

function normalizeOptionalSessionId(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

async function confirmPreviousSession(
  summary: PreviousSessionSummary,
): Promise<ConfirmPromptAnswer> {
  const title =
    summary.title === undefined ? summary.sessionId : `${summary.title} (${summary.sessionId})`;
  return promptYesNo(t('tui.statusMessages.exportConfirmPrompt', { title }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
