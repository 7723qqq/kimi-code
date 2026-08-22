import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { ModelCapability } from '#/kosong/contract/capability';
import { APIConnectionError, ChatProviderError } from '#/kosong/contract/errors';
import type { Message, StreamedMessagePart, ThinkPart } from '#/kosong/contract/message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  StreamedMessage,
  ThinkingEffort,
} from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import type { TokenUsage } from '#/kosong/contract/usage';

export interface AntigravityOptions {
  model: string;
  binaryPath?: string;
  thinkingEffort?: ThinkingEffort;
}

export function detectAntigravityBinary(): string | undefined {
  const candidates = [
    `${process.env['HOME']}/.local/bin/agy`,
    '/usr/local/bin/agy',
    '/usr/bin/agy',
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const ANTIGRAVITY_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'COMSPEC',
];

const ANTIGRAVITY_AUTH_ENV_ALLOWLIST = [
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
];

export function buildAntigravityEnv(): NodeJS.ProcessEnv {
  const allowed = new Set([...ANTIGRAVITY_ENV_ALLOWLIST, ...ANTIGRAVITY_AUTH_ENV_ALLOWLIST]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key)) {
      env[key] = value;
    }
  }
  return env;
}

export function mapModelToAntigravity(model: string, effort?: ThinkingEffort): string {
  const normalized = model.toLowerCase().replaceAll(/[_\s.]+/g, '-');
  const effortSuffix = effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high';

  if (normalized.includes('3-7') || normalized.includes('37')) {
    return `gemini-3.7-flash-${effortSuffix}`;
  }
  if (normalized.includes('3-1') || normalized.includes('31')) {
    return effort === 'low' ? 'gemini-3.1-pro-low' : 'gemini-3.1-pro-high';
  }
  if (normalized.includes('3-6') || normalized.includes('36')) {
    return `gemini-3.6-flash-${effortSuffix}`;
  }
  if (normalized.includes('3-5') || normalized.includes('35')) {
    return `gemini-3.5-flash-${effortSuffix}`;
  }
  if (
    normalized.includes('2-5-pro') ||
    normalized.includes('2-0-pro') ||
    normalized.includes('1-5-pro')
  ) {
    return 'gemini-3.1-pro-high';
  }
  if (
    normalized.includes('2-5-flash') ||
    normalized.includes('2-0-flash') ||
    normalized.includes('1-5-flash')
  ) {
    return 'gemini-3.7-flash-high';
  }
  if (normalized.includes('sonnet')) {
    return 'claude-sonnet-4-6';
  }
  if (normalized.includes('opus')) {
    return 'claude-opus-4-6-thinking';
  }
  if (
    normalized.includes('gpt-oss') ||
    normalized.includes('gptoss') ||
    normalized.includes('120b')
  ) {
    return 'gpt-oss-120b-medium';
  }
  return model;
}

export class AntigravityStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = 'completed';
  private _rawFinishReason: string | null = 'STOP';
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(generator: AsyncGenerator<StreamedMessagePart>) {
    this._iter = generator;
  }

  get id(): string | null {
    return this._id;
  }

  get usage(): TokenUsage | null {
    return this._usage;
  }

  get finishReason(): FinishReason | null {
    return this._finishReason;
  }

  get rawFinishReason(): string | null {
    return this._rawFinishReason;
  }

  setUsage(usage: TokenUsage): void {
    this._usage = usage;
  }

  setId(id: string): void {
    this._id = id;
  }

  setFinishReason(reason: FinishReason, raw?: string): void {
    this._finishReason = reason;
    this._rawFinishReason = raw ?? null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    yield* this._iter;
  }
}

export interface AntigravityPromptPlan {
  /** Flat text to hand to the `agy` CLI via `-p`. */
  readonly promptText: string;
  /** Existing agy conversation to append to, when the thread is still trusted. */
  readonly useConversationId: string | undefined;
}

/**
 * Thread decision for the agy bridge: history lives in the external agy
 * conversation store, so a known thread appends only the newest message,
 * while an unknown thread rebuilds the full transcript inline. Think parts
 * never reach the wire text; a fully empty prompt degrades to `'hi'`.
 */
export function buildAntigravityPrompt(
  history: Message[],
  lastConversationId: string | undefined,
): AntigravityPromptPlan {
  const extractText = (msg: Message): string => {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .map((part) => {
          if (!part || typeof part !== 'object') return '';
          if (part.type === 'text' && typeof part.text === 'string') return part.text;
          if (part.type === 'think' && typeof part.think === 'string') return '';
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return '';
  };

  let promptText = '';
  let useConversationId: string | undefined;

  if (lastConversationId && history.length > 1) {
    const lastMsg = history.at(-1);
    promptText = lastMsg ? extractText(lastMsg) : '';
    useConversationId = lastConversationId;
  } else if (history.length <= 1) {
    const lastMsg = history.at(-1);
    promptText = lastMsg ? extractText(lastMsg) : '';
  } else {
    const parts: string[] = [];
    for (const msg of history) {
      const text = extractText(msg);
      if (!text.trim()) continue;
      if (msg.role === 'user') {
        parts.push(`[User]:\n${text}`);
      } else if (msg.role === 'assistant') {
        parts.push(`[Assistant]:\n${text}`);
      } else if (msg.role === 'tool') {
        parts.push(`[Tool Result]:\n${text}`);
      }
    }
    promptText = parts.join('\n\n');
  }

  if (promptText.trim().length === 0) {
    promptText = 'hi';
  }

  return { promptText, useConversationId };
}

export class AntigravityChatProvider implements ChatProvider {
  readonly name = 'AntigravityChatProvider';
  readonly modelName: string;
  readonly thinkingEffort: ThinkingEffort | null;
  private readonly binaryPath: string;
  private _lastConversationId?: string;

  constructor(options: AntigravityOptions) {
    this.modelName = options.model;
    this.thinkingEffort = options.thinkingEffort ?? 'high';
    const detected = detectAntigravityBinary();
    this.binaryPath = options.binaryPath ?? detected ?? 'agy';
  }

  async generate(
    _systemPrompt: string,
    _tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    const agyModel = mapModelToAntigravity(this.modelName, this.thinkingEffort ?? undefined);
    const { promptText, useConversationId } = buildAntigravityPrompt(
      history,
      this._lastConversationId,
    );

    const args = [
      ...(useConversationId ? ['--conversation', useConversationId] : []),
      '-p',
      promptText,
      '--model',
      agyModel,
      '--disable-slash-commands',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
    ];

    options?.onRequestSent?.();

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(this.binaryPath, args, {
        cwd: tmpdir(),
        env: buildAntigravityEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new APIConnectionError(
        `Failed to spawn Antigravity client (${this.binaryPath}): ${String(error)}`,
      );
    }

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try {
        child.kill('SIGTERM');
      } catch {}
    };

    if (options?.signal) {
      if (options.signal.aborted) {
        onAbort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const queue: StreamedMessagePart[] = [];
    let resolveNext: (() => void) | null = null;
    let isDone = false;
    let errorOccurred: Error | null = null;
    let finalResponseText = '';
    let conversationId: string | undefined;
    let transcriptOffset = 0;
    let lastSeenThinkingLength = 0;

    type TranscriptToolCall = { name: string; args: Record<string, unknown> };
    const pendingToolCalls: TranscriptToolCall[] = [];
    let awaitingToolResult = false;

    const formatToolArgs = (args: Record<string, unknown>): string => {
      const entries = Object.entries(args).filter(
        ([k]) => !['toolAction', 'toolSummary'].includes(k),
      );
      if (entries.length === 0) return '';
      const parts = entries.slice(0, 3).map(([k, v]) => {
        const val = typeof v === 'string' ? v.slice(0, 120) : JSON.stringify(v).slice(0, 120);
        return `${k}: ${val}`;
      });
      return parts.join(', ');
    };

    const syncTranscript = () => {
      if (!conversationId) return;
      const transcriptPath = join(
        homedir(),
        '.gemini/antigravity-cli/brain',
        conversationId,
        '.system_generated/logs/transcript.jsonl',
      );
      if (!existsSync(transcriptPath)) return;
      try {
        const fileContent = readFileSync(transcriptPath, 'utf-8');
        const lines = fileContent.split('\n');
        for (let i = transcriptOffset; i < lines.length; i++) {
          const line = lines[i]?.trim();
          if (!line) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'PLANNER_RESPONSE') {
              if (
                typeof entry.thinking === 'string' &&
                entry.thinking.length > lastSeenThinkingLength
              ) {
                const newThinking = entry.thinking.slice(lastSeenThinkingLength);
                lastSeenThinkingLength = entry.thinking.length;
                queue.push({ type: 'think', think: newThinking });
                resolveNext?.();
              }
              if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
                for (const tc of entry.tool_calls as TranscriptToolCall[]) {
                  if (tc && typeof tc.name === 'string') {
                    pendingToolCalls.push(tc);
                    const argsStr = formatToolArgs(
                      (tc.args as Record<string, unknown> | undefined) ?? {},
                    );
                    const thinkLine = `\n🔧 ${tc.name}(${argsStr})`;
                    queue.push({ type: 'think', think: thinkLine });
                    resolveNext?.();
                    awaitingToolResult = true;
                  }
                }
              }
              if (
                typeof entry.content === 'string' &&
                entry.content.length > 0 &&
                finalResponseText.length === 0
              ) {
                finalResponseText = entry.content;
              }
            } else if (entry.type === 'GENERIC' && awaitingToolResult) {
              awaitingToolResult = false;
              if (typeof entry.content === 'string') {
                const firstLine =
                  (entry.content as string).split('\n').find((l: string) => l.trim().length > 0) ??
                  '';
                const snippet = firstLine.slice(0, 160);
                if (snippet) {
                  queue.push({ type: 'think', think: `\n   ↳ ${snippet}` });
                  resolveNext?.();
                }
              }
            }
          } catch {}
        }
        transcriptOffset = Math.max(transcriptOffset, lines.length > 1 ? lines.length - 1 : 0);
      } catch {}
    };

    const transcriptPoller = setInterval(syncTranscript, 100);

    let streamed: AntigravityStreamedMessage;

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      try {
        const payload = JSON.parse(trimmed);
        if (payload.event === 'init' && typeof payload.conversation_id === 'string') {
          conversationId = payload.conversation_id;
          this._lastConversationId = payload.conversation_id;
          streamed?.setId(payload.conversation_id);
          syncTranscript();
        } else if (payload.event === 'step_update') {
          syncTranscript();
          const update = payload.step_update;
          if (typeof update?.text_delta === 'string' && update.text_delta.length > 0) {
            queue.push({ type: 'text', text: update.text_delta });
            resolveNext?.();
          }
          if (typeof update?.thinking_delta === 'string' && update.thinking_delta.length > 0) {
            const thinkPart: ThinkPart = { type: 'think', think: update.thinking_delta };
            queue.push(thinkPart);
            resolveNext?.();
          }
          if (update?.usage) {
            streamed?.setUsage({
              inputOther: update.usage.input_tokens ?? 0,
              output: update.usage.output_tokens ?? 0,
              inputCacheRead: update.usage.cache_read_tokens ?? 0,
              inputCacheCreation: 0,
            });
          }
        } else if (payload.event === 'result') {
          syncTranscript();
          if (typeof payload.result?.response === 'string' && payload.result.response.length > 0) {
            finalResponseText = payload.result.response;
          }
          if (payload.result?.usage) {
            streamed?.setUsage({
              inputOther: payload.result.usage.input_tokens ?? 0,
              output: payload.result.usage.output_tokens ?? 0,
              inputCacheRead: payload.result.usage.cache_read_tokens ?? 0,
              inputCacheCreation: 0,
            });
          }
        }
      } catch {}
    });

    let stderrOutput = '';
    child.stderr?.on('data', (d) => {
      stderrOutput += d.toString();
    });

    child.on('error', (err) => {
      clearInterval(transcriptPoller);
      errorOccurred = new ChatProviderError(`Antigravity error: ${err.message}`);
      resolveNext?.();
    });

    child.on('exit', (code) => {
      clearInterval(transcriptPoller);
      syncTranscript();
      if (options?.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
      if (code !== 0 && !aborted && queue.length === 0 && finalResponseText.length === 0) {
        errorOccurred = new ChatProviderError(
          `Antigravity exited with code ${code}: ${stderrOutput}`,
        );
      }
      isDone = true;
      resolveNext?.();
    });

    async function* makeGenerator(): AsyncGenerator<StreamedMessagePart> {
      let yieldedAnyText = false;
      while (true) {
        if (options?.signal?.aborted || aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        if (queue.length > 0) {
          const item = queue.shift()!;
          if (item.type === 'text' && item.text.trim().length > 0) {
            yieldedAnyText = true;
          }
          yield item;
          continue;
        }
        if (errorOccurred) {
          throw errorOccurred;
        }
        if (isDone) {
          if (!yieldedAnyText && finalResponseText.length > 0) {
            yieldedAnyText = true;
            yield { type: 'text', text: finalResponseText };
          }
          if (!yieldedAnyText) {
            yield { type: 'text', text: finalResponseText || ' ' };
          }
          break;
        }
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    }

    streamed = new AntigravityStreamedMessage(makeGenerator());
    return streamed;
  }
}

export function getAntigravityModelCapability(): ModelCapability {
  return {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: true,
    tool_use: false,
    max_context_tokens: 1_000_000,
  };
}
