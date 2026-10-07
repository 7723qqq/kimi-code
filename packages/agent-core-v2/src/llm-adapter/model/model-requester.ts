import type { FinishReason } from '#human/llm/finish-reason';
import type { ImageUploadInput, VideoUploadInput } from '#human/llm/media/upload';
import type { ResponseFormat } from '#human/llm/response-format';
import type { ThinkingEffort } from '#human/llm/thinking';
import type { TokenUsage } from '#human/llm/usage';

import type {
  Message,
  StreamedMessagePart,
  Tool,
  ImageURLPart,
  VideoURLPart,
} from '../contract/message';
import type { Model } from './catalog';

export interface SamplingOptions {
  readonly temperature?: number;
  readonly topP?: number;
}

export interface ModelRequestInput {
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly responseFormat?: ResponseFormat;
}

export interface ModelRequestTiming {
  readonly firstTokenLatencyMs: number;
  readonly streamDurationMs: number;
  readonly requestBuildMs?: number;
  readonly serverFirstTokenMs?: number;
  readonly serverDecodeMs?: number;
  readonly clientConsumeMs?: number;
  readonly clientBlockedMs?: number;
  /** Epoch ms of the first and last streamed parts carrying generated tokens —
   *  text, reasoning, tool-call argument deltas. Their difference is the
   *  interval the step's tokens were produced over, which is the denominator a
   *  decode rate needs; the absolute values locate those endpoints on the same
   *  clock as the frame timestamps that ship them, so a consumer in another
   *  process can use them too. Unlike the `*Ms` fields above they are instants,
   *  not durations, despite the `OffsetMs` suffix marking their derivation. */
  readonly llmFirstTokenOffsetMs?: number;
  readonly llmLastTokenOffsetMs?: number;
  /** Whether the two offsets above share the clock this process stamps its
   *  frames with. Set unconditionally where they are taken, since they are
   *  derived from the local epoch; a consumer may rely on it to sanity-check
   *  the pair against a frame timestamp, and must treat an absent claim as
   *  "difference only". */
  readonly llmWindowOnFrameClock?: boolean;
}

export type ModelRequestEvent =
  | { readonly type: 'part'; readonly part: StreamedMessagePart }
  | { readonly type: 'usage'; readonly usage: TokenUsage; readonly model?: string }
  | {
      readonly type: 'finish';
      readonly message: Message;
      readonly providerFinishReason?: FinishReason;
      readonly rawFinishReason?: string;
      readonly id?: string;
      readonly traceId?: string;
    }
  | ({ readonly type: 'timing' } & ModelRequestTiming);

export interface ModelRequestParams {
  readonly cacheKey?: string;
  readonly sampling?: SamplingOptions;
  readonly thinkingEffort?: ThinkingEffort;
  readonly thinkingKeep?: string;
  readonly maxCompletionTokens?: number;
  readonly usedContextTokens?: number;
  readonly maxContextTokens?: number;
  readonly onTraceId?: (traceId: string | null) => void;
}

export interface ModelRequester {
  readonly model: Model;

  request(
    input: ModelRequestInput,
    signal?: AbortSignal,
    params?: ModelRequestParams,
  ): AsyncIterable<ModelRequestEvent>;

  uploadVideo?(
    input: string | VideoUploadInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<VideoURLPart>;

  uploadImage?(
    input: ImageUploadInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ImageURLPart>;
}

export function effectiveMaxCompletionTokens(params?: ModelRequestParams): number | undefined {
  return params?.maxCompletionTokens;
}
