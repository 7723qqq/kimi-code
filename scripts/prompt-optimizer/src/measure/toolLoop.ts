/**
 * The multi-turn half of a measurement run.
 *
 * A single-turn caller cannot serve a prompt that grants tools: the model
 * answers with a tool call, the harness has nowhere to put the result, and the
 * turn ends with no rewrite. This loop carries the conversation until the
 * model produces text, executing each call against the working directory the
 * draft names.
 *
 * The loop bounds itself in two ways. Rounds are capped, because a model that
 * keeps investigating is a run worth reporting rather than one worth waiting on
 * forever; and a turn that ends with neither text nor a tool call is raised as
 * a failure instead of being scored as an empty rewrite.
 */

import type { WireMessage } from '../llm-caller';
import type { ModelResponse, ToolDefinition } from '../benchmark/runner';
import { callWithRetryFn } from '../benchmark/runner';

import { executeMeasureTool } from './tools';

/**
 * One round of the conversation, in the harness's neutral message shape, with
 * the tools the loop is declaring on that request.
 *
 * Injected so the loop serves the real transport and the dry-run caller alike;
 * the dry-run caller has no tool loop of its own, and its single response ends
 * the turn. Passing the tools in keeps the loop the single place that decides
 * which tools a measurement turn may use.
 */
export type MeasureTurn = (
  messages: readonly WireMessage[],
  tools: readonly ToolDefinition[],
) => Promise<ModelResponse>;

/**
 * How many tool rounds a turn gets before it is reported as a failure.
 *
 * Six was the first value and it truncated legitimate investigation: measured
 * on MiniMax M3.1 Flash, a draft whose referent the recent turns resolve took
 * eight rounds to return its rewrite, and another took twelve. Twelve leaves
 * room for that without letting a model that never stops run indefinitely.
 *
 * The same model has also run past twenty rounds without producing anything,
 * so the cap bounds the cost of a turn rather than guaranteeing one: a model
 * that keeps reading is reported as a failure, not retried into a longer run.
 */
export const MEASURE_MAX_TOOL_ROUNDS = 12;

/**
 * The model spent every round on tool calls and never produced the rewrite.
 *
 * Distinct from a provider fault: the call completed, so this is evidence about
 * the run and belongs in the report's failure list.
 */
export class MeasureTurnExhaustedError extends Error {
  constructor(readonly rounds: number) {
    super(`model produced no rewrite after ${String(rounds)} tool rounds`);
    this.name = 'MeasureTurnExhaustedError';
  }
}

export async function runMeasureTurn(options: {
  readonly systemPrompt: string;
  readonly input: string;
  readonly tools: readonly ToolDefinition[];
  readonly cwd: string;
  readonly turn: MeasureTurn;
  /** Names the run in a retry message; the caller already knows the draft. */
  readonly label: string;
}): Promise<ModelResponse> {
  const messages: WireMessage[] = [
    { role: 'system', content: options.systemPrompt },
    { role: 'user', content: options.input },
  ];
  const startedAt = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;

  for (let round = 0; round < MEASURE_MAX_TOOL_ROUNDS; round += 1) {
    // Retried per request, not per turn: a dropped body should not replay the
    // rounds before it, and a turn that ended in a refusal is not a transport
    // fault to retry.
    const response = await callWithRetryFn(
      () => options.turn(messages, options.tools),
      `${options.label} round ${String(round + 1)}`,
    );
    inputTokens += response.usage.input;
    outputTokens += response.usage.output;
    cacheReadTokens += response.usage.cacheRead ?? 0;

    if (response.toolCalls.length === 0) {
      if (response.content.length === 0) {
        throw new MeasureTurnExhaustedError(round + 1);
      }
      return {
        content: response.content,
        toolCalls: [],
        usage: { input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens },
        latencyMs: Date.now() - startedAt,
      };
    }

    messages.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.input,
      })),
    });
    for (const call of response.toolCalls) {
      const output = await executeMeasureTool(call.name, call.input, options.cwd);
      messages.push({ role: 'tool', content: output, toolCallId: call.id });
    }
  }

  throw new MeasureTurnExhaustedError(MEASURE_MAX_TOOL_ROUNDS);
}
