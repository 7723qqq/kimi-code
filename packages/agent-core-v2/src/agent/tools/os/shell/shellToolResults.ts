import { userCancellationReason } from '#/_base/utils/abort';
import type { IAgentTaskService } from '#/agent/task/task';
import type { IHostProcess } from '#/os/interface/hostProcess';
import { type ToolOutputAccumulatorResult, ToolOutputAccumulator } from '#/tool/output-accumulator';
import { DEFAULT_TOOL_RESULT_MAX_CHARS, type ExecutableToolResult } from '#/tool/toolContract';

import {
  DEFAULT_BACKGROUND_TIMEOUT_S,
  DEFAULT_TIMEOUT_S,
  MAX_BACKGROUND_TIMEOUT_S,
  MAX_TIMEOUT_S,
} from '../bash/bash';

export const MS_PER_SECOND = 1000;

export type BackgroundStartScenario =
  | 'background_started'
  | 'foreground_detached'
  | 'foreground_detached_by_user';

export interface ShellToolCommandInput {
  readonly command: string;
  readonly run_in_background?: boolean | undefined;
  readonly description?: string | undefined;
}

export function timeoutCapS(isBackground: boolean): number {
  return isBackground ? MAX_BACKGROUND_TIMEOUT_S : MAX_TIMEOUT_S;
}

export function normalizeTimeoutMs(timeout: number | undefined, isBackground: boolean): number {
  const defaultSeconds = isBackground ? DEFAULT_BACKGROUND_TIMEOUT_S : DEFAULT_TIMEOUT_S;
  const value = timeout ?? defaultSeconds;
  return Math.min(value, timeoutCapS(isBackground)) * MS_PER_SECOND;
}

export function formatTimeoutLabel(timeoutMs: number): string {
  return timeoutMs % 1000 === 0 ? `${String(timeoutMs / 1000)}s` : `${String(timeoutMs)}ms`;
}

export function foregroundDescription(
  label: string,
  command: string,
  description: string | undefined,
): string {
  const explicit = description?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const preview = command.length > 60 ? `${command.slice(0, 60)}…` : command;
  return `${label}: ${preview}`;
}

export async function disposeProcess(proc: IHostProcess): Promise<void> {
  try {
    await proc.dispose();
  } catch {}
}

export async function killSpawnedProcess(proc: IHostProcess): Promise<void> {
  try {
    await proc.kill('SIGTERM');
  } catch {
  } finally {
    await disposeProcess(proc);
  }
}

export class ShellToolResults {
  constructor(
    private readonly tasks: IAgentTaskService,
    private readonly allowBackground: () => boolean,
  ) {}

  validateRunRequest(
    args: ShellToolCommandInput,
    signal: AbortSignal,
  ): ExecutableToolResult | undefined {
    if (signal.aborted) return { isError: true, output: 'Aborted before command started' };
    if (args.command.length === 0) return { isError: true, output: 'Command cannot be empty.' };
    if (args.run_in_background !== true) return undefined;
    if (!this.allowBackground()) {
      return {
        isError: true,
        output:
          'Background execution is not available for this agent because TaskOutput and TaskStop are not enabled.',
      };
    }
    if (!args.description?.trim()) {
      return {
        isError: true,
        output: 'description is required when run_in_background is true.',
      };
    }
    return undefined;
  }

  async foregroundCompletionResult(
    taskId: string,
    proc: IHostProcess,
    builder: ToolOutputAccumulator,
    foregroundTimeoutMs: number,
  ): Promise<ExecutableToolResult> {
    const current = this.tasks.getTask(taskId);
    const exitCode = current?.kind === 'process' ? current.exitCode : proc.exitCode;
    let result: ToolOutputAccumulatorResult;
    if (current?.status === 'timed_out') {
      const timeoutLabel = formatTimeoutLabel(foregroundTimeoutMs);
      result = builder.error(`Command killed by timeout (${timeoutLabel})`, {
        brief: `Killed by timeout (${timeoutLabel})`,
      });
    } else if (
      current?.status === 'killed' &&
      current.stopReason === userCancellationReason().message
    ) {
      result = builder.error('Interrupted by user', { brief: 'Interrupted by user' });
    } else if (
      (current?.status === 'failed' || current?.status === 'killed') &&
      current.stopReason !== undefined
    ) {
      result = builder.error(current.stopReason, { brief: current.stopReason });
    } else if (exitCode === 0) {
      result = builder.ok('Command executed successfully.');
    } else {
      if (builder.nChars === 0) builder.write(`Process exited with code ${String(exitCode)}`);
      result = builder.error(`Command failed with exit code: ${String(exitCode)}.`, {
        brief: `Failed with exit code: ${String(exitCode)}`,
      });
    }
    return this.addForegroundOutputReference(taskId, result, builder.totalChars);
  }

  async addForegroundOutputReference(
    taskId: string,
    result: ToolOutputAccumulatorResult,
    totalChars: number,
  ): Promise<ExecutableToolResult> {
    if (totalChars <= DEFAULT_TOOL_RESULT_MAX_CHARS) return result;
    const output = await this.tasks.getOutputSnapshot(taskId, 0);
    if (!output.fullOutputAvailable || output.outputPath === undefined) {
      return result;
    }

    const taskOutputHint = this.allowBackground()
      ? `\nnext_step: Use TaskOutput(task_id="${taskId}") to query the task output.`
      : '';
    const taskInfo = `task_id: ${taskId}\noutput_size_bytes: ${String(output.outputSizeBytes)}${taskOutputHint}`;
    const existingSuffix = result.spill?.suffix;
    return {
      ...result,
      spill: {
        outputPath: output.outputPath,
        totalChars,
        suffix: existingSuffix !== undefined ? `${existingSuffix}\n${taskInfo}` : taskInfo,
      },
    };
  }

  backgroundStartedResult(
    taskId: string,
    proc: IHostProcess,
    description: string,
    labels: { title: string; brief: string },
    builder = new ToolOutputAccumulator(),
    scenario: BackgroundStartScenario = 'background_started',
  ): ExecutableToolResult {
    const current = this.tasks.getTask(taskId);
    const status = current?.status ?? 'running';
    const outputPath = current?.outputPath;
    const detachedByUser =
      scenario === 'foreground_detached_by_user' ? 'detached_by_user: true\n' : '';
    const metadata =
      `task_id: ${taskId}\n` +
      `pid: ${String(proc.pid)}\n` +
      `description: ${description}\n` +
      `status: ${status}\n` +
      (outputPath === undefined ? '' : `output_path: ${outputPath}\n`) +
      detachedByUser +
      `automatic_notification: true\n` +
      this.nextStepLines(scenario) +
      'human_shell_hint: The task is visible in the background-task panel.';

    const foregroundResult = builder.ok('');
    const foregroundOutput = foregroundResult.output.length > 0 ? foregroundResult.output : '';
    const result: ExecutableToolResult & {
      readonly brief: string;
    } = {
      isError: false,
      output:
        foregroundOutput.length === 0
          ? metadata
          : `${metadata}\n\nforeground_output:\n${foregroundOutput}`,
      brief: labels.brief,
    };
    return result;
  }

  nextStepLines(scenario: BackgroundStartScenario): string {
    if (scenario === 'foreground_detached' || scenario === 'foreground_detached_by_user') {
      const avoid = this.allowBackground()
        ? 'do NOT wait, poll, or call TaskOutput on it'
        : 'do NOT wait or poll';
      const moved =
        scenario === 'foreground_detached_by_user'
          ? 'The user moved this task to the background.'
          : 'The task now runs in the background.';
      return (
        `next_step: ${moved} You will be automatically notified ` +
        `when it completes — ${avoid}; continue with your current work.\n`
      );
    }
    if (!this.allowBackground()) {
      return 'next_step: You will be automatically notified when it completes.\n';
    }
    return (
      'next_step: The completion arrives automatically in a later turn — do NOT wait, poll, ' +
      'or call TaskOutput on it; continue with your current work.\n' +
      'next_step: Use TaskStop only if the task must be cancelled.\n'
    );
  }
}
