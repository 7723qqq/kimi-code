import type { SessionSummary } from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';

import { t } from '#/i18n';

import { promptYesNo, type ConfirmPromptAnswer } from './confirm';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface ForkedSessionResult {
  readonly id: string;
  readonly title?: string | undefined;
}

export interface ForkDeps {
  readonly listSessions: (workDir: string) => Promise<readonly SessionSummary[]>;
  readonly forkSession: (sessionId: string) => Promise<ForkedSessionResult>;
  readonly confirmPreviousSession: (summary: SessionSummary) => Promise<ConfirmPromptAnswer>;
  readonly cwd: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
}

export interface ForkOptions {
  readonly yes: boolean;
  readonly cwd?: string | undefined;
}

export async function handleFork(
  deps: ForkDeps,
  sessionId: string | undefined,
  opts: ForkOptions,
): Promise<void> {
  let resolvedId = normalizeOptionalSessionId(sessionId);
  if (resolvedId === undefined) {
    const sessions = await deps.listSessions(opts.cwd ?? deps.cwd());
    const latest = sessions[0];
    if (latest === undefined) {
      deps.stderr.write(t('tui.statusMessages.forkNoSession') + '\n');
      deps.exit(1);
    }
    if (!opts.yes) {
      const answer = await deps.confirmPreviousSession(latest);
      if (answer === 'eof') {
        deps.stderr.write(t('tui.statusMessages.confirmPromptEof') + '\n');
        deps.exit(1);
      }
      if (answer === 'no') {
        deps.stdout.write(t('tui.statusMessages.forkCancelled') + '\n');
        return;
      }
    }
    resolvedId = latest.id;
  }

  const startedAt = Date.now();
  try {
    const forked = await deps.forkSession(resolvedId);
    const elapsedMs = Date.now() - startedAt;
    const title = forked.title === undefined ? '' : ` ("${forked.title}")`;
    deps.stdout.write(t('tui.statusMessages.forkedTo', { id: forked.id, title, elapsedMs }) + '\n');
  } catch (error) {
    deps.stderr.write(`${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export function registerForkCommand(parent: Command, deps?: Partial<ForkDeps>): void {
  parent
    .command('fork')
    .description(t('cli.optionDescriptions.forkDescription'))
    .option('--cwd <path>', t('cli.optionDescriptions.forkCwd'))
    .option('-y, --yes', t('cli.optionDescriptions.forkYes'))
    .argument('[sessionId]', t('cli.optionDescriptions.forkSessionId'))
    .action(async (sessionId: string | undefined, options: { cwd?: string; yes?: boolean }) => {
      const resolved = await createDefaultForkDeps(deps);
      try {
        await handleFork(resolved, sessionId, {
          yes: options.yes === true,
          cwd: options.cwd,
        });
      } finally {
        await resolved.close();
      }
    });
}

async function createDefaultForkDeps(overrides: Partial<ForkDeps> = {}): Promise<
  ForkDeps & {
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
    forkSession:
      overrides.forkSession ??
      (async (sessionId: string) => {
        await runtime.initializeTelemetry();
        try {
          const forked = await runtime.getHarness().forkSession({ id: sessionId });
          return { id: forked.id, title: forked.summary?.title };
        } finally {
          await runtime.shutdownTelemetry();
        }
      }),
    confirmPreviousSession: overrides.confirmPreviousSession ?? confirmPreviousSession,
    cwd: overrides.cwd ?? (() => process.cwd()),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
    close: () => runtime.close(),
  };
}

function normalizeOptionalSessionId(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

async function confirmPreviousSession(summary: SessionSummary): Promise<ConfirmPromptAnswer> {
  const title = summary.title === undefined ? summary.id : `${summary.title} (${summary.id})`;
  return promptYesNo(t('tui.statusMessages.forkConfirmPrompt', { title }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
