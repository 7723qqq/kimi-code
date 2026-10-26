import { toLlmSyntaxErrorMessage } from '#/llm/syntax-errors';
import {
  encodeReasoningEffortFallback,
  resolveThinkingEffortForModel,
  type ThinkingEffort,
} from '#/llm/thinking';
import OpenAI from 'openai';
import { assign, shake } from 'radashi';

import type { LlmLogger } from '#/log/log';
import { headersToRecord } from '#/llm/errors';
import { modelKey, type LlmModel } from '#/llm/model';
import type { ProtocolBase, ProtocolRequesterOptions, TraitContext } from '#/llm/protocol/base';
import { resolveModelConnection } from '#/llm/protocol/connection';
import {
  remainingContextTokens,
  resolveMaxCompletionCap,
  type FormatRequestInput,
} from '#/llm/protocol/format';
import { applyThinking } from '#/llm/protocol/thinking';
import {
  type FamilyMaxOutputDefaults,
  fullReasoningEchoRequired,
  ignoredSamplingParamsForModel,
  maxOutputDefaultsForModel,
  resolveModelFamily,
} from '#/llm/modelFamily';
import {
  mergeRequestHeaders,
  type LlmClientContext,
  type LlmRequestConfig,
  type LlmRequestContent,
  type LlmRequestControl,
  type LlmRequester,
  type LlmRequesterOptions,
  type LlmRequestEvent,
  type ToolCallIdPolicy,
} from '#/llm/requester/requester';
import {
  getLlmHeadersTimeoutDispatcher,
  resolveLlmHeadersTimeoutMs,
} from '#/llm/requester/timeout';

import { normalizeToolCallIdsForProvider, sanitizeToolCallId } from '../tool-call-id';
import { getOpenAILegacyModelCapability } from './capability';
import type { OpenAIWireMessage } from './contract';
import {
  assembleOpenAIRequest,
  convertOpenAIError,
  createOpenAIFormat,
  defaultOpenAITool,
  encodeOpenAICacheKey,
  encodeOpenAIMaxCompletionTokens,
  encodeOpenAIRequest,
  encodeOpenAIThinkHistoryKwargs,
  lowerOpenAIMessages,
  parseOpenAIUsage,
  responseFormatToOpenAI,
  stripIgnoredSamplingParams,
  type OpenAIRequestParams,
} from './format';
import { DEFAULT_REASONING_KEY, ReasoningKeyDialect } from './reasoning-key';
import type { OpenAITrait } from './trait';

const OPENAI_CHAT_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
  maxLength: 64,
};

function createClient(model: LlmModel, headers: Record<string, string> | undefined): OpenAI {
  const headersTimeoutMs = resolveLlmHeadersTimeoutMs();
  const dispatcher =
    headersTimeoutMs === undefined ? undefined : getLlmHeadersTimeoutDispatcher(headersTimeoutMs);
  return new OpenAI({
    apiKey: model.apiKey ?? 'unused',
    baseURL: model.baseUrl,
    defaultHeaders: headers,
    maxRetries: 0,
    fetchOptions: dispatcher === undefined ? undefined : { dispatcher },
  });
}

export interface OpenAIRequesterOptions
  extends ProtocolRequesterOptions<OpenAITrait>, LlmRequesterOptions<OpenAI> {
  readonly log?: LlmLogger;
}

export interface OpenAIRequestPreparationOptions {
  readonly trait?: OpenAITrait;
  readonly reasoningKey?: string;
}

function outputTierForEffort(defaults: FamilyMaxOutputDefaults, effort: ThinkingEffort): number {
  if (effort === 'off') return defaults.nonThinking;
  if (effort === 'max') return defaults.thinkingMaxEffort;
  return defaults.thinking;
}

function familyDefaultCap(input: FormatRequestInput, strict: boolean): number | undefined {
  const defaults = maxOutputDefaultsForModel(input.model.model);
  if (defaults === undefined) return undefined;
  const effort = resolveThinkingEffortForModel(
    input.thinking?.effort,
    undefined,
    input.model,
    strict,
  );
  const tier = outputTierForEffort(defaults, effort);
  const remaining = remainingContextTokens(input);
  if (remaining === undefined) return tier;
  return remaining > 0 ? Math.min(tier, remaining) : undefined;
}

function firstUserText(messages: FormatRequestInput['messages']): string {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    if (text.length > 0) return text;
  }
  return '';
}

function deriveDeterminismSeed(model: string, messages: FormatRequestInput['messages']): number {
  const source = `${model}\u0000${firstUserText(messages)}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function prepareOpenAIRequest(
  input: FormatRequestInput,
  options?: OpenAIRequestPreparationOptions,
): OpenAIRequestParams {
  const trait = options?.trait;
  const ctx: TraitContext = { model: input.model };
  let kwargs: Record<string, unknown> = {};
  if (input.cacheKey !== undefined) {
    kwargs = trait?.encodeCacheKey?.(input.cacheKey, ctx) ?? encodeOpenAICacheKey(input.cacheKey);
  }
  let preserveThinking = false;
  if (input.thinking !== undefined) {
    const applied = applyThinking(kwargs, input.thinking, trait?.thinking, ctx, (t) =>
      encodeReasoningEffortFallback(t, ctx.model, trait?.strictThinkingValidation === true),
    );
    kwargs = applied.kwargs;
    preserveThinking = applied.preserveThinking;
  }
  if (
    trait?.thinking === undefined &&
    input.thinking?.effort !== 'off' &&
    kwargs['reasoning_effort'] === undefined &&
    input.messages.some((message) => message.content.some((part) => part.type === 'think'))
  ) {
    kwargs = { ...kwargs, ...encodeOpenAIThinkHistoryKwargs(ctx.model.model) };
  }
  if (input.determinism !== undefined) {
    const seed =
      input.determinism.seed ?? deriveDeterminismSeed(ctx.model.model, input.messages);
    kwargs = { ...kwargs, seed };
  }
  const echoFullReasoning = fullReasoningEchoRequired(
    ctx.model.model,
    input.tools.length > 0,
  );
  if (input.responseFormat !== undefined) {
    kwargs = { ...kwargs, response_format: responseFormatToOpenAI(input.responseFormat) };
  }
  const requested = input.maxCompletionTokens;
  const sentinel = requested !== undefined && requested <= 0;
  const cap = sentinel
    ? undefined
    : (resolveMaxCompletionCap(input) ??
      trait?.completionTokensWhenUnset?.(input) ??
      familyDefaultCap(input, trait?.strictThinkingValidation === true));
  if (cap !== undefined) {
    kwargs = {
      ...kwargs,
      ...(trait?.encodeMaxCompletionTokens?.(cap, ctx) ??
        encodeOpenAIMaxCompletionTokens(ctx.model.model, cap)),
    };
  }
  kwargs = shake(assign(kwargs, input.extraParams?.openai ?? {}));
  kwargs = stripIgnoredSamplingParams(
    kwargs,
    ignoredSamplingParamsForModel(ctx.model.model),
  );
  if (input.tools.length > 0 && resolveModelFamily(ctx.model.model)?.id === 'deepseek') {
    const { response_format: _preemptedByToolConstraint, ...rest } = kwargs;
    kwargs = rest;
  }

  const lowered = lowerOpenAIMessages(input, {
    reasoningKey: options?.reasoningKey ?? DEFAULT_REASONING_KEY,
    preserveThinking,
    echoFullReasoning,
    toolMessageConversion: input.toolMessageConversion ?? trait?.toolMessageConversion,
  });
  const converted = lowered.flatMap(({ source, message }) => {
    if (trait?.convertMessage === undefined) {
      return [message];
    }
    const hooked = trait.convertMessage(source, message, ctx);
    return hooked === null ? [] : [hooked];
  });
  const history: readonly OpenAIWireMessage[] = input.systemPrompt
    ? [{ role: 'system', content: input.systemPrompt }, ...converted]
    : converted;
  const merged = trait?.mergeHistory?.(history, ctx) ?? history;
  const tools = input.tools.map(
    (tool) => trait?.convertTool?.(tool, ctx) ?? defaultOpenAITool(tool),
  );
  const params = assembleOpenAIRequest(input, { messages: merged, tools, kwargs });
  const finalParams = trait?.buildParams?.(params, ctx) ?? params;
  return encodeOpenAIRequest(finalParams);
}

interface OpenAITransport {
  readonly connection: OpenAIRequesterOptions['connection'];
  readonly trait: OpenAITrait | undefined;
  readonly ctx: TraitContext;
  readonly format: ReturnType<typeof createOpenAIFormat>;
  readonly reasoning: ReasoningKeyDialect;
  readonly resolveClient: (request: LlmClientContext) => OpenAI;
  readonly signal: AbortSignal;
  readonly onEvent?: (event: LlmRequestEvent) => void;
  readonly log?: LlmLogger;
}

async function executeOpenAIRequest(
  request: OpenAIRequestParams,
  transport: OpenAITransport,
): Promise<void> {
  const { connection, trait, ctx, format, reasoning, resolveClient, signal, onEvent, log } =
    transport;
  const client = resolveClient({
    model: ctx.model,
    headers: mergeRequestHeaders(
      mergeRequestHeaders(connection?.defaultHeaders?.(ctx), ctx.model.defaultHeaders),
      request.headers,
    ),
  });
  onEvent?.({ type: 'llm.sent' });
  const { data: stream, response } = await client.chat.completions
    .create(request.params, { signal })
    .withResponse();
  onEvent?.({ type: 'llm.streaming.headers', headers: headersToRecord(response.headers) ?? {} });
  const parse = format.createStreamParser({
    reasoningKey: trait?.reasoningKey,
    resolveUsage:
      trait?.extractUsage === undefined
        ? undefined
        : (chunk, defaultUsage) => {
            const hooked = trait.extractUsage?.(chunk);
            return hooked !== undefined ? parseOpenAIUsage(hooked, log) : defaultUsage;
          },
  });
  let messageId: string | undefined;
  for await (const chunk of stream) {
    reasoning.observe(chunk.choices?.[0]?.delta);
    let failed = false;
    parse(chunk, {
      onDelta: (part) => onEvent?.({ type: 'llm.streaming.part', part }),
      onFinish: (finish) => onEvent?.({ type: 'llm.streaming.finish', finish }),
      onMessageId: (id) => {
        if (id === messageId) return;
        messageId = id;
        onEvent?.({ type: 'llm.streaming.message_id', messageId: id });
      },
      onUsage: (usage) => onEvent?.({ type: 'llm.streaming.usage', usage }),
      onError: (message) => {
        failed = true;
        onEvent?.({ type: 'llm.failed.remote', error: message });
      },
    });
    if (failed) {
      return;
    }
  }
  onEvent?.({ type: 'llm.done' });
}

export function createOpenAIRequester(options?: OpenAIRequesterOptions): LlmRequester {
  const connection = options?.connection;
  const trait = options?.trait;
  const classifyError = options?.classifyError;
  const format = createOpenAIFormat(options?.log);
  const resolveClient =
    options?.clientFactory ??
    ((request: LlmClientContext) => createClient(request.model, request.headers));
  const reasoningByModel = new Map<string, ReasoningKeyDialect>();
  const reasoningFor = (ctx: TraitContext): ReasoningKeyDialect => {
    const key = modelKey(ctx.model);
    let reasoning = reasoningByModel.get(key);
    if (reasoning === undefined) {
      reasoning = new ReasoningKeyDialect(trait?.reasoningKey);
      reasoningByModel.set(key, reasoning);
    }
    return reasoning;
  };
  return {
    async generate(
      config: LlmRequestConfig,
      content: LlmRequestContent,
      control: LlmRequestControl,
    ): Promise<void> {
      const model = resolveModelConnection(config.model, connection);
      const { tools = [] } = config;
      const { messages } = content;
      const { signal, onEvent } = control;
      const ctx: TraitContext = { model };
      let reasoning: ReasoningKeyDialect;
      let request: OpenAIRequestParams;
      try {
        reasoning = reasoningFor(ctx);
        const policy = trait?.toolCallIdPolicy ?? OPENAI_CHAT_TOOL_CALL_ID_POLICY;
        request = prepareOpenAIRequest(
          {
            ...config,
            model,
            messages: normalizeToolCallIdsForProvider(messages, policy),
            tools,
            usedContextTokens: content.usedContextTokens,
          },
          { trait, reasoningKey: reasoning.outboundKey() },
        );
      } catch (error) {
        onEvent?.({ type: 'llm.failed.syntax', error: toLlmSyntaxErrorMessage(error) });
        return;
      }
      try {
        await executeOpenAIRequest(request, {
          connection,
          trait,
          ctx,
          format,
          reasoning,
          resolveClient,
          signal,
          onEvent,
          log: options?.log,
        });
      } catch (error) {
        onEvent?.({
          type: 'llm.failed.remote',
          error: convertOpenAIError(error, (e) => classifyError?.(e)),
        });
      }
    },
  };
}

export const openAIBase: ProtocolBase<OpenAITrait> = {
  capability: getOpenAILegacyModelCapability,
  createRequester: createOpenAIRequester,
};
