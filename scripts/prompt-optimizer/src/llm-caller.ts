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
  const lines = text.split('\n');

  let currentProvider: string | null = null;
  for (const line of lines) {
    const headerMatch = line.match(/^\[providers\."?([^"\]]+)"?\]/);
    if (headerMatch) {
      currentProvider = headerMatch[1]!;
      providers[currentProvider] = {};
      continue;
    }
    // Stop current provider on any new section header
    if (line.match(/^\[/) && !line.startsWith('[providers.')) {
      currentProvider = null;
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

  return { providers, defaultModel };
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

  throw new Error(
    `No model to run: pass --model, or set default_model in ${configPath}.`,
  );
}

/**
 * Resolve API credentials.
 *
 * The provider is the one the model id names, so the model and the base URL
 * always come from the same `[providers.*]` block. Explicit `RunnerConfig` and
 * environment values stay ahead of the file, and a model naming a provider the
 * file does not declare is an error rather than a silent fallback.
 */
export function resolveCredentials(config: RunnerConfig): {
  apiKey: string;
  baseUrl: string;
  model: string;
  type: string;
} {
  const configPath = getConfigPath();
  const { providers, defaultModel } = extractProvidersFromConfig(configPath);

  const model = config.model || defaultModel || '';
  if (model.length === 0) {
    throw new Error(
      `No model to run. Pass --model, or set default_model in ${configPath}.`,
    );
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

  return { apiKey, baseUrl, model, type };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{ function: { name: string; arguments: string } }>;
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
  tools?: ToolDefinition[],
): Promise<ModelResponse> => {
  const { apiKey, baseUrl, model, type } = resolveCredentials(config);

  if (!apiKey) {
    throw new Error(
      'No API key found. Checked: RunnerConfig, KIMI_API_KEY env, KIMI_MODEL_API_KEY env, ~/.kimi-code/config.toml.\n' +
        `Config path: ${getConfigPath()}`,
    );
  }

  if (type === 'anthropic') {
    return callAnthropic(systemPrompt, userMessages, apiKey, baseUrl, model, tools);
  }
  return callOpenAI(systemPrompt, userMessages, apiKey, baseUrl, model, tools);
};

async function callOpenAI(
  systemPrompt: string,
  userMessages: string[],
  apiKey: string,
  baseUrl: string,
  model: string,
  tools?: ToolDefinition[],
): Promise<ModelResponse> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...userMessages.map((m) => ({ role: 'user' as const, content: m })),
  ];
  const body: Record<string, unknown> = { model, messages, temperature: 0.1, max_tokens: 2048 };
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
    toolCalls: (choice.message.tool_calls ?? []).map((tc) => ({
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

async function callAnthropic(
  systemPrompt: string,
  userMessages: string[],
  apiKey: string,
  baseUrl: string,
  model: string,
  tools?: ToolDefinition[],
): Promise<ModelResponse> {
  const messages = userMessages.map((m) => ({ role: 'user' as const, content: m }));
  const body: Record<string, unknown> = {
    model,
    system: systemPrompt,
    messages,
    max_tokens: 2048,
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
    content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> | null;
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
  const toolCalls: { name: string; input: string }[] = [];
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
        currentToolName = event.content_block.name ?? '';
        currentToolInput = '';
      }
      // Tool use input delta
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        currentToolInput += event.delta.partial_json ?? '';
      }
      // Tool use end
      if (event.type === 'content_block_stop' && currentToolName) {
        toolCalls.push({ name: currentToolName, input: currentToolInput });
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
