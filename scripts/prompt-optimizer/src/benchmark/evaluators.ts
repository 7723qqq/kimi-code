/**
 * Prompt Optimizer — Benchmark evaluators.
 *
 * Pure functions that score model output against defined criteria.
 */

import type { Evaluator } from '../types';

export interface EvalContext {
  output: string;
  toolCalls: ToolCall[];
  tokenUsage: { input: number; output: number };
}

export interface ToolCall {
  name: string;
  input: string;
}

/**
 * The result of one evaluator.
 *
 * `pass` is separate from `score` because they answer different questions:
 * score is how close the output came, pass is whether the case accepts it. With
 * only a score, a threshold parameter has nowhere to take effect, and an
 * evaluator that returns a partial score reads as a failure.
 */
export interface EvalOutcome {
  /** 0-1, how well the output satisfied the criterion. */
  readonly score: number;
  /** Whether the case passes on this evaluator. */
  readonly pass: boolean;
  /** The criterion that was checked, for the report. */
  readonly name: string;
}

/** Every evaluator type the runner can execute. */
export const SUPPORTED_EVALUATOR_TYPES: readonly Evaluator['type'][] = [
  'contains',
  'not-contains',
  'tool-called',
  'tool-not-called',
  'output-length',
  'regex-match',
  'regex-not-match',
  'json-schema',
];

/** Score at or above which an evaluator passes unless the case overrides it. */
const DEFAULT_PASS_THRESHOLD = 1;

function outcome(name: string, score: number, threshold?: number): EvalOutcome {
  return { name, score, pass: score >= (threshold ?? DEFAULT_PASS_THRESHOLD) };
}

/**
 * Run a single evaluator against the model output.
 *
 * A `threshold` in the evaluator's params sets the pass mark, so a partial score
 * can still pass — which is the point of separating the two.
 */
export function runEvaluator(evaluator: Evaluator, ctx: EvalContext): EvalOutcome {
  const rawThreshold = evaluator.params['threshold'];
  const threshold = typeof rawThreshold === 'number' ? rawThreshold : undefined;
  const score = scoreEvaluator(evaluator, ctx);
  return outcome(evaluator.name, score, threshold);
}

/** The numeric score alone, for callers that only need that. */
export function scoreEvaluator(evaluator: Evaluator, ctx: EvalContext): number {
  switch (evaluator.type) {
    case 'contains':
      return evalContains(ctx.output, evaluator.params);
    case 'not-contains':
      return evalNotContains(ctx.output, evaluator.params);
    case 'tool-called':
      return evalToolCalled(ctx.toolCalls, evaluator.params);
    case 'tool-not-called':
      return evalToolNotCalled(ctx.toolCalls, evaluator.params);
    case 'output-length':
      return evalOutputLength(ctx.output, evaluator.params);
    case 'regex-match':
      return evalRegexMatch(ctx.output, evaluator.params);
    case 'regex-not-match':
      return evalRegexNotMatch(ctx.output, evaluator.params);
    case 'json-schema':
      return evalJsonSchema(ctx.output, evaluator.params);
    default:
      return 0;
  }
}

/**
 * Refuse a case set that declares an evaluator the runner cannot execute.
 *
 * The type system rejects an unknown `type` at compile time, but cases are data
 * and this module is not type-checked, so the runtime check stays: it turns a
 * silently-zeroed evaluator into an error that names the case.
 */
export function assertSupportedEvaluators(
  cases: readonly { id: string; evaluators: readonly Evaluator[] }[],
): void {
  const supported = new Set<string>(SUPPORTED_EVALUATOR_TYPES);
  for (const benchCase of cases) {
    for (const evaluator of benchCase.evaluators) {
      if (!supported.has(evaluator.type)) {
        throw new Error(
          `Benchmark case "${benchCase.id}" declares unsupported evaluator ` +
            `"${evaluator.type}" ("${evaluator.name}"). ` +
            `Supported: ${SUPPORTED_EVALUATOR_TYPES.join(', ')}.`,
        );
      }
    }
  }
}

/**
 * Run all evaluators for a case and aggregate scores.
 */
export function runAllEvaluators(
  evaluators: Evaluator[],
  ctx: EvalContext,
): {
  ruleCompliance: number;
  violations: string[];
} {
  const results: EvalOutcome[] = evaluators.map((evaluator) => runEvaluator(evaluator, ctx));

  // Violations follow `pass`, not `score`: a partial score that clears its
  // threshold is a pass, and a score-only test could not express that.
  const violations = results.filter((r) => !r.pass).map((r) => r.name);
  const ruleCompliance =
    results.length === 0 ? 1 : results.reduce((sum, r) => sum + r.score, 0) / results.length;

  return { ruleCompliance, violations };
}

// ─── Individual evaluator implementations ───────────────────────────────────

/** Coerce a string param; non-string values fall back to '' (or String()). */
function strParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

function evalContains(output: string, params: Record<string, unknown>): number {
  const target = strParam(params, 'text');
  const caseSensitive = params['caseSensitive'] !== false;
  if (!caseSensitive) {
    return output.toLowerCase().includes(target.toLowerCase()) ? 1 : 0;
  }
  return output.includes(target) ? 1 : 0;
}

function evalNotContains(output: string, params: Record<string, unknown>): number {
  const target = strParam(params, 'text');
  const caseSensitive = params['caseSensitive'] !== false;
  if (!caseSensitive) {
    return output.toLowerCase().includes(target.toLowerCase()) ? 0 : 1;
  }
  return output.includes(target) ? 0 : 1;
}

function evalToolCalled(toolCalls: ToolCall[], params: Record<string, unknown>): number {
  const toolName = strParam(params, 'tool');
  return toolCalls.some((tc) => tc.name === toolName) ? 1 : 0;
}

function evalToolNotCalled(toolCalls: ToolCall[], params: Record<string, unknown>): number {
  const toolName = strParam(params, 'tool');
  return toolCalls.some((tc) => tc.name === toolName) ? 0 : 1;
}

function evalOutputLength(output: string, params: Record<string, unknown>): number {
  const lines = output.split('\n').filter((l) => l.trim().length > 0);
  const maxLines = Number(params['maxLines'] ?? Infinity);
  const minLines = Number(params['minLines'] ?? 0);

  if (lines.length > maxLines) {
    // Graceful degradation: partial score for being close
    return Math.max(0, 1 - (lines.length - maxLines) / maxLines);
  }
  if (lines.length < minLines) {
    return Math.max(0, lines.length / minLines);
  }
  return 1;
}

function evalRegexMatch(output: string, params: Record<string, unknown>): number {
  const pattern = strParam(params, 'pattern');
  const flags = strParam(params, 'flags');
  try {
    const regex = new RegExp(pattern, flags);
    return regex.test(output) ? 1 : 0;
  } catch {
    return 0;
  }
}

function evalRegexNotMatch(output: string, params: Record<string, unknown>): number {
  const pattern = strParam(params, 'pattern');
  const flags = strParam(params, 'flags');
  try {
    const regex = new RegExp(pattern, flags);
    return regex.test(output) ? 0 : 1;
  } catch {
    return 1;
  }
}

/**
 * Validate `output` against the JSON schema in `params.schema`.
 *
 * Deliberately small: `type`, `required`, and one level of `properties`. A
 * keyword this does not implement makes the check fail rather than pass, so an
 * unimplemented schema cannot inflate a score the way a parse-only check did.
 */
function evalJsonSchema(output: string, params: Record<string, unknown>): number {
  const schema = params['schema'];
  if (schema === undefined) {
    // No schema means nothing to validate against; the caller asked for a check
    // the case did not define, which is a defect in the case, not a pass.
    return 0;
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return 0;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return 0;
  }

  return matchesSchema(parsed, schema as Record<string, unknown>, 0) ? 1 : 0;
}

const JSON_TYPES = ['object', 'array', 'string', 'number', 'boolean', 'null'] as const;

/** Keywords this evaluator understands. Anything else is refused, not ignored. */
const SUPPORTED_KEYWORDS = new Set(['type', 'required', 'properties']);

function matchesSchema(value: unknown, schema: Record<string, unknown>, depth: number): boolean {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) return false;
  }

  const type = schema['type'];
  if (type !== undefined) {
    if (typeof type !== 'string' || !(JSON_TYPES as readonly string[]).includes(type)) return false;
    if (!matchesType(value, type)) return false;
  }

  const required = schema['required'];
  if (required !== undefined) {
    if (!Array.isArray(required)) return false;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    for (const field of required) {
      if (typeof field !== 'string' || !Object.hasOwn(record, field)) return false;
    }
  }

  const properties = schema['properties'];
  if (properties !== undefined) {
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
      return false;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    // One level only: a deeper schema is not implemented and must not pass silently.
    if (depth > 0) return false;
    for (const [key, subSchema] of Object.entries(properties)) {
      if (!Object.hasOwn(record, key)) continue;
      if (typeof subSchema !== 'object' || subSchema === null || Array.isArray(subSchema)) {
        return false;
      }
      if (!matchesSchema(record[key], subSchema as Record<string, unknown>, depth + 1)) {
        return false;
      }
    }
  }

  return true;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}
