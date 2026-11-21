import { access } from 'node:fs/promises';
import { homedir } from 'node:os';

import { renderPrompt } from '#/_base/utils/render-prompt';
import { userCancellationReason } from '#/_base/utils/abort';
import { acquireOrWhenReady, IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { resolveAgentTaskConfig } from '#/agent/task/configSection';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { EnvironmentWorkspaceView } from '#/environment/environmentWorkspaceView';
import { OPERATION_LOG_FLAG_ID } from '#/features/operationLog/flag';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolOutputAccumulator } from '#/tool/output-accumulator';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  ToolSideEffects,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';

import { createProcessExecutor, ProcessExitError } from '../bash/process-task';
import {
  DEFAULT_BACKGROUND_TIMEOUT_S,
  DEFAULT_TIMEOUT_S,
  MAX_BACKGROUND_TIMEOUT_S,
  MAX_TIMEOUT_S,
} from '../bash/bash';
import {
  MS_PER_SECOND,
  ShellToolResults,
  foregroundDescription,
  normalizeTimeoutMs,
} from '../shell/shellToolResults';
import {
  IPowerShellTool,
  type PowerShellExecutable,
  type PowerShellInput,
  PowerShellInputSchema,
  buildPowerShellArgs,
  normalizePowerShellOutput,
  type PowerShellResolveDeps,
  resolvePowerShellExecutable,
} from './powershell';
import powerShellDescriptionTemplate from './powershell.md?raw';

export interface PowerShellToolOverrides {
  readonly resolveExecutable?: (deps: PowerShellResolveDeps) => Promise<PowerShellExecutable>;
}

function renderPowerShellDescription(): string {
  return renderPrompt(powerShellDescriptionTemplate, {
    DEFAULT_TIMEOUT_S,
    DEFAULT_BACKGROUND_TIMEOUT_S,
    MAX_TIMEOUT_S,
    MAX_BACKGROUND_TIMEOUT_S,
  });
}

function withoutBackgroundDescription(description: string): string {
  return description.replace(
    /\r?\n\r?\nIf `run_in_background=true`,[\s\S]*?point them to the background-task panel\./,
    '\n\nBackground execution is disabled for this agent. Do not set `run_in_background=true`.',
  );
}

function withoutAutoBackgroundOnTimeout(description: string): string {
  return description.replace(
    'a foreground call that hits its timeout is moved to the background instead of being killed.',
    'a foreground call that hits its timeout is killed.',
  );
}

export class PowerShellTool implements IPowerShellTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'PowerShell' as const;
  readonly sideEffect = ToolSideEffects.shell;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(PowerShellInputSchema);

  constructor(
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IConfigService private readonly config: IConfigService,
    private readonly overrides: PowerShellToolOverrides = {},
    @IFlagService private readonly flags?: IFlagService,
  ) {
    this.results = new ShellToolResults(this.tasks, () => this.allowBackground());
  }

  private readonly results: ShellToolResults;

  private allowBackground(): boolean {
    return (
      this.flags?.enabled(OPERATION_LOG_FLAG_ID) !== true &&
      this.toolPolicy.isToolActive('TaskList') &&
      this.toolPolicy.isToolActive('TaskOutput') &&
      this.toolPolicy.isToolActive('TaskStop')
    );
  }

  private autoBackgroundOnTimeout(): boolean {
    if (this.flags?.enabled(OPERATION_LOG_FLAG_ID) === true) return false;
    return resolveAgentTaskConfig(this.config)?.bashAutoBackgroundOnTimeout ?? true;
  }

  private detachTimeoutMs(): number {
    const configuredS = resolveAgentTaskConfig(this.config)?.bashTaskTimeoutS;
    if (configuredS === undefined) return DEFAULT_BACKGROUND_TIMEOUT_S * MS_PER_SECOND;
    return configuredS * MS_PER_SECOND;
  }

  get description(): string {
    const rendered = renderPowerShellDescription();
    if (!this.allowBackground()) return withoutBackgroundDescription(rendered);
    if (!this.autoBackgroundOnTimeout()) return withoutAutoBackgroundOnTimeout(rendered);
    return rendered;
  }

  resolveExecution(args: PowerShellInput): ToolExecution {
    const preview = args.command.length > 50 ? `${args.command.slice(0, 50)}…` : args.command;
    let stop = ({ abandon }: {
      readonly reason: unknown;
      readonly abandon: (result?: ExecutableToolResult) => void;
    }): void => {
      abandon({ isError: true, output: 'Aborted before command started' });
    };
    return {
      description: args.run_in_background
        ? `Starting background: ${preview}`
        : `Running: ${preview}`,
      display: {
        kind: 'command',
        command: args.command,
        cwd: args.cwd ?? this.ctx.cwd,
        description: args.description,
      },
      approvalRule: literalRulePattern(this.name, args.command),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.command),
      stopping: (context) => stop?.(context),
      execute: (ctx) =>
        this.execution(args, ctx, (next) => {
          stop = next;
        }),
    };
  }

  private resolveExecutableDeps(): PowerShellResolveDeps {
    return {
      env: process.env as Record<string, string | undefined>,
      osHomeDir: homedir(),
      isFile: async (path: string): Promise<boolean> => {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
    };
  }

  private async resolveExecutable(): Promise<PowerShellExecutable> {
    const resolver = this.overrides.resolveExecutable ?? resolvePowerShellExecutable;
    return resolver(this.resolveExecutableDeps());
  }

  private spawn(
    processService: IHostProcessService,
    effectiveCwd: string,
    script: string,
    exe: PowerShellExecutable,
  ): Promise<IHostProcess> {
    return processService.spawn(exe.path, buildPowerShellArgs(script), {
      cwd: effectiveCwd,
      env: {
        NO_COLOR: '1',
        POWERSHELL_TELEMETRY_OPTOUT: '1',
        POWERSHELL_UPDATECHECK_OPTOUT: '1',
      },
    });
  }

  private async execution(
    args: PowerShellInput,
    ctx: ExecutableToolContext,
    setStop: (stop: (context: {
      readonly reason: unknown;
      readonly abandon: (result?: ExecutableToolResult) => void;
    }) => void) => void,
  ): Promise<ExecutableToolResult> {
    const {
      signal,
      toolCallId,
      taskId = toolCallId,
      write,
      set,
      detach,
      onDetach,
      onUpdate,
      onForegroundTaskStart,
    } = ctx;
    const validationError = this.results.validateRunRequest(args, signal);
    if (validationError !== undefined) return validationError;

    const startsInBackground = args.run_in_background === true;
    const foregroundTimeoutMs = normalizeTimeoutMs(args.timeout, false);
    const lease = await acquireOrWhenReady(this.environment, ['process']);
    const view = new EnvironmentWorkspaceView(lease.environment, this.workspaceCtx);
    const effectiveCwd = view.resolve(args.cwd ?? view.workDir);
    const description = startsInBackground
      ? args.description!.trim()
      : foregroundDescription('PowerShell', args.command, args.description);
    const timeoutMs = startsInBackground
      ? args.disable_timeout
        ? undefined
        : normalizeTimeoutMs(args.timeout, true)
      : foregroundTimeoutMs;

    const builder = new ToolOutputAccumulator();
    let proc: IHostProcess;
    let exe: PowerShellExecutable;
    try {
      exe = await this.resolveExecutable();
      proc = lease.track(
        await this.spawn(lease.environment.process!, effectiveCwd, args.command, exe),
        this.ctx.sessionId,
      );
    } catch (error) {
      lease.dispose();
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    let detached = startsInBackground;
    let timedOut = false;
    let stopReason: string | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let forceHandle: ReturnType<typeof setTimeout> | undefined;

    const setFields = (
      status: 'running' | 'completed' | 'failed' | 'timed_out' | 'killed',
      exitCode: number | null,
    ): void => {
      set?.({
        task: {
          kind: 'process',
          description,
          command: args.command,
          pid: proc.pid,
          exitCode,
          parentToolCallId: toolCallId,
          timeoutMs,
          timedOut: status === 'timed_out' || undefined,
          stopReason,
        },
      });
    };
    const armTimeout = (duration: number | undefined): void => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
      if (duration === undefined || duration <= 0) return;
      timeoutHandle = setTimeout(() => {
        timeoutHandle = undefined;
        if (this.allowBackground() && this.autoBackgroundOnTimeout() && !detached) {
          detached = true;
          const started = this.results.backgroundStartedResult(taskId, proc, description, {
            title: 'Command timed out and moved to background',
            brief: `Backgrounded ${taskId} after timeout`,
          }, builder, 'foreground_detached');
          detach?.(started.output, started.brief);
          armTimeout(this.detachTimeoutMs());
          return;
        }
        timedOut = true;
        stopReason = 'Timed out';
        void proc.kill('SIGTERM').catch(() => {});
        const graceMs = resolveAgentTaskConfig(this.config)?.killGracePeriodMs ?? 5_000;
        forceHandle = setTimeout(() => {
          void this.forceStop(proc);
        }, graceMs);
        forceHandle.unref?.();
      }, duration);
      timeoutHandle.unref?.();
    };
    const requestDetach = (
      output: string,
      scenario: 'background_started' | 'foreground_detached' | 'foreground_detached_by_user',
      brief?: string,
    ): void => {
      detached = true;
      detach?.(output, brief);
      if (scenario !== 'background_started') armTimeout(this.detachTimeoutMs());
    };
    onDetach?.(() => {
      if (!detached) armTimeout(this.detachTimeoutMs());
      detached = true;
      const started = this.results.backgroundStartedResult(
        taskId,
        proc,
        description,
        {
          title: 'Task moved to background by the user',
          brief: `Backgrounded ${taskId} by the user`,
        },
        builder,
        'foreground_detached_by_user',
      );
      return {
        content: [{ type: 'text', text: started.output }],
        brief: started.brief,
      };
    });
    setStop(({ reason, abandon }) => {
      if (typeof reason === 'string') stopReason = reason;
      else if (reason instanceof Error) stopReason = reason.message;
      else stopReason = userCancellationReason().message;
      void proc.kill('SIGTERM').catch(() => {});
      const graceMs = resolveAgentTaskConfig(this.config)?.killGracePeriodMs ?? 5_000;
      forceHandle = setTimeout(() => {
        void this.forceStop(proc).finally(() => {
          setFields('killed', proc.exitCode);
          abandon();
        });
      }, graceMs);
      forceHandle.unref?.();
    });

    if (!startsInBackground) onForegroundTaskStart?.(taskId);
    setFields('running', null);
    armTimeout(startsInBackground ? timeoutMs : foregroundTimeoutMs);

    const runProcess = createProcessExecutor(proc, (kind, text) => {
      onUpdate?.({ kind, text: normalizePowerShellOutput(text) });
    });
    const forward = (chunk: string): void => {
      const normalized = normalizePowerShellOutput(chunk);
      builder.write(normalized);
      write?.(normalized);
    };

    try {
      if (startsInBackground) {
        const started = this.results.backgroundStartedResult(taskId, proc, description, {
          title: 'Background task started',
          brief: `Started ${taskId}`,
        });
        requestDetach(started.output, 'background_started', started.brief);
      }
      let status: 'completed' | 'failed' | 'timed_out' | 'killed';
      try {
        const outcome = await runProcess(signal, forward);
        status = timedOut ? 'timed_out' : outcome.exitCode === 0 ? 'completed' : 'failed';
      } catch (error) {
        status = timedOut ? 'timed_out' : signal.aborted ? 'killed' : 'failed';
        if (!signal.aborted && stopReason === undefined && !(error instanceof ProcessExitError)) {
          stopReason = error instanceof Error ? error.message : String(error);
        }
      } finally {
        lease.dispose();
      }
      setFields(status, proc.exitCode);
      return await this.results.foregroundCompletionResult(
        taskId,
        proc,
        builder,
        timeoutMs ?? foregroundTimeoutMs,
        { status, stopReason, exitCode: proc.exitCode },
      );
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (forceHandle !== undefined) clearTimeout(forceHandle);
    }
  }

  private async forceStop(proc: IHostProcess): Promise<void> {
    try {
      if (proc.exitCode === null) await proc.kill('SIGKILL');
    } catch {
    }
  }
}

registerAgentToolService(IPowerShellTool, PowerShellTool, {
  name: 'PowerShell',
  domain: 'os/backends',
  requiredEnvironmentCapabilities: ['process'],
  when: () => process.platform === 'win32',
});
