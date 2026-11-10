import { LifecycleScope } from '#/app/scopes';
import { IInstantiationService } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import {
  IAgentContextProjectorService,
  MEDIA_DEGRADE_KEEP_RECENT,
  type MediaProjection,
  type MediaStripSnapshot,
  type ProjectionPolicy,
} from '#/agent/contextProjector/contextProjector';
import { estimateLlmRequestBytes } from '#/agent/contextProjector/requestSize';
import { IAgentMicroCompactionService } from '#/agent/microCompaction/microCompaction';
import { IHostTimers } from '#/os/interface/hostTimers';
import { buildCacheObservation } from '#/agent/usage/cacheObservation';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';

import { resolveRequestByteBudget } from './configSection';
import { IAgentProfileService, type ProfileModelContext } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentMediaResolverService } from '#/agent/media/mediaResolver';
import {
  buildMediaPathTag,
  matchMediaPathTags,
  type MediaPathTag,
} from '#/agent/media/mediaRef';
import { READ_MEDIA_FILE_TOOL_NAME } from '#/agent/tools/read-media-file/read-media-file';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { IConfigService } from '#/app/config/config';
import {
  APIContextOverflowError,
  APIRequestTooLargeError,
  APIStatusError,
  classifyApiError,
  isImageFormatError,
  isRecoverableRequestStructureError,
  isRetryableGenerateError,
} from '#/llm-adapter/contract/errors';
import type { Message } from '#/llm-adapter/contract/message';
import { type ThinkingEffort } from '#human/llm/thinking';
import type { LlmCredentialProvider } from '#human/llm/requester/requester';
import { isToolCall, type StreamedMessagePart, type ToolDescription as Tool } from '#human/llm/message';
import { emptyUsage, inputTotal, type TokenUsage } from '#human/llm/usage';
import { ILogService, type LogContext } from '#/_base/log/log';
import { IModelCatalog, type Model } from '#/llm-adapter/model/catalog';
import {
  effectiveMaxCompletionTokens,
  type ModelRequestEvent,
  type ModelRequestParams,
  type ModelRequester,
  type ModelRequestTiming,
} from '#/llm-adapter/model/model-requester';
import type { ModelOverrides } from '#/llm-adapter/model/model.types';
import { IModelService } from '#/llm-adapter/model/model';
import { completionBudgetParams, resolveCompletionBudget } from '#/llm-adapter/model/completion-budget';
import { resolveThinkingKeep, type ThinkingConfig } from '#/llm-adapter/model/thinking';
import { MODEL_OVERRIDES_SECTION, THINKING_SECTION } from '#/app/kosongConfig/configSection';
import type { Protocol } from '#/llm-adapter/protocol/protocol';
import type {
  ApiErrorEvent,
  LlmRequestProjectionFallbackEvent,
} from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { WarningIssued } from '#/agent/profile/profileOps';

import {
  IAgentLLMRequesterService,
  type AgentLLMRequestFinish,
  type AgentLLMRequestLogFields,
  type AgentLLMRequestOverrides,
  type AgentLLMRequestPartHandler,
  type AgentLLMRequestSource,
  type AgentLLMRequestTask,
  type AgentLLMTurnRequestSnapshot,
  type PreparedTurnRequestConfig,
} from './llmRequester';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import {
  ToolCallIdNormalizer,
  type ToolCallIdResponseNormalizer,
} from '#human/llm/toolCallIdNormalizer';
import {
  LlmRequest,
  llmRequestTraceKey,
  LlmToolsSnapshot,
  type LlmRequestPayload,
  type LlmRequestToolSchema,
} from './llmRequestOps';
import { isAbortError } from '#/_base/utils/abort';
import { parseBooleanEnv } from '#/_base/utils/env';
import { ErrorCodes, Error2, unwrapErrorCause } from '#/errors';
import {
  readRetryAfterMs,
  retryBackoffDelay,
  retryErrorFields,
  sleepForRetry,
} from '#/_base/utils/retry';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';

const noopOnPart: AgentLLMRequestPartHandler = () => {};

export const KIMI_CODE_INFINITE_RETRY_ENV = 'KIMI_CODE_INFINITE_RETRY';

interface ResolvedLLMRequest {
  readonly requester: ModelRequester;
  readonly model: Model;
  readonly params: ModelRequestParams;
  readonly modelAlias: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly contextRevision: number;
  readonly promptCacheProbe:
    | { readonly source: 'compaction'; readonly baseline?: AgentLLMTurnRequestSnapshot }
    | undefined;
  readonly source: AgentLLMRequestSource | undefined;
  readonly logFields: AgentLLMRequestLogFields;
}

interface LLMRequestLogInput {
  readonly protocol: Protocol;
  readonly providerType?: string;
  readonly modelName: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: ThinkingEffort | null;
  readonly maxTokens?: number;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly fields?: AgentLLMRequestLogFields;
}

interface TurnRequestConfig {
  readonly resolved: ProfileModelContext;
  readonly params: ModelRequestParams;
  readonly systemPrompt: string;
}

interface ProactiveMediaEscalation {
  readonly mediaEscalationPolicy: ProjectionPolicy;
}

function isProactiveMediaEscalation(
  outcome: AgentLLMRequestFinish | ProactiveMediaEscalation,
): outcome is ProactiveMediaEscalation {
  return 'mediaEscalationPolicy' in outcome;
}

export const llmRequesterLastConfigLogSignatureKey = defineState<string | undefined>(
  'llmRequester.lastConfigLogSignature',
  () => undefined as string | undefined,
);
export const llmRequesterTurnConfigsKey = defineState<Map<number, TurnRequestConfig>>(
  'llmRequester.turnConfigs',
  () => new Map(),
);
interface MediaRecovery {
  readonly modelAlias: string;
  readonly contextRevision: number;
  readonly media: MediaProjection;
}

export const llmRequesterMediaRecoveryKey = defineState<MediaRecovery | undefined>(
  'llmRequester.mediaRecovery',
  () => undefined as MediaRecovery | undefined,
);
export const llmRequesterEmittedThinkingEffortWarningsKey = defineState<Set<string>>(
  'llmRequester.emittedThinkingEffortWarnings',
  () => new Set(),
);
export const llmRequesterLastTurnRequestKey = defineState<AgentLLMTurnRequestSnapshot | undefined>(
  'llmRequester.lastTurnRequest',
  () => undefined as AgentLLMTurnRequestSnapshot | undefined,
);

export class AgentLLMRequesterService implements IAgentLLMRequesterService {
  declare readonly _serviceBrand: undefined;

  private readonly toolCallIdNormalizer = new ToolCallIdNormalizer();

  private microCompactionService: IAgentMicroCompactionService | undefined;
  private get microCompaction(): IAgentMicroCompactionService | undefined {
    if (this.instantiation === undefined) return undefined;
    this.microCompactionService ??= this.instantiation.invokeFunction((accessor) =>
      accessor.get(IAgentMicroCompactionService),
    );
    return this.microCompactionService;
  }

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextProjectorService private readonly projector: IAgentContextProjectorService,
    @ISessionTokenCountingService private readonly tokenCounting: ISessionTokenCountingService,
    @IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService,
    @IAgentMediaResolverService private readonly mediaResolver: IAgentMediaResolverService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ISessionUsageService private readonly usage: ISessionUsageService,
    @IConfigService private readonly config: IConfigService,
    @IModelService private readonly modelService: IModelService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly states: IAgentStateService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IInstantiationService private readonly instantiation?: IInstantiationService,
    @IHostTimers private readonly hostTimers?: IHostTimers,
  ) {
    this.states.contributeState(llmRequestTraceKey);
    this.states.contributeState(llmRequesterLastConfigLogSignatureKey);
    this.states.contributeState(llmRequesterTurnConfigsKey);
    this.states.contributeState(llmRequesterMediaRecoveryKey);
    this.states.contributeState(llmRequesterEmittedThinkingEffortWarningsKey);
    this.states.contributeState(llmRequesterLastTurnRequestKey);
  }

  private get lastConfigLogSignature(): string | undefined {
    return this.states.get(llmRequesterLastConfigLogSignatureKey);
  }

  private set lastConfigLogSignature(value: string | undefined) {
    this.states.set(llmRequesterLastConfigLogSignatureKey, value);
  }

  private get turnConfigs(): Map<number, TurnRequestConfig> {
    return this.states.get(llmRequesterTurnConfigsKey);
  }

  private get emittedThinkingEffortWarnings(): Set<string> {
    return this.states.get(llmRequesterEmittedThinkingEffortWarningsKey);
  }

  prepareTurnConfig(turnId: number): PreparedTurnRequestConfig | undefined {
    if (!this.profile.hasProvider()) return undefined;
    const config = this.getOrCreateTurnConfig(turnId);
    return { thinkingEffort: config.resolved.thinkingLevel };
  }

  currentCredentialProvider(): LlmCredentialProvider | undefined {
    if (!this.profile.hasProvider()) return undefined;
    return this.modelCatalog.get(this.profile.resolveModelContext().modelAlias).credentialProvider;
  }

  credentialProviderForTurn(turnId: number): LlmCredentialProvider | undefined {
    if (!this.profile.hasProvider()) return undefined;
    const resolved = this.turnConfigs.get(turnId)?.resolved ?? this.profile.resolveModelContext();
    return this.modelCatalog.get(resolved.modelAlias).credentialProvider;
  }

  lastTurnRequest(): AgentLLMTurnRequestSnapshot | undefined {
    return this.states.get(llmRequesterLastTurnRequestKey);
  }

  async request(
    overrides: AgentLLMRequestOverrides = {},
    onPart: AgentLLMRequestPartHandler = noopOnPart,
    signal?: AbortSignal,
  ): Promise<AgentLLMRequestFinish> {
    return this.start(overrides, onPart, signal).result;
  }

  start(
    overrides: AgentLLMRequestOverrides = {},
    onPart: AgentLLMRequestPartHandler = noopOnPart,
    signal?: AbortSignal,
  ): AgentLLMRequestTask {
    const trace = new MutableLLMRequestTrace();
    const promptCacheProbe =
      overrides.promptCacheProbe === undefined
        ? undefined
        : { source: overrides.promptCacheProbe, baseline: this.lastTurnRequest() };
    return {
      trace,
      result: this.requestWithTrace(trace, overrides, onPart, signal, promptCacheProbe),
    };
  }

  private async requestWithTrace(
    trace: MutableLLMRequestTrace,
    overrides: AgentLLMRequestOverrides,
    onPart: AgentLLMRequestPartHandler,
    signal: AbortSignal | undefined,
    promptCacheProbe: ResolvedLLMRequest['promptCacheProbe'],
  ): Promise<AgentLLMRequestFinish> {
    signal?.throwIfAborted();
    const startedAt = Date.now();
    const setTrace = (traceId: string | undefined): void => {
      trace.set(traceId);
      if (overrides.source?.type === 'turn') {
        this.telemetry.setContext({ trace_id: traceId });
      }
    };
    setTrace(undefined);
    const sizeProbe: { bytes?: number } = {};
    try {
      return await this.runRequest(
        await this.resolveRequest(overrides, promptCacheProbe, signal),
        onPart,
        signal,
        setTrace,
        sizeProbe,
        overrides.onAttemptRetry,
      );
    } catch (error) {
      this.logRequestFailure(error, overrides, signal, sizeProbe.bytes);
      setTrace(
        this.trackApiError(
          error,
          startedAt,
          signal,
          overrides.source,
          trace.traceId,
          sizeProbe.bytes,
        ),
      );
      throw error;
    }
  }

  private logRequestFailure(
    error: unknown,
    overrides: AgentLLMRequestOverrides,
    signal: AbortSignal | undefined,
    estimatedRequestBytes?: number,
  ): void {
    if (isAbortError(error) || signal?.aborted === true) return;
    const payload: LogContext = {
      ...logFieldsForSource(overrides.source),
      model: this.profile.data().modelAlias ?? 'unknown',
      ...retryErrorFields(error),
      ...(estimatedRequestBytes === undefined ? {} : { estimatedRequestBytes }),
    };
    this.log.warn('llm request failed', payload);
  }

  private trackApiError(
    error: unknown,
    startedAt: number,
    signal: AbortSignal | undefined,
    source?: AgentLLMRequestSource,
    requestTraceId?: string,
    estimatedRequestBytes?: number,
  ): string | undefined {
    if (isAbortError(error) || signal?.aborted === true) return requestTraceId;
    const modelAlias = this.profile.data().modelAlias;
    const model = this.tryGetModel();
    const traceId = requestTraceId ?? apiTraceId(error);
    const classification = classifyApiError(unwrapErrorCause(error));
    const properties: ApiErrorEvent = {
      error_type: classification.kind,
      model: model?.id ?? modelAlias ?? 'unknown',
      alias: modelAlias,
      provider_type: model?.providerType ?? model?.protocol,
      protocol: model?.protocol,
      retryable: isRetryableGenerateError(error),
      duration_ms: Math.max(0, Date.now() - startedAt),
      turn_id: source?.turnId,
      request_kind: requestKindForTelemetry(source),
      trace_id: traceId,
    };
    if (estimatedRequestBytes !== undefined) {
      properties['estimated_request_bytes'] = estimatedRequestBytes;
    }
    if (source?.type === 'turn') {
      if (source.step !== undefined) properties['step_no'] = source.step;
    }
    const statusCode = apiStatusCode(error);
    if (statusCode !== undefined) properties['status_code'] = statusCode;
    const currentTurn = this.usage.status(this.scopeContext.agentContext).currentTurn;
    if (currentTurn !== undefined) properties['input_tokens'] = inputTotal(currentTurn);
    this.telemetry.track2('api_error', properties);
    return traceId;
  }

  private tryGetModel(): Model | undefined {
    const modelAlias = this.profile.data().modelAlias;
    if (modelAlias === undefined) return undefined;
    try {
      return this.modelCatalog.get(modelAlias);
    } catch {
      return undefined;
    }
  }

  private async runRequest(
    request: ResolvedLLMRequest,
    onPart: AgentLLMRequestPartHandler,
    signal: AbortSignal | undefined,
    onRequestTrace: (traceId: string | undefined) => void,
    sizeProbe: { bytes?: number } | undefined,
    onAttemptRetry: (() => void) | undefined,
  ): Promise<AgentLLMRequestFinish> {
    this.toolCallIdNormalizer.seedFrom(this.context.get());
    const cacheProbeBaseline = request.promptCacheProbe?.baseline;
    let cacheProbeReported = false;
    const compacted =
      this.microCompaction !== undefined
        ? this.microCompaction.compact(request.messages)
        : request.messages;
    const shapedHistory = this.toolSelect.shapeHistory(compacted, undefined, request.tools);
    const hideReadMedia =
      !request.model.capabilities.image_in && !request.model.capabilities.video_in;
    const shaped = hideReadMedia ? hideReadMediaFile(shapedHistory) : shapedHistory;
    const tools = hideReadMedia
      ? request.tools.filter((tool) => tool.name !== READ_MEDIA_FILE_TOOL_NAME)
      : request.tools;
    const recoveredMedia = this.recoveredMedia(request);
    let policy: ProjectionPolicy | undefined =
      recoveredMedia === undefined ? undefined : { media: recoveredMedia };
    let mediaStrippedThisRequest = false;
    const captureMediaStripPolicy = (): { readonly strip: MediaStripSnapshot } => {
      mediaStrippedThisRequest = true;
      const media = { strip: this.projector.captureMediaStripSnapshot(shaped) };
      this.markMediaRecovery(request, media);
      return media;
    };
    const captureMediaDegradePolicy = (): { readonly degradeCount: number } => {
      const media = { degradeCount: this.projector.captureMediaDegradeCount(shaped) };
      this.markMediaRecovery(request, media);
      return media;
    };
    let previousMediaCount: number | undefined;
    let previousMediaPolicy: ProjectionPolicy['media'];
    let mediaPaths: ReadonlyMap<string, string> | undefined;
    const run = async (
      policy: ProjectionPolicy | undefined,
    ): Promise<AgentLLMRequestFinish | ProactiveMediaEscalation> => {
      onRequestTrace(undefined);
      const projection = projectionNameOf(policy);
      const fields =
        projection === undefined ? request.logFields : { ...request.logFields, projection };
      if (policy?.media !== undefined) {
        mediaPaths ??= await this.mediaResolver.displayPaths(shaped);
      }
      const projected = this.projector.project(shaped, policy, mediaPaths);
      const currentMediaCount = mediaPartCount(projected);
      const mediaPolicyChanged =
        previousMediaCount !== undefined && previousMediaPolicy !== policy?.media;
      const droppedMediaCount =
        previousMediaCount === undefined ? 0 : previousMediaCount - currentMediaCount;
      previousMediaCount = currentMediaCount;
      previousMediaPolicy = policy?.media;
      const input = {
        systemPrompt: request.systemPrompt,
        tools,
        messages: await this.mediaResolver.resolve(projected, request.requester, signal),
      };
      const estimatedBytes = estimateLlmRequestBytes(input.messages);
      if (sizeProbe !== undefined) sizeProbe.bytes = estimatedBytes;
      const escalation = this.proactiveMediaEviction(
        input.messages,
        estimatedBytes,
        policy,
        request,
        captureMediaStripPolicy,
      );
      if (escalation !== undefined) return { mediaEscalationPolicy: escalation };
      const mediaProjection =
        projection === 'media-degraded' || projection === 'strict-media-degraded'
          ? 'media-degraded'
          : projection === 'media-stripped' || projection === 'strict-media-stripped'
            ? 'media-stripped'
            : undefined;
      if (mediaPolicyChanged && droppedMediaCount > 0 && mediaProjection !== undefined) {
        try {
          void this.dispatcher.dispatch(
            new WarningIssued({
              agentId: this.scopeContext.agentId,
              code: mediaProjection,
              message:
                mediaProjection === 'media-degraded'
                  ? 'Provider rejected the request as too large; older media were dropped and the request was retried.'
                  : 'Provider rejected the media in the request; all media were omitted and the request was retried.',
            }),
          );
        } catch {
        }
      }
      this.warnAboutAnthropicThinkingEffort(request);
      const logInput: LLMRequestLogInput = {
        protocol: request.model.protocol,
        providerType: request.model.providerType,
        modelName: request.model.name,
        modelAlias: request.modelAlias,
        thinkingEffort: request.thinkingEffort,
        maxTokens: effectiveMaxCompletionTokens(request.params),
        systemPrompt: input.systemPrompt,
        tools: input.tools,
        messages: input.messages,
        fields,
      };
      this.logRequest(logInput);
      const recorded = this.recordRequest(logInput);
      const startedAt = Date.now();

      let message: Message | undefined;
      let usage: TokenUsage | undefined;
      let timing: ModelRequestTiming | undefined;
      let finish: Extract<ModelRequestEvent, { type: 'finish' }> | undefined;
      const toolCallIds = this.toolCallIdNormalizer.beginResponse();

      const setTraceId = (traceId: string | null | undefined): void => {
        const normalized = traceId ?? undefined;
        onRequestTrace(normalized);
      };

      try {
        for await (const event of request.requester.request(input, signal, {
          ...request.params,
          onTraceId: setTraceId,
        })) {
          switch (event.type) {
            case 'part':
              await onPart(this.normalizeStreamPart(toolCallIds, event.part));
              break;
            case 'usage':
              usage = event.usage;
              break;
            case 'finish':
              finish = event;
              message = event.message;
              setTraceId(event.traceId);
              break;
            case 'timing': {
              const { type: _type, ...streamTiming } = event;
              timing = streamTiming;
              break;
            }
          }
        }

        if (message === undefined || finish === undefined) {
          throw new Error2(
            ErrorCodes.PROVIDER_API_ERROR,
            'LLM request stream ended without a finish event.',
          );
        }

        const finalizedCalls = toolCallIds.remapFinalizedCalls(message.toolCalls);
        if (finalizedCalls !== message.toolCalls) {
          message = { ...message, toolCalls: finalizedCalls };
        }
        for (const { raw, assigned } of toolCallIds.remapped) {
          this.log.warn('Rewrote a duplicate provider tool call id into an agent-unique one.', {
            raw,
            assigned,
            model: request.modelAlias,
          });
        }
      } catch (error) {
        toolCallIds.rollback();
        throw error;
      }

      if (request.promptCacheProbe?.source === 'compaction' && !cacheProbeReported) {
        cacheProbeReported = true;
        const compared =
          cacheProbeBaseline !== undefined &&
          cacheProbeBaseline.modelAlias === request.modelAlias &&
          cacheProbeBaseline.contextRevision === request.contextRevision;
        const historyPrefixMatch = compared
          ? cacheProbeBaseline.messageCount <= input.messages.length &&
            fingerprint(
              JSON.stringify(input.messages.slice(0, cacheProbeBaseline.messageCount)),
            ) === cacheProbeBaseline.historyHash
          : undefined;
        this.telemetry.track2('prompt_cache_probe', {
          source: 'compaction',
          turn_id: request.source?.turnId,
          provider_type: request.model.providerType ?? request.model.protocol,
          protocol: request.model.protocol,
          input_tokens: inputTotal(usage ?? emptyUsage()),
          input_cache_read: usage?.inputCacheRead ?? 0,
          input_cache_creation: usage?.inputCacheCreation ?? 0,
          output_tokens: usage?.output ?? 0,
          model_match:
            cacheProbeBaseline === undefined
              ? undefined
              : cacheProbeBaseline.modelAlias === request.modelAlias,
          tools_match: compared ? recorded.toolsHash === cacheProbeBaseline.toolsHash : undefined,
          system_prompt_match: compared
            ? recorded.systemPromptHash === cacheProbeBaseline.systemPromptHash
            : undefined,
          history_prefix_match: historyPrefixMatch,
          parent_input_tokens: compared ? cacheProbeBaseline.inputTokens : undefined,
          parent_request_gap_ms: compared ? startedAt - cacheProbeBaseline.finishedAt : undefined,
        });
      }
      if (request.source?.type === 'turn') {
        const historyHash = fingerprint(JSON.stringify(input.messages));
        this.states.set(llmRequesterLastTurnRequestKey, {
          modelAlias: request.modelAlias,
          contextRevision: request.contextRevision,
          toolsHash: recorded.toolsHash,
          systemPromptHash: recorded.systemPromptHash,
          messageCount: input.messages.length,
          historyHash,
          inputTokens: usage === undefined ? undefined : inputTotal(usage),
          startedAt,
          finishedAt: Date.now(),
          observation: buildCacheObservation({
            modelAlias: request.modelAlias,
            protocol: request.model.protocol,
            providerType: request.model.providerType,
            messageCount: recorded.messageCount,
            historyHash,
            projection: recorded.projection,
            thinkingEffort: recorded.thinkingEffort,
            usage,
          }),
        });
      }
      void this.usage.record(
        this.scopeContext.agentContext,
        request.modelAlias,
        usage ?? emptyUsage(),
        request.source,
      );
      if (usage !== undefined) {
        this.tokenCounting.measured(this.scopeContext.agentContext, request.messages, [message], usage);
      }
      this.logResponse(request.logFields, usage ?? emptyUsage(), timing);

      return {
        message,
        usage: usage ?? emptyUsage(),
        model: request.modelAlias,
        providerFinishReason: finish.providerFinishReason,
        rawFinishReason: finish.rawFinishReason,
        providerMessageId: finish.id,
        timing,
        traceId: finish.traceId,
      };
    };

    let infiniteRetryAttempt = 0;
    for (;;) {
      try {
        const outcome = await run(policy);
        if (isProactiveMediaEscalation(outcome)) {
          policy = outcome.mediaEscalationPolicy;
          continue;
        }
        return outcome;
      } catch (error) {
        const media = policy?.media;
        const canStripMedia =
          !mediaStrippedThisRequest &&
          (media === undefined || 'degradeCount' in media || (previousMediaCount ?? 0) > 0);
        const canDegradeMedia =
          media === undefined ||
          ('degradeCount' in media && (previousMediaCount ?? 0) > MEDIA_DEGRADE_KEEP_RECENT);
        const nextPolicy = this.nextProjectionPolicyForError(
          error,
          policy,
          request,
          signal,
          canStripMedia,
          canDegradeMedia ? captureMediaDegradePolicy : undefined,
          captureMediaStripPolicy,
        );
        if (nextPolicy !== undefined) {
          onAttemptRetry?.();
          policy = nextPolicy;
          continue;
        }
        const raw = unwrapErrorCause(error);
        if (
          !this.infiniteRetryEnabled ||
          isAbortError(error) ||
          signal?.aborted === true ||
          raw instanceof APIContextOverflowError
        ) {
          throw error;
        }
        infiniteRetryAttempt += 1;
        const delayMs =
          readRetryAfterMs(raw) ??
          retryBackoffDelay(infiniteRetryAttempt - 1);
        this.log.warn('llm request failed; retrying indefinitely (KIMI_CODE_INFINITE_RETRY)', {
          model: request.model.name,
          ...request.logFields,
          attempt: infiniteRetryAttempt,
          delayMs,
          ...retryErrorFields(error),
        });
        onAttemptRetry?.();
        await sleepForRetry(delayMs, signal, this.hostTimers);
      }
    }
  }

  private get infiniteRetryEnabled(): boolean {
    return parseBooleanEnv(this.bootstrap.getEnv(KIMI_CODE_INFINITE_RETRY_ENV)) === true;
  }

  private nextProjectionPolicyForError(
    error: unknown,
    policy: ProjectionPolicy | undefined,
    request: ResolvedLLMRequest,
    signal: AbortSignal | undefined,
    canStripMedia: boolean,
    captureMediaDegradePolicy: (() => { readonly degradeCount: number }) | undefined,
    captureMediaStripPolicy: () => { readonly strip: MediaStripSnapshot },
  ): ProjectionPolicy | undefined {
    if (signal?.aborted === true) return undefined;
    const raw = unwrapErrorCause(error);
    let projection: LlmRequestProjectionFallbackEvent['projection'];
    let nextPolicy: ProjectionPolicy;
    if (raw instanceof APIRequestTooLargeError && canStripMedia) {
      signal?.throwIfAborted();
      if (captureMediaDegradePolicy !== undefined) {
        this.log.warn('provider rejected request as too large; resending with degraded media', {
          model: request.model.name,
          ...request.logFields,
        });
        projection = 'media-degraded';
        nextPolicy = { ...policy, media: captureMediaDegradePolicy() };
      } else {
        this.log.warn(
          'provider rejected request as too large; resending with rejected media stripped',
          {
            model: request.model.name,
            ...request.logFields,
          },
        );
        projection = 'media-stripped';
        nextPolicy = { ...policy, media: captureMediaStripPolicy() };
      }
    } else if (canStripMedia && isImageFormatError(raw)) {
      signal?.throwIfAborted();
      this.log.warn(
        'provider rejected an image in the request; resending with rejected media stripped',
        {
          model: request.model.name,
          ...request.logFields,
        },
      );
      projection = 'media-stripped';
      nextPolicy = { ...policy, media: captureMediaStripPolicy() };
    } else if (policy?.structure === undefined && isRecoverableRequestStructureError(raw)) {
      signal?.throwIfAborted();
      this.log.warn('provider rejected request structure; resending with strict projection', {
        model: request.model.name,
        ...request.logFields,
      });
      projection = 'strict';
      nextPolicy = { ...policy, structure: 'strict' };
    } else {
      return undefined;
    }
    const properties: LlmRequestProjectionFallbackEvent = {
      projection,
      error_type: classifyApiError(raw).kind,
      model: request.model.id,
      turn_id: request.source?.turnId,
    };
    this.telemetry.track2('llm_request_projection_fallback', properties);
    return nextPolicy;
  }

  private normalizeStreamPart(
    toolCallIds: ToolCallIdResponseNormalizer,
    part: StreamedMessagePart,
  ): StreamedMessagePart {
    if (!isToolCall(part)) return part;
    const assigned = toolCallIds.remapStreamedId(part.id, part._streamIndex);
    return assigned === part.id ? part : { ...part, id: assigned, rawId: part.rawId ?? part.id };
  }

  private proactiveMediaEviction(
    messages: readonly Message[],
    estimatedBytes: number,
    policy: ProjectionPolicy | undefined,
    request: ResolvedLLMRequest,
    captureMediaStripPolicy: () => { readonly strip: MediaStripSnapshot },
  ): ProjectionPolicy | undefined {
    const budgetBytes = resolveRequestByteBudget(this.config);
    if (estimatedBytes <= budgetBytes) return undefined;
    if (typeof policy?.media === 'object') return undefined;
    const eviction = this.projector.planMediaEviction(messages, estimatedBytes, budgetBytes);
    if (eviction === undefined) return undefined;
    this.logProactiveMediaEviction(
      request,
      budgetBytes,
      estimatedBytes,
      eviction.estimatedBytes,
      eviction.evictedMediaCount,
      eviction.projection,
    );
    if (eviction.projection === 'media-degraded') {
      const media = { degradeCount: eviction.degradeCount };
      this.markMediaRecovery(request, media);
      return { ...policy, media };
    }
    return { ...policy, media: captureMediaStripPolicy() };
  }

  private logProactiveMediaEviction(
    request: ResolvedLLMRequest,
    budgetBytes: number,
    beforeBytes: number,
    afterBytes: number,
    evictedMediaCount: number,
    projection: 'media-degraded' | 'media-stripped',
  ): void {
    this.log.warn('estimated request size exceeds the budget; evicting older media before send', {
      model: request.model.name,
      ...request.logFields,
      budgetBytes,
      estimatedBytesBefore: beforeBytes,
      estimatedBytesAfter: afterBytes,
      evictedMediaCount,
      projection,
    });
  }

  private warnAboutAnthropicThinkingEffort(request: ResolvedLLMRequest): void {
    if (request.model.protocol !== 'anthropic') return;
    const effort = request.thinkingEffort;
    if (effort === 'on' || effort === 'off') return;

    let code: string;
    let message: string;
    let knownEfforts: string | undefined;
    const supportEfforts = request.model.supportEfforts?.filter((value) => value.length > 0);
    if (supportEfforts === undefined || supportEfforts.length === 0) return;
    if (supportEfforts.includes(effort)) return;
    code = 'anthropic-thinking-effort-not-listed';
    knownEfforts = supportEfforts.join(',');
    message = `Thinking effort "${effort}" is not listed for model "${request.model.name}" (known: ${supportEfforts.join(', ')}). The configured value will be sent unchanged to the Anthropic-compatible backend.`;

    const key = [code, request.modelAlias, request.model.name, effort, knownEfforts].join('\u0000');
    if (this.emittedThinkingEffortWarnings.has(key)) return;
    this.emittedThinkingEffortWarnings.add(key);
    try {
      this.log.warn(message, {
        modelAlias: request.modelAlias,
        model: request.model.name,
        effort,
        knownEfforts,
      });
    } catch {
    }
    try {
      void this.dispatcher.dispatch(
        new WarningIssued({ agentId: this.scopeContext.agentId, code, message }),
      );
    } catch {
    }
  }

  private recoveredMedia(request: ResolvedLLMRequest): MediaRecovery['media'] | undefined {
    const recovery = this.states.get(llmRequesterMediaRecoveryKey);
    if (
      recovery === undefined ||
      recovery.modelAlias !== request.modelAlias ||
      recovery.contextRevision !== request.contextRevision
    ) {
      return undefined;
    }
    return recovery.media;
  }

  private markMediaRecovery(request: ResolvedLLMRequest, media: MediaRecovery['media']): void {
    if (request.source?.type !== 'turn') return;
    this.states.set(llmRequesterMediaRecoveryKey, {
      modelAlias: request.modelAlias,
      contextRevision: request.contextRevision,
      media,
    });
  }

  private async resolveRequest(
    overrides: AgentLLMRequestOverrides,
    promptCacheProbe: ResolvedLLMRequest['promptCacheProbe'],
    signal: AbortSignal | undefined,
  ): Promise<ResolvedLLMRequest> {
    await this.toolSelect.prepareForRequest(signal);
    const turnConfig = this.resolveTurnConfig(overrides.source);
    const resolved = turnConfig?.resolved ?? this.profile.resolveModelContext();
    const baseParams = turnConfig?.params ?? this.profile.resolveRequestParams();
    const requester = this.modelCatalog.getRequester(resolved.modelAlias);
    const maxCompletionTokensCap =
      this.config.get<ModelOverrides>(MODEL_OVERRIDES_SECTION)?.maxCompletionTokens;
    const usedContextTokens =
      overrides.usedContextTokens ??
      (overrides.messages === undefined
        ? this.tokenCounting.get(this.scopeContext.agentContext).size
        : undefined);
    const budgetParams = completionBudgetParams({
      budget: resolveCompletionBudget({
        maxOutputSize: overrides.maxOutputSize ?? resolved.maxOutputSize,
        maxCompletionTokensCap,
      }),
      capability: resolved.modelCapabilities,
      usedContextTokens,
    });
    const optedOut = maxCompletionTokensCap !== undefined && maxCompletionTokensCap <= 0;

    const messages = overrides.messages ?? this.context.get();
    return {
      requester,
      model: requester.model,
      params: {
        ...baseParams,
        ...budgetParams,
        ...(usedContextTokens === undefined ? {} : { usedContextTokens }),
        ...(optedOut ? { maxCompletionTokens: maxCompletionTokensCap } : {}),
      },
      modelAlias: resolved.modelAlias,
      thinkingEffort: resolved.thinkingLevel,
      systemPrompt: overrides.systemPrompt ?? turnConfig?.systemPrompt ?? this.profile.getSystemPrompt(),
      tools: [...(overrides.tools ?? this.defaultTools())],
      messages,
      contextRevision: this.context.prefixRevision(),
      promptCacheProbe,
      source: overrides.source,
      logFields: logFieldsForSource(overrides.source),
    };
  }

  private resolveTurnConfig(source: AgentLLMRequestSource | undefined): TurnRequestConfig | undefined {
    if (source?.type !== 'turn') return undefined;
    return this.getOrCreateTurnConfig(source.turnId);
  }

  private getOrCreateTurnConfig(turnId: number): TurnRequestConfig {
    for (const id of this.turnConfigs.keys()) {
      if (id < turnId) this.turnConfigs.delete(id);
    }
    let snapshot = this.turnConfigs.get(turnId);
    if (snapshot === undefined) {
      snapshot = {
        resolved: this.profile.resolveModelContext(),
        params: this.profile.resolveRequestParams(),
        systemPrompt: this.profile.getSystemPrompt(),
      };
      this.turnConfigs.set(turnId, snapshot);
    }
    return snapshot;
  }

  private logRequest(input: LLMRequestLogInput): void {
    const logFields: AgentLLMRequestLogFields = input.fields ?? {};
    const wireTools = providerVisibleTools(input.tools);
    const config = {
      provider: input.protocol,
      model: input.modelName,
      modelAlias: input.modelAlias,
      thinkingEffort: input.thinkingEffort ?? undefined,
      systemPromptChars: input.systemPrompt.length,
      toolCount: wireTools.length,
    };
    const signature = JSON.stringify({
      ...config,
      systemPromptHash: fingerprint(input.systemPrompt),
      toolsHash: fingerprint(JSON.stringify(toolSignature(wireTools))),
    });
    if (signature !== this.lastConfigLogSignature) {
      this.lastConfigLogSignature = signature;
      this.log.info('llm config', { ...logFields, ...config });
    }

    const partialMessageCount = input.messages.filter((message) => message.partial === true).length;
    const requestFields: LogContext = { ...logFields };
    if (partialMessageCount > 0) requestFields['partialMessageCount'] = partialMessageCount;
    this.log.info('llm request', requestFields);
  }

  private recordRequest(input: LLMRequestLogInput): LlmRequestPayload {
    const fields = input.fields ?? {};
    const wireTools = providerVisibleTools(input.tools);
    const tools = toolSignature(wireTools);
    const toolsHash = fingerprint(JSON.stringify(tools));
    if (!this.states.get(llmRequestTraceKey).seenToolsHashes.includes(toolsHash)) {
      void this.dispatcher.dispatch(
        new LlmToolsSnapshot({ agentId: this.scopeContext.agentId, hash: toolsHash, tools }),
      );
    }

    const systemPromptHash = fingerprint(input.systemPrompt);
    const overrides = this.config.get<ModelOverrides>(MODEL_OVERRIDES_SECTION);
    const thinkingConfig = this.config.get<ThinkingConfig>(THINKING_SECTION);
    const modelConfig =
      input.modelAlias === undefined ? undefined : this.modelService.get(input.modelAlias);
    const payload: LlmRequestPayload = {
      agentId: this.scopeContext.agentId,
      kind: requestKindForRecord(fields),
      provider: input.protocol,
      model: input.modelName,
      modelAlias: input.modelAlias,
      thinkingEffort: input.thinkingEffort ?? undefined,
      thinkingKeep: resolveThinkingKeep(
        overrides?.thinkingKeep,
        thinkingConfig?.keep,
        input.thinkingEffort ?? 'off',
      ),
      temperature: overrides?.temperature,
      topP: overrides?.topP,
      maxTokens: input.maxTokens,
      betaApi: modelConfig?.betaApi,
      toolSelect: this.toolSelect.enabled(),
      systemPromptHash,
      systemPrompt:
        input.systemPrompt === this.profile.data().systemPrompt
          ? undefined
          : input.systemPrompt,
      toolsHash,
      messageCount: input.messages.length,
      turnStep: stringField(fields, 'turnStep'),
      attempt: stringField(fields, 'attempt'),
      projection: projectionField(fields),
      droppedCount: numberField(fields, 'droppedCount'),
    };
    void this.dispatcher.dispatch(new LlmRequest(payload));
    return payload;
  }

  private logResponse(
    fields: AgentLLMRequestLogFields | undefined,
    usage: TokenUsage,
    timing: ModelRequestTiming | undefined,
  ): void {
    if (timing === undefined) return;
    const payload: LogContext = {
      ...fields,
      ttftMs: timing.firstTokenLatencyMs,
      streamDurationMs: timing.streamDurationMs,
      outputTokens: usage.output,
    };
    if (timing.requestBuildMs !== undefined) payload['requestBuildMs'] = timing.requestBuildMs;
    if (timing.serverFirstTokenMs !== undefined) {
      payload['serverFirstTokenMs'] = timing.serverFirstTokenMs;
    }
    if (timing.serverDecodeMs !== undefined) payload['serverDecodeMs'] = timing.serverDecodeMs;
    if (timing.clientConsumeMs !== undefined) payload['clientConsumeMs'] = timing.clientConsumeMs;
    if (timing.clientBlockedMs !== undefined) payload['clientBlockedMs'] = timing.clientBlockedMs;
    this.log.info('llm response', payload);
  }

  private defaultTools(): readonly Tool[] {
    return this.toolSelect.defaultTools();
  }
}

class MutableLLMRequestTrace implements LLMRequestTrace {
  traceId: string | undefined;

  set(traceId: string | undefined): void {
    this.traceId = traceId;
  }
}

function logFieldsForSource(source: AgentLLMRequestSource | undefined): AgentLLMRequestLogFields {
  switch (source?.type) {
    case 'turn':
      return {
        ...source.logFields,
        ...(source.step === undefined
          ? {}
          : { turnStep: `${String(source.turnId)}.${String(source.step)}` }),
      };
    case 'operation':
      return {
        ...source.logFields,
        ...(source.requestKind === undefined ? {} : { requestKind: source.requestKind }),
      };
    default:
      return {};
  }
}

function requestKindForTelemetry(source: AgentLLMRequestSource | undefined): string | undefined {
  if (source?.type === 'turn') return 'turn';
  if (source?.type === 'operation') return source.requestKind ?? 'operation';
  return undefined;
}

function mediaTagOf(message: Message): MediaPathTag | undefined {
  const text = message.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
  return matchMediaPathTags(text).find((entry) => entry.kind === 'image' || entry.kind === 'video');
}

function omittedReadMediaResult(tag: MediaPathTag): Message {
  const hint =
    `[${tag.kind} omitted: a ReadMediaFile tool result was hidden because the current model does not support ${tag.kind} input; ` +
    `use a model with ${tag.kind} input capability to view it]`;
  return {
    role: 'user',
    content: [{ type: 'text', text: `${hint}\n${buildMediaPathTag(tag.kind, tag.path)}` }],
    toolCalls: [],
  };
}

function hideReadMediaFile(messages: readonly Message[]): readonly Message[] {
  const readMediaCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (call.name === READ_MEDIA_FILE_TOOL_NAME) readMediaCallIds.add(call.id);
    }
  }
  if (readMediaCallIds.size === 0) return messages;
  const mediaTags = new Map<string, MediaPathTag>();
  for (const message of messages) {
    if (
      message.role !== 'tool' ||
      message.toolCallId === undefined ||
      !readMediaCallIds.has(message.toolCallId)
    ) {
      continue;
    }
    const tag = mediaTagOf(message);
    if (tag !== undefined) mediaTags.set(message.toolCallId, tag);
  }
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (message.toolCallId === undefined || !readMediaCallIds.has(message.toolCallId)) {
        out.push(message);
        continue;
      }
      const tag = mediaTags.get(message.toolCallId);
      if (tag !== undefined) out.push(omittedReadMediaResult(tag));
      continue;
    }
    if (message.role !== 'assistant') {
      out.push(message);
      continue;
    }
    const toolCalls = message.toolCalls.filter((call) => call.name !== READ_MEDIA_FILE_TOOL_NAME);
    if (toolCalls.length === message.toolCalls.length) {
      out.push(message);
      continue;
    }
    if (toolCalls.length > 0 || message.content.length > 0) out.push({ ...message, toolCalls });
  }
  return out;
}

function providerVisibleTools(tools: readonly Tool[]): readonly Tool[] {
  if (!tools.some((tool) => tool.deferred === true)) return tools;
  return tools.filter((tool) => tool.deferred !== true);
}

function toolSignature(tools: readonly Tool[]): readonly LlmRequestToolSchema[] {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function requestKindForRecord(fields: AgentLLMRequestLogFields): LlmRequestPayload['kind'] {
  if (fields['kind'] === 'compaction') return 'compaction';
  if (fields['requestKind'] === 'full_compaction') return 'compaction';
  return 'loop';
}

function stringField(fields: AgentLLMRequestLogFields, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(fields: AgentLLMRequestLogFields, key: string): number | undefined {
  const value = fields[key];
  return typeof value === 'number' ? value : undefined;
}

function mediaPartCount(messages: readonly Message[]): number {
  return messages.reduce(
    (count, message) =>
      count +
      message.content.filter(
        (part) =>
          part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url',
      ).length,
    0,
  );
}

type LlmRequestProjection = NonNullable<LlmRequestPayload['projection']>;

function projectionNameOf(policy: ProjectionPolicy | undefined): LlmRequestProjection | undefined {
  const media = policy?.media;
  if (policy?.structure === 'strict') {
    if (media === undefined) return 'strict';
    return 'degradeCount' in media ? 'strict-media-degraded' : 'strict-media-stripped';
  }
  if (media === undefined) return undefined;
  return 'degradeCount' in media ? 'media-degraded' : 'media-stripped';
}

function projectionField(fields: AgentLLMRequestLogFields): LlmRequestProjection | undefined {
  const value = fields['projection'];
  switch (value) {
    case 'strict':
    case 'media-degraded':
    case 'media-stripped':
    case 'strict-media-degraded':
    case 'strict-media-stripped':
      return value;
    default:
      return undefined;
  }
}

function fingerprint(content: string): string {
  return new Bun.CryptoHasher('sha256').update(content).digest('hex');
}

function apiStatusCode(error: unknown): number | undefined {
  const raw = unwrapErrorCause(error);
  if (raw instanceof APIStatusError) return raw.statusCode;
  if (typeof raw === 'object' && raw !== null) {
    const statusCode = (raw as Record<string, unknown>)['statusCode'];
    if (typeof statusCode === 'number') return statusCode;
    const status = (raw as Record<string, unknown>)['status'];
    if (typeof status === 'number') return status;
  }
  if (typeof error === 'object' && error !== null) {
    const details = (error as Record<string, unknown>)['details'];
    if (typeof details === 'object' && details !== null) {
      const statusCode = (details as Record<string, unknown>)['statusCode'];
      if (typeof statusCode === 'number') return statusCode;
    }
  }
  return undefined;
}

function apiTraceId(error: unknown): string | undefined {
  const raw = unwrapErrorCause(error);
  if (raw instanceof APIStatusError && raw.traceId !== null) return raw.traceId;
  if (typeof error === 'object' && error !== null) {
    const details = (error as Record<string, unknown>)['details'];
    if (typeof details === 'object' && details !== null) {
      const traceId = (details as Record<string, unknown>)['traceId'];
      if (typeof traceId === 'string') return traceId;
    }
  }
  return undefined;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLLMRequesterService,
  AgentLLMRequesterService,
  ScopeActivation.OnScopeCreated,
  'llmRequester',
);
