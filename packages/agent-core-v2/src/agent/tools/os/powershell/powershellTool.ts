import { access } from 'node:fs/promises';
import { homedir } from 'node:os';

import { renderPrompt } from '#/_base/utils/render-prompt';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { resolveAgentTaskConfig } from '#/agent/task/configSection';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IConfigService } from '#/app/config/config';
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
  DEFAULT_BACKGROUND_TIMEOUT_S,
  DEFAULT_TIMEOUT_S,
  MAX_BACKGROUND_TIMEOUT_S,
  MAX_TIMEOUT_S,
} from '../bash/bash';
import { ProcessTask } from '../bash/process-task';
import {
  MS_PER_SECOND,
  ShellToolResults,
  foregroundDescription,
  killSpawnedProcess,
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
  readonly parameters: Record<string, unknown> = toInputJsonSchema(PowerShellInputSchema);

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IConfigService private readonly config: IConfigService,
    private readonly overrides: PowerShellToolOverrides = {},
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
    const rendered = renderPowerShellDescription();
    if (!this.allowBackground()) return withoutBackgroundDescription(rendered);
    if (!this.autoBackgroundOnTimeout()) return withoutAutoBackgroundOnTimeout(rendered);
    return rendered;
  }

  resolveExecution(args: PowerShellInput): ToolExecution {
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
      },
      approvalRule: literalRulePattern(this.name, args.command),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.command),
      execute: ({ signal, onUpdate, onForegroundTaskStart, toolCallId }) =>
        this.execution(args, signal, toolCallId, onUpdate, onForegroundTaskStart),
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
      proc = lease.track(await this.spawn(lease.runtime.process!, effectiveCwd, args.command, exe));
    } catch (error) {
      lease.dispose();
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    let collectForegroundOutput = !startsInBackground;
    let foregroundOutputPersisted = false;
    let foregroundTaskId: string | undefined;
    const onProcessOutput = startsInBackground
      ? undefined
      : (kind: 'stdout' | 'stderr', text: string): void => {
          if (!collectForegroundOutput) return;
          const normalized = normalizePowerShellOutput(text);
          onUpdate?.({ kind, text: normalized });
          builder.write(normalized);
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
          args.command,
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

registerAgentToolService(IPowerShellTool, PowerShellTool, {
  name: 'PowerShell',
  domain: 'os/backends',
  requiredRuntimeCapabilities: ['process'],
  when: () => process.platform === 'win32',
});
