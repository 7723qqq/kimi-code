import type { ExecutableToolOutput, ExecutableToolResult } from '#/agent/tool';
import type {
  AgentTask,
  AgentTaskInfoBase,
  AgentTaskSink,
} from '#/agent/task/types';

export interface QuestionTaskInfo extends AgentTaskInfoBase {
  readonly kind: 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;
}

declare module '#/agent/task/types' {
  interface AgentTaskInfoByKind {
    readonly question: QuestionTaskInfo;
  }
}

export interface QuestionTaskOptions {
  readonly questionCount: number;
  readonly toolCallId?: string;
}

/**
 * Create a `taskService.run()`-compatible executor that runs a question
 * thunk and resolves with its result.  Throws on error or abort.
 */
export function createQuestionExecutor(
  run: (signal: AbortSignal) => Promise<ExecutableToolResult>,
): (signal: AbortSignal, output: (data: string) => void) => Promise<ExecutableToolResult> {
  return async (signal, output) => {
    const result = await run(signal);
    const text = serializeToolOutput(result.output);
    if (text.length > 0) output(text);
    if (result.isError === true) {
      throw new QuestionTaskError(errorStopReason(result) ?? 'Question failed');
    }
    return result;
  };
}

export class QuestionTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionTaskError';
  }
}

export class QuestionTask implements AgentTask {
  readonly kind = 'question' as const;
  readonly idPrefix = 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;

  constructor(
    private readonly run: (signal: AbortSignal) => Promise<ExecutableToolResult>,
    readonly description: string,
    options: QuestionTaskOptions,
  ) {
    this.questionCount = options.questionCount;
    this.toolCallId = options.toolCallId;
  }

  async start(sink: AgentTaskSink): Promise<void> {
    try {
      const result = await this.run(sink.signal);
      const output = serializeToolOutput(result.output);
      if (output.length > 0) sink.appendOutput(output);
      await sink.settle({
        status: result.isError === true ? 'failed' : 'completed',
        stopReason: result.isError === true ? errorStopReason(result) : undefined,
      });
    } catch (error: unknown) {
      if (sink.signal.aborted && isAbortError(error)) {
        await sink.settle({ status: 'killed' });
        return;
      }
      await sink.settle({ status: 'failed', stopReason: errorMessage(error) });
    }
  }

  toInfo(base: AgentTaskInfoBase): QuestionTaskInfo {
    return {
      ...base,
      kind: 'question',
      questionCount: this.questionCount,
      toolCallId: this.toolCallId,
    };
  }
}

function serializeToolOutput(output: ExecutableToolOutput): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

function errorStopReason(result: ExecutableToolResult): string | undefined {
  if (result.message !== undefined && result.message.length > 0) return result.message;
  if (typeof result.output !== 'string') return undefined;
  const trimmed = result.output.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
