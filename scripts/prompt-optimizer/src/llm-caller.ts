/**
 * Prompt Optimizer — Real LLM API caller.
 *
 * Reads kimi-code's ~/.kimi-code/config.toml to get the API key and base URL,
 * then calls the OpenAI-compatible chat completion endpoint.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type { LLMCaller, ModelResponse, RunnerConfig, ToolDefinition } from './benchmark/runner';

/**
 * Resolve the kimi-code config.toml path.
 */
export function getConfigPath(): string {
  const envHome = process.env['KIMI_CODE_HOME'];
  const home = envHome ?? resolve(homedir(), '.kimi-code');
  return resolve(home, 'config.toml');
}

interface ProviderInfo {
  apiKey?: string;
  baseUrl?: string;
  type?: string;
}

export interface ParsedConfig {
  providers: Record<string, ProviderInfo>;
  defaultModel?: string;
  /** `[models."<alias>"]` → the wire model id its `model` field names. */
  models: Record<string, { model?: string; provider?: string }>;
}

/**
 * Extract provider configs from config.toml.
 * Returns a map of provider name → { apiKey, baseUrl, type }.
 */
export function parseConfigText(text: string): ParsedConfig {
  let defaultModel: string | undefined;
  const defaultModelMatch = text.match(/^default_model\s*=\s*"([^"]+)"/m);
  if (defaultModelMatch) defaultModel = defaultModelMatch[1];

  const providers: Record<string, ProviderInfo> = {};
  const models: Record<string, { model?: string; provider?: string }> = {};
  const lines = text.split('\n');

  let currentProvider: string | null = null;
  let currentModel: string | null = null;
  for (const line of lines) {
    const modelHeader = line.match(/^\[models\."?([^"\]]+)"?\]/);
    if (modelHeader) {
      currentModel = modelHeader[1]!;
      models[currentModel] = {};
      currentProvider = null;
      continue;
    }
    const headerMatch = line.match(/^\[providers\."?([^"\]]+)"?\]/);
    if (headerMatch) {
      currentProvider = headerMatch[1]!;
      providers[currentProvider] = {};
      currentModel = null;
      continue;
    }
    // Stop current section on any new header
    if (line.match(/^\[/) && !line.startsWith('[providers.') && !line.startsWith('[models.')) {
      currentProvider = null;
      currentModel = null;
      continue;
    }

    if (currentModel !== null && models[currentModel] !== undefined) {
      const kv = line.match(/^(\w+)\s*=\s*"([^"]*)"/);
      if (kv === null) continue;
      const [, key, value] = kv;
      if (key === 'model' && value) models[currentModel]!.model = value;
      if (key === 'provider' && value) models[currentModel]!.provider = value;
      continue;
    }

    if (!currentProvider || !providers[currentProvider]) continue;

    const kvMatch = line.match(/^(\w+)\s*=\s*"([^"]*)"/);
    if (!kvMatch) continue;
    const [, key, value] = kvMatch;
    if (key === 'api_key' && value) providers[currentProvider]!.apiKey = value;
    if (key === 'base_url' && value) providers[currentProvider]!.baseUrl = value;
    if (key === 'type' && value) providers[currentProvider]!.type = value;
  }

  return { providers, defaultModel, models };
}

/**
 * Parse a config file, memoised by path and mtime so a run pays for it once.
 */
const configCache = new Map<string, { mtimeMs: number; parsed: ParsedConfig }>();

export function extractProvidersFromConfig(configPath: string): ParsedConfig {
  if (!existsSync(configPath)) return { providers: {} };
  const mtimeMs = statSync(configPath).mtimeMs;
  const cached = configCache.get(configPath);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.parsed;

  const parsed = parseConfigText(readFileSync(configPath, 'utf-8'));
  configCache.set(configPath, { mtimeMs, parsed });
  return parsed;
}

/**
 * The provider a model id names, by the convention that model keys carry their
 * provider as a prefix: `workbuddy/deepseek-v4.1-flash` belongs to `workbuddy`.
 * Returns undefined for a bare id, which is the operator's to resolve.
 */
export function providerNameForModel(model: string): string | undefined {
  const slash = model.indexOf('/');
  if (slash <= 0) return undefined;
  return model.slice(0, slash);
}

/**
 * The model to run: the explicit one, else `default_model` from config.toml.
 * An empty model is an error, because it would otherwise reach the request body
 * and the report filename as an empty string.
 */
export function resolveModel(explicit?: string): string {
  if (explicit !== undefined && explicit.trim().length > 0) return explicit.trim();

  const configPath = getConfigPath();
  const { defaultModel } = extractProvidersFromConfig(configPath);
  if (defaultModel !== undefined && defaultModel.trim().length > 0) return defaultModel.trim();

  throw new Error(`No model to run: pass --model, or set default_model in ${configPath}.`);
}

/**
 * Resolve API credentials.
 *
 * The provider is the one the model id names, so the model and the base URL
 * always come from the same `[providers.*]` block. Explicit `RunnerConfig` and
 * environment values stay ahead of the file, and a model naming a provider the
 * file does not declare is an error rather than a silent fallback.
 *
 * `model` is the alias the report is labelled with; `wireModel` is what the
 * request body carries. They differ whenever `config.toml` declares
 * `[models."<alias>"]` with its own `model` field, which is the normal shape for
 * every configured provider: the endpoint rejects the alias (`unknown model
 * 'MiniMax Token Plan/MiniMax-M3.1-Flash'`), so sending it fails every call.
 */
export function resolveCredentials(config: RunnerConfig): {
  apiKey: string;
  baseUrl: string;
  model: string;
  wireModel: string;
  type: string;
} {
  const configPath = getConfigPath();
  const { providers, defaultModel, models } = extractProvidersFromConfig(configPath);

  const model = config.model || defaultModel || '';
  if (model.length === 0) {
    throw new Error(`No model to run. Pass --model, or set default_model in ${configPath}.`);
  }

  const providerName = providerNameForModel(model);
  let preferred: ProviderInfo | undefined;
  if (providerName !== undefined) {
    preferred = providers[providerName];
    if (preferred === undefined) {
      const known = Object.keys(providers).toSorted().join(', ') || '(none)';
      throw new Error(
        `No provider "${providerName}" in ${configPath} (model "${model}").\n` +
          `Known providers: ${known}`,
      );
    }
  }

  const apiKey =
    config.apiKey ||
    process.env['KIMI_API_KEY'] ||
    process.env['KIMI_MODEL_API_KEY'] ||
    preferred?.apiKey ||
    '';

  const baseUrl =
    config.apiBaseUrl ||
    process.env['KIMI_BASE_URL'] ||
    process.env['KIMI_MODEL_BASE_URL'] ||
    preferred?.baseUrl ||
    '';

  const type = preferred?.type ?? 'openai';
  // An alias with no `[models]` entry is its own wire id, which is what an
  // operator passing a bare endpoint model expects.
  const wireModel = models[model]?.model ?? model;

  return { apiKey, baseUrl, model, wireModel, type };
}

/**
 * One tool call as a provider returns it.
 *
 * `id` is required by both wire formats: OpenAI matches it with `tool_call_id`,
 * Anthropic with `tool_use_id`. `arguments` stays a string because that is what
 * both providers put on the wire.
 */
export interface WireToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * The conversation as the harness holds it, before a provider's shape is chosen.
 *
 * `tool` messages are the harness's neutral spelling of a tool result; the
 * Anthropic translation folds a run of them into one `user` message of
 * `tool_result` blocks, which is what that API requires.
 */
export type WireMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string;
      readonly toolCalls?: readonly WireToolCall[];
    }
  | { readonly role: 'tool'; readonly content: string; readonly toolCallId: string };

/**
 * A provider that accepts a request and never answers would hang a run
 * forever, so every call carries a deadline. Three minutes is far above any
 * observed response for these prompts and still bounded.
 */
export const REQUEST_TIMEOUT_MS = 180_000;

/** Output cap for a request that does not name one. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{ id?: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Real LLM caller — reads config from ~/.kimi-code/config.toml.
 * Supports both OpenAI (/chat/completions) and Anthropic (/v1/messages) formats.
 */
export const realCaller: LLMCaller = async (
  systemPrompt: string,
  userMessages: string[],
  config: RunnerConfig,
  tools?: readonly ToolDefinition[],
): Promise<ModelResponse> =>
  chatOnce(
    [
      { role: 'system', content: systemPrompt },
      ...userMessages.map((content) => ({ role: 'user' as const, content })),
    ],
    tools,
    config,
  );

/**
 * One request against the configured provider, in the harness's neutral message
 * shape.
 *
 * Single-turn callers and the measure tool loop share this, so the two cannot
 * drift into declaring different tools or rendering different messages.
 */
export async function chatOnce(
  messages: readonly WireMessage[],
  tools: readonly ToolDefinition[] | undefined,
  config: RunnerConfig,
): Promise<ModelResponse> {
  const { apiKey, baseUrl, wireModel, type } = resolveCredentials(config);

  if (!apiKey) {
    throw new Error(
      'No API key found. Checked: RunnerConfig, KIMI_API_KEY env, KIMI_MODEL_API_KEY env, ~/.kimi-code/config.toml.\n' +
        `Config path: ${getConfigPath()}`,
    );
  }

  if (type === 'anthropic') {
    return postAnthropic(messages, tools, apiKey, baseUrl, wireModel, config.maxTokens);
  }
  return postOpenAI(messages, tools, apiKey, baseUrl, wireModel, config.maxTokens);
}

async function postOpenAI(
  messages: readonly WireMessage[],
  tools: readonly ToolDefinition[] | undefined,
  apiKey: string,
  baseUrl: string,
  model: string,
  maxTokens: number | undefined,
): Promise<ModelResponse> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map(toOpenAIMessage),
    temperature: 0.1,
    max_tokens: maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters ?? { type: 'object', properties: {} },
      },
    }));
  }
  const start = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const latencyMs = Date.now() - start;
  if (!response.ok) {
    throw new Error(`API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const data = (await response.json()) as ChatCompletionResponse;
  const choice = data.choices[0];
  if (!choice) throw new Error('No choices in API response');
  return {
    content: choice.message.content ?? '',
    toolCalls: (choice.message.tool_calls ?? []).map((tc, index) => ({
      id: tc.id ?? `call_${String(index)}`,
      name: tc.function.name,
      input: tc.function.arguments,
    })),
    usage: {
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
      cacheRead: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    latencyMs,
  };
}

function toOpenAIMessage(message: WireMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === 'assistant') {
    const toolCalls = message.toolCalls ?? [];
    if (toolCalls.length === 0) return { role: 'assistant', content: message.content };
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Translate the neutral conversation into Anthropic's content-block shape.
 *
 * `system` is lifted out to the top-level field, and a run of `tool` messages
 * folds into one `user` message of `tool_result` blocks: that API has no
 * standalone tool role, and a `tool_result` block must sit in a user turn that
 * follows the assistant turn carrying the matching `tool_use`.
 */
function toAnthropicMessages(messages: readonly WireMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let toolResults: Array<Record<string, unknown>> = [];
  const flushToolResults = (): void => {
    if (toolResults.length === 0) return;
    out.push({ role: 'user', content: toolResults });
    toolResults = [];
  };

  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
      });
      continue;
    }
    flushToolResults();
    if (message.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: message.content }] });
      continue;
    }
    const blocks: Array<Record<string, unknown>> = [];
    if (message.content.length > 0) blocks.push({ type: 'text', text: message.content });
    for (const call of message.toolCalls ?? []) {
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: parseToolArguments(call.arguments),
      });
    }
    out.push({ role: 'assistant', content: blocks });
  }
  flushToolResults();
  return out;
}

async function postAnthropic(
  messages: readonly WireMessage[],
  tools: readonly ToolDefinition[] | undefined,
  apiKey: string,
  baseUrl: string,
  model: string,
  maxTokens: number | undefined,
): Promise<ModelResponse> {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const body: Record<string, unknown> = {
    model,
    system,
    messages: toAnthropicMessages(messages),
    max_tokens: maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    temperature: 0.1,
  };
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters ?? { type: 'object', properties: {} },
    }));
  }
  const start = Date.now();
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const latencyMs = Date.now() - start;
  if (!response.ok) {
    throw new Error(`Anthropic API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const contentType = response.headers.get('content-type') ?? '';

  // Handle SSE streaming response
  if (contentType.includes('text/event-stream')) {
    const text = await response.text();
    return parseAnthropicSSE(text, latencyMs);
  }

  // Handle normal JSON response
  const data = (await response.json()) as {
    content?: Array<{ type: string; id?: string; text?: string; name?: string; input?: unknown }> | null;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    stop_reason?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  };

  // Some providers answer 200 with a null or missing `content` — MiniMax M3.1
  // does this intermittently (observed ~6% of calls, `stop_reason: "end_turn"`
  // and a non-zero output token count, so the text was generated and dropped).
  // Treating that as an empty answer would silently score a provider fault as a
  // bad model response, so it is reported with enough detail to tell the two
  // apart.
  if (!Array.isArray(data.content)) {
    const reported = data.content === null ? 'null' : typeof data.content;
    throw new Error(
      `Anthropic response carried no usable content (content is ${reported}; ` +
        `stop_reason=${data.stop_reason ?? 'unknown'}, ` +
        `output_tokens=${data.usage?.output_tokens ?? 0}` +
        (data.base_resp?.status_msg ? `, provider said "${data.base_resp.status_msg}"` : '') +
        `). This is a provider-side fault, not an empty model answer.`,
    );
  }

  const content = data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');

  // `tool_use` blocks are the model calling a tool, which this tool measures:
  // dropping them made every `tool-called` assertion judge an always-empty list.
  // The streaming path already reads them; this keeps the two consistent.
  const toolCalls = data.content
    .filter((b) => b.type === 'tool_use' && typeof b.name === 'string')
    .map((b) => ({
      id: b.id ?? '',
      name: b.name as string,
      input: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}),
    }));

  const outputTokens = data.usage?.output_tokens ?? 0;
  // No text and no tool call, yet tokens were billed: the generated payload was
  // dropped in transit. Same class of fault as `content: null`, so it gets the
  // same treatment rather than being scored as a model that answered nothing.
  if (content.length === 0 && toolCalls.length === 0 && outputTokens > 0) {
    throw new Error(
      `Anthropic response carried no text and no tool call though ${outputTokens} output ` +
        `tokens were billed (blocks: ${data.content.length}, ` +
        `stop_reason=${data.stop_reason ?? 'unknown'}). ` +
        `This is a provider-side fault, not an empty model answer.`,
    );
  }
  return {
    content,
    toolCalls,
    usage: {
      input: data.usage?.input_tokens ?? 0,
      output: outputTokens,
      cacheRead: data.usage?.cache_read_input_tokens ?? 0,
    },
    latencyMs,
  };
}

/**
 * Parse Anthropic SSE stream and extract text content + tool_use blocks.
 */
function parseAnthropicSSE(raw: string, latencyMs: number): ModelResponse {
  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  const toolCalls: { id: string; name: string; input: string }[] = [];
  let currentToolId = '';
  let currentToolName = '';
  let currentToolInput = '';

  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const json = line.slice(6).trim();
    if (json === '[DONE]') break;
    try {
      const event = JSON.parse(json);
      // Text content
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        content += event.delta.text ?? '';
      }
      // Tool use start
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        currentToolId = event.content_block.id ?? '';
        currentToolName = event.content_block.name ?? '';
        currentToolInput = '';
      }
      // Tool use input delta
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        currentToolInput += event.delta.partial_json ?? '';
      }
      // Tool use end
      if (event.type === 'content_block_stop' && currentToolName) {
        toolCalls.push({ id: currentToolId, name: currentToolName, input: currentToolInput });
        currentToolId = '';
        currentToolName = '';
        currentToolInput = '';
      }
      // Usage
      if (event.type === 'message_delta' && event.usage) {
        outputTokens = event.usage.output_tokens ?? outputTokens;
      }
      if (event.type === 'message_start' && event.message?.usage) {
        inputTokens = event.message.usage.input_tokens ?? 0;
        cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0;
      }
    } catch {
      /* skip non-JSON lines */
    }
  }

  return {
    content,
    toolCalls,
    usage: { input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens },
    latencyMs,
  };
}
