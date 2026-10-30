import { getShellPathBridge } from '#/_base/execEnv/shellPathBridge';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { IAgentRuntimeService, inspectAgentRuntime } from '#/agent/runtimeBinding/agentRuntime';
import { resolveAgentTaskConfig } from '#/agent/task/configSection';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IConfigService } from '#/app/config/config';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolOutputAccumulator } from '#/tool/output-accumulator';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  type ExecutableToolResult,
  type ToolExecution,
  type ToolUpdate,
} from '#/tool/toolContract';

import {
  MS_PER_SECOND,
  ShellToolResults,
  foregroundDescription,
  killSpawnedProcess,
  normalizeTimeoutMs,
} from '../shell/shellToolResults';
import {
  type BashInput,
  BashInputSchema,
  DEFAULT_BACKGROUND_TIMEOUT_S,
  DEFAULT_TIMEOUT_S,
  IBashTool,
  MAX_BACKGROUND_TIMEOUT_S,
  MAX_TIMEOUT_S,
} from './bash';
import bashDescriptionTemplate from './bash.md?raw';
import { ProcessTask } from './process-task';

const SHELL_TIMEOUT_VARS = {
  DEFAULT_TIMEOUT_S,
  DEFAULT_BACKGROUND_TIMEOUT_S,
  MAX_TIMEOUT_S,
  MAX_BACKGROUND_TIMEOUT_S,
};

function renderBashDescription(shellName: string): string {
  return renderPrompt(bashDescriptionTemplate, { ...SHELL_TIMEOUT_VARS, SHELL_NAME: shellName });
}

function withoutBackgroundDescription(description: string): string {
  return description
    .replace(
      /\r?\n\r?\nIf `run_in_background=true`,[\s\S]*?point them to the background-task panel\./,
      '\n\nBackground execution is disabled for this agent. Do not set `run_in_background=true`.',
    )
    .replace(
      ` For possibly long-running foreground commands, set the \`timeout\` argument in seconds. Foreground commands default to ${String(DEFAULT_TIMEOUT_S)}s and allow up to ${String(MAX_TIMEOUT_S)}s. When a foreground command hits its timeout it is moved to the background instead of being killed, and you will be automatically notified when it completes.`,
      ` For possibly long-running commands, set the \`timeout\` argument in seconds. The default is ${String(DEFAULT_TIMEOUT_S)}s; foreground commands allow up to ${String(MAX_TIMEOUT_S)}s; a foreground command that hits its timeout is killed.`,
    )
    .replace(
      ' The user can also move a running foreground command to the background at any time.',
      '',
    )
    .replace(
      /\r?\n- Prefer `run_in_background=true`[\s\S]*?conversation to continue before the command finishes\./,
      '\n- Do not set `run_in_background=true`; background task management tools are not available.',
    );
}

function withoutAutoBackgroundOnTimeout(description: string): string {
  return description.replace(
    ' When a foreground command hits its timeout it is moved to the background instead of being killed, and you will be automatically notified when it completes.',
    ' A foreground command that hits its timeout is killed.',
  );
}

export class BashTool implements IBashTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Bash' as const;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(BashInputSchema);

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IConfigService private readonly config: IConfigService,
  ) {
    this.results = new ShellToolResults(this.tasks, () => this.allowBackground());
  }

  private readonly results: ShellToolResults;

  private allowBackground(): boolean {
    return (
      this.toolPolicy.isToolActive('TaskList') &&
      this.toolPolicy.isToolActive('TaskOutput') &&
      this.toolPolicy.isToolActive('TaskStop')
    );
  }

  private autoBackgroundOnTimeout(): boolean {
    return resolveAgentTaskConfig(this.config)?.bashAutoBackgroundOnTimeout ?? true;
  }

  private detachTimeoutMs(): number {
    const configuredS = resolveAgentTaskConfig(this.config)?.bashTaskTimeoutS;
    if (configuredS === undefined) return DEFAULT_BACKGROUND_TIMEOUT_S * MS_PER_SECOND;
    return configuredS * MS_PER_SECOND;
  }

  get description(): string {
    const renderedDescription = renderBashDescription(
      inspectAgentRuntime(this.runtime).environment.shellName,
    );
    if (!this.allowBackground()) return withoutBackgroundDescription(renderedDescription);
    if (!this.autoBackgroundOnTimeout()) {
      return withoutAutoBackgroundOnTimeout(renderedDescription);
    }
    return renderedDescription;
  }

  resolveExecution(args: BashInput): ToolExecution {
    const preview = args.command.length > 50 ? `${args.command.slice(0, 50)}…` : args.command;
    return {
      description: args.run_in_background
        ? `Starting background: ${preview}`
        : `Running: ${preview}`,
      display: {
        kind: 'command',
        command: args.command,
        cwd: args.cwd ?? this.ctx.cwd,
        description: args.description,
        language: 'bash',
      },
      approvalRule: literalRulePattern(this.name, args.command),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.command),
      execute: ({ signal, onUpdate, onForegroundTaskStart, toolCallId }) =>
        this.execution(args, signal, toolCallId, onUpdate, onForegroundTaskStart),
    };
  }

  private spawn(
    processService: IHostProcessService,
    env: HostEnvironmentInfo,
    effectiveCwd: string,
    command: string,
  ): Promise<IHostProcess> {
    const shellCwd = getShellPathBridge(env).toShellPath(effectiveCwd);
    const shellCommand = `cd ${shellQuote(shellCwd)} && ${command}`;
    const noninteractiveEnv: Record<string, string> = {
      NO_COLOR: '1',
      TERM: 'dumb',
      GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] ?? '0',
      SHELL: env.shellPath,
    };

    return processService.spawn(env.shellPath, ['-c', shellCommand], { env: noninteractiveEnv });
  }

  private async execution(
    args: BashInput,
    signal: AbortSignal,
    toolCallId: string,
    onUpdate?: (update: ToolUpdate) => void,
    onForegroundTaskStart?: (taskId: string) => void,
  ): Promise<ExecutableToolResult> {
    const validationError = this.results.validateRunRequest(args, signal);
    if (validationError !== undefined) return validationError;

    const startsInBackground = args.run_in_background === true;
    const foregroundTimeoutMs = normalizeTimeoutMs(args.timeout, false);
    const lease = this.runtime.acquire(['process']);
    const view = new RuntimeWorkspaceView(lease.runtime, this.workspaceCtx);
    const env = lease.runtime.environment;
    const command =
      env.osKind === 'Windows' ? rewriteWindowsNullRedirect(args.command) : args.command;
    const effectiveCwd = view.resolve(args.cwd ?? view.workDir);
    const description = startsInBackground
      ? args.description!.trim()
      : foregroundDescription('Bash', args.command, args.description);
    const timeoutMs = startsInBackground
      ? args.disable_timeout
        ? undefined
        : normalizeTimeoutMs(args.timeout, true)
      : foregroundTimeoutMs;

    const builder = new ToolOutputAccumulator();
    let proc: IHostProcess;
    try {
      proc = lease.track(await this.spawn(lease.runtime.process!, env, effectiveCwd, command));
    } catch (error) {
      lease.dispose();
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
    closeProcessStdin(proc);

    let collectForegroundOutput = !startsInBackground;
    let foregroundOutputPersisted = false;
    let foregroundTaskId: string | undefined;
    const onProcessOutput = startsInBackground
      ? undefined
      : (kind: 'stdout' | 'stderr', text: string): void => {
          if (!collectForegroundOutput) return;
          onUpdate?.({ kind, text });
          builder.write(text);
          if (
            !foregroundOutputPersisted &&
            builder.totalChars > DEFAULT_TOOL_RESULT_MAX_CHARS &&
            foregroundTaskId !== undefined
          ) {
            this.tasks.persistOutput(foregroundTaskId);
            foregroundOutputPersisted = true;
          }
        };

    let taskId: string;
    try {
      taskId = this.tasks.registerTask(
        new ProcessTask(
          proc,
          command,
          description,
          onProcessOutput,
          () => lease.dispose(),
          toolCallId,
        ),
        {
          detached: startsInBackground,
          timeoutMs,
          detachTimeoutMs: this.detachTimeoutMs(),
          autoBackgroundOnTimeout: this.allowBackground() && this.autoBackgroundOnTimeout(),
          signal: startsInBackground ? undefined : signal,
        },
      );
      foregroundTaskId = startsInBackground ? undefined : taskId;
    } catch (error) {
      collectForegroundOutput = false;
      await killSpawnedProcess(proc);
      lease.dispose();
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    if (!startsInBackground) onForegroundTaskStart?.(taskId);

    if (startsInBackground) {
      return this.results.backgroundStartedResult(taskId, proc, description, {
        title: 'Background task started',
        brief: `Started ${taskId}`,
      });
    }

    try {
      const release = await this.tasks.waitForForegroundRelease(taskId);
      if (release === 'detached' || release === 'timeout_detached') {
        collectForegroundOutput = false;
        const labels =
          release === 'timeout_detached'
            ? {
                title: 'Command timed out and moved to background',
                brief: `Backgrounded ${taskId} after timeout`,
              }
            : {
                title: 'Task moved to background by the user',
                brief: `Backgrounded ${taskId} by the user`,
              };
        return this.results.backgroundStartedResult(
          taskId,
          proc,
          description,
          labels,
          builder,
          release === 'timeout_detached' ? 'foreground_detached' : 'foreground_detached_by_user',
        );
      }

      return await this.results.foregroundCompletionResult(
        taskId,
        proc,
        builder,
        foregroundTimeoutMs,
      );
    } finally {
      collectForegroundOutput = false;
    }
  }
}

registerAgentToolService(IBashTool, BashTool, {
  name: 'Bash',
  domain: 'os/backends',
  requiredRuntimeCapabilities: ['process'],
});

function closeProcessStdin(proc: IHostProcess): void {
  try {
    proc.stdin.end();
  } catch {}
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

const NUL_TARGET_BOUNDARY = /[\s|&;)]/;

interface HeredocDelimiter {
  readonly delimiter: string;
  readonly start: number;
}

function isNulRedirectAt(text: string, at: number): boolean {
  if (text.slice(at, at + 3).toLowerCase() !== 'nul') return false;
  return at + 3 >= text.length || NUL_TARGET_BOUNDARY.test(text[at + 3]!);
}

function nulRedirectWordStart(text: string, at: number): number | undefined {
  let cursor = at + 1;
  if (text[cursor] === '>') cursor++;
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor++;
  return isNulRedirectAt(text, cursor) ? cursor : undefined;
}

function readHeredocDelimiter(text: string, at: number): HeredocDelimiter | undefined {
  let cursor = at + 2;
  if (text[cursor] === '-') cursor++;
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor++;
  const quote = text[cursor];
  if (quote === "'" || quote === '"') {
    const close = text.indexOf(quote, cursor + 1);
    if (close === -1) return undefined;
    const delimiter = text.slice(cursor + 1, close);
    if (delimiter.length === 0) return undefined;
    return { delimiter, start: at };
  }
  const wordStart = cursor;
  while (cursor < text.length && !/[\s|&;()<>]/.test(text[cursor]!)) cursor++;
  if (cursor === wordStart) return undefined;
  return { delimiter: text.slice(wordStart, cursor), start: at };
}

function endOfLineIncludingNewline(text: string, at: number): number {
  const newline = text.indexOf('\n', at);
  return newline === -1 ? text.length : newline + 1;
}

function heredocBodyEnd(text: string, at: number, delimiter: string): number {
  let cursor = at;
  while (cursor < text.length) {
    const lineEnd = endOfLineIncludingNewline(text, cursor);
    const line = text.slice(cursor, lineEnd);
    cursor = lineEnd;
    if (line.trim() === delimiter || line.trim() === `${delimiter};`) return cursor;
  }
  return text.length;
}

function readSubstitutionBody(text: string, at: number): { body: string; end: number } {
  let depth = 1;
  let cursor = at;
  while (cursor < text.length) {
    const ch = text[cursor]!;
    if (ch === '\\') {
      cursor += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const close = text.indexOf(ch, cursor + 1);
      cursor = close === -1 ? text.length : close + 1;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth === 0) return { body: text.slice(at, cursor), end: cursor + 1 };
    }
    cursor++;
  }
  return { body: text.slice(at), end: text.length };
}

function readBacktickBody(text: string, at: number): { body: string; end: number } {
  let cursor = at;
  while (cursor < text.length) {
    const ch = text[cursor]!;
    if (ch === '\\') {
      cursor += 2;
      continue;
    }
    if (ch === '`') return { body: text.slice(at, cursor), end: cursor + 1 };
    cursor++;
  }
  return { body: text.slice(at), end: text.length };
}

function rewriteNulRedirects(text: string): string {
  const out: string[] = [];
  let plain = '';
  const flushPlain = (): void => {
    if (plain.length > 0) {
      out.push(plain);
      plain = '';
    }
  };
  const lastPlainChar = (): string => plain.slice(-1);

  let cursor = 0;
  let inSingle = false;
  let inDouble = false;
  while (cursor < text.length) {
    const ch = text[cursor]!;

    if (inSingle) {
      plain += ch;
      if (ch === "'") inSingle = false;
      cursor++;
      continue;
    }

    if (ch === '\\') {
      plain += text.slice(cursor, cursor + 2);
      cursor += 2;
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        plain += ch;
        inDouble = false;
        cursor++;
        continue;
      }
      if (ch === '$' && text[cursor + 1] === '(') {
        const inner = readSubstitutionBody(text, cursor + 2);
        flushPlain();
        out.push('$(', rewriteNulRedirects(inner.body), ')');
        cursor = inner.end;
        continue;
      }
      if (ch === '`') {
        const inner = readBacktickBody(text, cursor + 1);
        flushPlain();
        out.push('`', rewriteNulRedirects(inner.body), '`');
        cursor = inner.end;
        continue;
      }
      plain += ch;
      cursor++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      flushPlain();
      inSingle = ch === "'";
      inDouble = ch === '"';
      out.push(ch);
      cursor++;
      continue;
    }

    if (ch === '`') {
      const inner = readBacktickBody(text, cursor + 1);
      flushPlain();
      out.push('`', rewriteNulRedirects(inner.body), '`');
      cursor = inner.end;
      continue;
    }

    if (ch === '$' && text[cursor + 1] === '(') {
      const inner = readSubstitutionBody(text, cursor + 2);
      flushPlain();
      out.push('$(', rewriteNulRedirects(inner.body), ')');
      cursor = inner.end;
      continue;
    }

    if (ch === '#' && (lastPlainChar() === '' || /[\s;|&(]/.test(lastPlainChar()))) {
      const lineEnd = endOfLineIncludingNewline(text, cursor);
      plain += text.slice(cursor, lineEnd);
      cursor = lineEnd;
      continue;
    }

    if (ch === '<' && text[cursor + 1] === '<' && text[cursor + 2] !== '<') {
      const heredoc = readHeredocDelimiter(text, cursor);
      if (heredoc === undefined) {
        plain += '<<';
        cursor += 2;
        continue;
      }
      const lineEnd = endOfLineIncludingNewline(text, heredoc.start);
      const bodyEnd = heredocBodyEnd(text, lineEnd, heredoc.delimiter);
      plain += text.slice(cursor, lineEnd);
      flushPlain();
      out.push(text.slice(lineEnd, bodyEnd));
      cursor = bodyEnd;
      continue;
    }

    if (ch === '>') {
      const nulStart = nulRedirectWordStart(text, cursor);
      if (nulStart !== undefined) {
        plain += `${text.slice(cursor, nulStart)}/dev/null`;
        cursor = nulStart + 3;
        continue;
      }
    }

    plain += ch;
    cursor++;
  }
  flushPlain();
  return out.join('');
}

function rewriteWindowsNullRedirect(command: string): string {
  return rewriteNulRedirects(command);
}
