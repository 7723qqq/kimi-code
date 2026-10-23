/**
 * Prompt Optimizer — Benchmark runner.
 *
 * Executes benchmark cases against a given prompt variant and model,
 * collects results, and outputs a structured report.
 */

import { avg } from '../format';
import { estimateTokens } from '../prompt-parser';
import { redactSecrets } from '../redact';
import type {
  ApiErrorCategory,
  ApiErrorRecord,
  BenchmarkCase,
  BenchmarkResult,
  BenchmarkScores,
  PromptVariant,
} from '../types';
import { runAllEvaluators, type EvalContext } from './evaluators';

export interface RunnerConfig {
  model: string;
  apiBaseUrl: string;
  apiKey: string;
  concurrency: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface ModelResponse {
  content: string;
  toolCalls: { name: string; input: string }[];
  /**
   * Token accounting as the provider reports it.
   *
   * `input` is what was billed at full rate; `cacheRead` is what was served from
   * the provider's prompt cache. Both are prompt tokens the model processed, so
   * a comparison that counts only `input` measures cache hits rather than work.
   */
  usage: { input: number; output: number; cacheRead?: number };
  latencyMs: number;
}

/**
 * LLM caller signature — includes optional tool definitions.
 */
export type LLMCaller = (
  systemPrompt: string,
  userMessages: string[],
  config: RunnerConfig,
  tools?: ToolDefinition[],
) => Promise<ModelResponse>;

/**
 * Dry-run caller that simulates model responses for testing the framework.
 */
export const dryRunCaller: LLMCaller = async (_system, userMessages, _config, _tools) => {
  return {
    content: `[DRY RUN] Would respond to: "${userMessages[0]?.slice(0, 50)}..."`,
    toolCalls: [],
    usage: { input: 100, output: 50 },
    latencyMs: 0,
  };
};

/** How many times a transient provider fault is retried before giving up. */
export const CALL_ATTEMPTS = 3;
/** Delay between attempts; the failures observed are independent per call. */
export const RETRY_DELAY_MS = 400;

/**
 * Call the model, retrying a transient provider fault.
 *
 * Providers answer 200 with a dropped body often enough that a run of a hundred
 * calls would otherwise abort partway through — measured at roughly 6% of calls
 * for one provider, and independent between calls, so a retry almost always
 * succeeds. The label names what was being evaluated when it finally failed.
 */
export async function callWithRetry(
  caller: LLMCaller,
  systemPrompt: string,
  userMessages: string[],
  config: RunnerConfig,
  tools: ToolDefinition[] | undefined,
  label: string,
): Promise<ModelResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CALL_ATTEMPTS; attempt++) {
    try {
      return await caller(systemPrompt, userMessages, config, tools);
    } catch (error: unknown) {
      lastError = error;
      if (attempt < CALL_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      }
    }
  }
  throw new Error(
    `${label} failed after ${CALL_ATTEMPTS} attempts: ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { cause: lastError },
  );
}

/**
 * Run a single benchmark case against a prompt variant.
 */
export async function runCase(
  benchCase: BenchmarkCase,
  variant: PromptVariant,
  caller: LLMCaller,
  config: RunnerConfig,
): Promise<BenchmarkResult> {
  const start = Date.now();

  const response = await callWithRetry(
    caller,
    variant.content,
    benchCase.userMessages,
    config,
    benchCase.availableTools,
    `case "${benchCase.id}"`,
  );

  const latencyMs = Date.now() - start;

  const evalCtx: EvalContext = {
    output: response.content,
    toolCalls: response.toolCalls,
    tokenUsage: response.usage,
  };

  const { ruleCompliance, violations } = runAllEvaluators(benchCase.evaluators, evalCtx);

  const scores: BenchmarkScores = {
    taskSuccess: violations.length === 0,
    ruleCompliance,
    // Every prompt token the model processed, whether billed at full rate or
    // served from cache. Counting only `input` measures how often the provider
    // happened to have the prompt cached — which depends on call ordering, not
    // on the variant being compared.
    tokenEfficiency:
      response.usage.input + (response.usage.cacheRead ?? 0) + response.usage.output,
    toolAccuracy: computeToolAccuracy(benchCase, response.toolCalls),
    outputConciseness: computeConciseness(response.content),
  };

  return {
    taskId: benchCase.id,
    promptVersion: variant.name,
    model: config.model,
    scores,
    violations,
    latencyMs,
    tokenUsage: response.usage,
    rawOutput: response.content,
  };
}

/**
 * Run all cases in a benchmark suite against a variant.
 */
export async function runSuite(
  cases: BenchmarkCase[],
  variant: PromptVariant,
  caller: LLMCaller,
  config: RunnerConfig,
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  // Run with limited concurrency
  const queue = [...cases];
  const running: Promise<void>[] = [];

  while (queue.length > 0 || running.length > 0) {
    while (running.length < config.concurrency && queue.length > 0) {
      const benchCase = queue.shift()!;
      const promise = runCase(benchCase, variant, caller, config)
        .then((result) => {
          results.push(result);
        })
        .finally(() => {
          void running.splice(running.indexOf(promise), 1);
        });
      running.push(promise);
    }
    if (running.length > 0) {
      await Promise.race(running);
    }
  }

  return results;
}

// ─── Production-rendered inputs ─────────────────────────────────────────────

/**
 * A prompt the production renderer produced, ready to send.
 *
 * `reminder` is separate from `system` because it is not part of the system
 * message: the runtime delivers it as an authoritative directive ahead of the
 * user's turn, and the report has to say where it went.
 */
export interface RenderedInput {
  name: string;
  system: string;
  reminder?: string;
  profile?: string;
  sourceHash?: string;
  fixtureSummary?: Record<string, unknown>;
  contractDelivery?: readonly { id: string; channel: string }[];
  tokens?: { system: number; reminder: number };
}

/** The harness's authoritative directive wrapper, as the runtime writes it. */
export function reminderPrelude(reminder: string): string {
  return `<system-reminder>\n${reminder}\n</system-reminder>`;
}

/**
 * The user messages for one case, with the reminder in the position the runtime
 * puts it: a leading user-role message, not a second system message.
 */
export function renderedMessages(
  benchCase: Pick<BenchmarkCase, 'userMessages'>,
  input: Pick<RenderedInput, 'reminder'>,
): string[] {
  const reminder = input.reminder ?? '';
  return reminder.length === 0
    ? [...benchCase.userMessages]
    : [reminderPrelude(reminder), ...benchCase.userMessages];
}

/**
 * An answer that arrived but cannot be scored.
 *
 * Distinct from a provider fault on purpose: only this one is evidence about the
 * model, and a caller that detects an unusable answer raises it instead of
 * throwing a bare Error that would read as a transport failure.
 */
export class ModelFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelFailureError';
  }
}

/** Messages that identify a transport/provider fault rather than a bad answer. */
const PROVIDER_FAILURE_SIGNATURES: readonly RegExp[] = [
  /^API \d{3}\b/m,
  /Anthropic API \d{3}\b/,
  /provider-side fault/i,
  /No choices in API response/i,
  /carried no usable content/i,
  /failed after \d+ attempts/i,
  /No API key found/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)\b/,
  /socket hang up|fetch failed|network error|rate limit/i,
];

/** Messages that identify an unusable answer rather than a failed call. */
const MODEL_FAILURE_SIGNATURES: readonly RegExp[] = [
  /model failure/i,
  /empty (?:model )?(?:answer|response)/i,
  /unparseable (?:answer|response|tool call)/i,
];

/**
 * Sort a call failure into the two categories the report distinguishes.
 *
 * `ModelFailureError` and a message that names an unusable answer are model
 * failures; a recognised transport signature is a provider failure. An
 * unrecognised throw is also a provider failure: claiming the model misbehaved
 * on no evidence is worse than recording that the call never completed.
 */
export function classifyCallFailure(error: unknown): ApiErrorCategory {
  if (error instanceof ModelFailureError) return 'model_failure';
  const message = error instanceof Error ? error.message : String(error);
  if (PROVIDER_FAILURE_SIGNATURES.some((signature) => signature.test(message))) {
    return 'provider_failure';
  }
  if (MODEL_FAILURE_SIGNATURES.some((signature) => signature.test(message))) {
    return 'model_failure';
  }
  return 'provider_failure';
}

function deliveryCounts(
  delivery: readonly { readonly id: string; readonly channel: string }[] | undefined,
): { system: number; reminder: number } | undefined {
  if (delivery === undefined) return undefined;
  let system = 0;
  let reminder = 0;
  for (const entry of delivery) {
    if (entry.channel === 'system') system += 1;
    else if (entry.channel === 'reminder') reminder += 1;
  }
  return { system, reminder };
}

/**
 * Run one case against a rendered prompt.
 *
 * Everything the report needs about the prompt travels with the result — profile,
 * source hash, fixture summary, delivery counts and token split — so a case can
 * never be attributed to an unstated prompt.
 */
export async function runRenderedCase(
  benchCase: BenchmarkCase,
  input: RenderedInput,
  caller: LLMCaller,
  config: RunnerConfig,
): Promise<BenchmarkResult> {
  const start = Date.now();
  const response = await callWithRetry(
    caller,
    input.system,
    renderedMessages(benchCase, input),
    config,
    benchCase.availableTools,
    `case "${benchCase.id}"`,
  );
  const latencyMs = Date.now() - start;

  const evalCtx: EvalContext = {
    output: response.content,
    toolCalls: response.toolCalls,
    tokenUsage: response.usage,
  };
  const { ruleCompliance, violations } = runAllEvaluators(benchCase.evaluators, evalCtx);
  const delivery = deliveryCounts(input.contractDelivery);

  return {
    taskId: benchCase.id,
    promptVersion: input.name,
    model: config.model,
    scores: {
      taskSuccess: violations.length === 0,
      ruleCompliance,
      tokenEfficiency:
        response.usage.input + (response.usage.cacheRead ?? 0) + response.usage.output,
      toolAccuracy: computeToolAccuracy(benchCase, response.toolCalls),
      outputConciseness: computeConciseness(response.content),
    },
    violations,
    latencyMs,
    tokenUsage: response.usage,
    rawOutput: response.content,
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    ...(input.sourceHash === undefined ? {} : { sourceHash: input.sourceHash }),
    ...(input.fixtureSummary === undefined ? {} : { fixtureSummary: input.fixtureSummary }),
    ...(delivery === undefined ? {} : { delivery }),
    ...(input.tokens === undefined ? {} : { tokens: input.tokens }),
    ...(input.reminder === undefined || input.reminder.length === 0
      ? {}
      : { reminderRole: 'user-prelude' as const }),
  };
}

export interface RenderedSuiteRun {
  results: BenchmarkResult[];
  /**
   * Cases that produced no result because the call failed. They are not scored:
   * a case that never ran says nothing about the prompt, and scoring it as a
   * violation would report a provider fault as a model failure.
   */
  apiErrors: ApiErrorRecord[];
}

/**
 * Run every case against one rendered prompt, tolerating individual failures.
 *
 * The raw-template suite aborts on the first failed call, which is fine for a
 * pruning experiment. A real evaluation is the opposite: one dropped response
 * must not throw away the other cases, and the report has to say which call
 * failed and in which category.
 */
export async function runRenderedSuite(
  cases: readonly BenchmarkCase[],
  input: RenderedInput,
  caller: LLMCaller,
  config: RunnerConfig,
): Promise<RenderedSuiteRun> {
  const results: BenchmarkResult[] = [];
  const apiErrors: ApiErrorRecord[] = [];
  const queue = [...cases];
  const workers = Math.max(1, Math.min(Math.floor(config.concurrency) || 1, queue.length));

  const runWorker = async (): Promise<void> => {
    for (;;) {
      const benchCase = queue.shift();
      if (benchCase === undefined) return;
      try {
        results.push(await runRenderedCase(benchCase, input, caller, config));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        apiErrors.push({
          caseId: benchCase.id,
          category: classifyCallFailure(error),
          message: redactSecrets(message).slice(0, 300),
        });
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, runWorker));

  const order = new Map(cases.map((benchCase, index) => [benchCase.id, index]));
  results.sort((a, b) => (order.get(a.taskId) ?? 0) - (order.get(b.taskId) ?? 0));
  apiErrors.sort((a, b) => (order.get(a.caseId) ?? 0) - (order.get(b.caseId) ?? 0));
  return { results, apiErrors };
}

/**
 * Compute aggregate scores across a suite run.
 */
export function aggregateResults(results: BenchmarkResult[]): {
  totalCases: number;
  passRate: number;
  avgRuleCompliance: number;
  avgTokenEfficiency: number;
  avgToolAccuracy: number;
  avgConciseness: number;
  topViolations: { rule: string; count: number }[];
} {
  const totalCases = results.length;
  const passCount = results.filter((r) => r.scores.taskSuccess).length;

  const avgRuleCompliance = avg(results.map((r) => r.scores.ruleCompliance));
  const avgTokenEfficiency = avg(results.map((r) => r.scores.tokenEfficiency));
  const avgToolAccuracy = avg(results.map((r) => r.scores.toolAccuracy));
  const avgConciseness = avg(results.map((r) => r.scores.outputConciseness));

  // Count violations
  const violationCounts = new Map<string, number>();
  for (const r of results) {
    for (const v of r.violations) {
      violationCounts.set(v, (violationCounts.get(v) ?? 0) + 1);
    }
  }
  const topViolations = [...violationCounts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([rule, count]) => ({ rule, count }));

  return {
    totalCases,
    passRate: totalCases > 0 ? passCount / totalCases : 0,
    avgRuleCompliance,
    avgTokenEfficiency,
    avgToolAccuracy,
    avgConciseness,
    topViolations,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeToolAccuracy(
  benchCase: BenchmarkCase,
  toolCalls: { name: string; input: string }[],
): number {
  const toolEvals = benchCase.evaluators.filter(
    (e) => e.type === 'tool-called' || e.type === 'tool-not-called',
  );
  if (toolEvals.length === 0) return 1;

  let correct = 0;
  for (const ev of toolEvals) {
    const rawTool = ev.params['tool'];
    const toolName = typeof rawTool === 'string' ? rawTool : '';
    const called = toolCalls.some((tc) => tc.name === toolName);
    if (ev.type === 'tool-called' && called) correct++;
    if (ev.type === 'tool-not-called' && !called) correct++;
  }
  return correct / toolEvals.length;
}

function computeConciseness(output: string): number {
  const tokens = estimateTokens(output);
  // Score degrades for very long outputs
  if (tokens <= 100) return 1;
  if (tokens <= 300) return 0.8;
  if (tokens <= 600) return 0.6;
  if (tokens <= 1000) return 0.4;
  return 0.2;
}

