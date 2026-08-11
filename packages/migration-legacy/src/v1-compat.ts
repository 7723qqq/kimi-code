/**
 * Local copies of v1 agent-core schemas, functions, and constants that
 * migration-legacy still needs for reading / validating legacy data.
 *
 * These are STABLE copies — they match the v1 agent-core surface at the P3a
 * extraction point (wire protocol 1.4) and are NOT automatically kept in sync.
 * When agent-core's config schema grows a new field, this file does not
 * automatically see it (and the migration code does not need to).
 */

import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { basename, resolve } from 'pathe';
import { z } from 'zod';

// ---- Schema sections (minimum surface for migration) ----

const ProviderTypeSchema = z.enum([
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
  'astron',
]);

const StringRecordSchema = z.record(z.string(), z.string());

const OAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
});

export const ProviderConfigSchema = z.object({
  type: ProviderTypeSchema,
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  defaultModel: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  env: StringRecordSchema.optional(),
  customHeaders: StringRecordSchema.optional(),
  source: z.record(z.string(), z.unknown()).optional(),
  // Astron (xunfei Coding Plan) runtime knobs, edited via the TUI Astron
  // settings panel and forwarded to the OpenAI-legacy transport. Ignored by
  // other provider types.
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().int().min(1).optional(),
  searchDisable: z.boolean().optional(),
});

const ModelAliasBaseSchema = z.object({
  provider: z.string(),
  model: z.string(),
  maxContextSize: z.number().int().min(1),
  // Declared prompt/input cap when below the total window (e.g. gpt-5: 400k
  // window, 272k input). Compaction and other prompt-budget checks prefer it
  // over max_context_size; completion budgeting keeps the total window.
  maxInputSize: z.number().int().min(1).optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  protocol: z.literal('anthropic').optional(),
  adaptiveThinking: z.boolean().optional(),
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
  // The effort value that encodes "thinking off" on the wire for this model
  // (models.dev declares it as the "none" entry, e.g. xai grok). When set,
  // turning thinking off sends this value instead of omitting the effort
  // field — required by models whose default is to reason.
  offEffort: z.string().optional(),
  betaApi: z.boolean().optional(),
  // Per-model endpoint override, paired with `protocol`. Catalog imports set
  // it when a gateway provider serves this model over a different endpoint
  // than the provider default.
  baseUrl: z.string().optional(),
});

export const ModelAliasSchema = ModelAliasBaseSchema.extend({
  overrides: ModelAliasBaseSchema.omit({
    provider: true,
    model: true,
    protocol: true,
    betaApi: true,
    baseUrl: true,
  })
    .partial()
    .optional(),
});

const HOOK_EVENT_TYPES = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionResult',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'Interrupt',
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Notification',
] as const;

export const HookDefSchema = z
  .object({
    event: z.enum(HOOK_EVENT_TYPES),
    matcher: z.string().optional(),
    command: z.string().min(1),
    timeout: z.number().int().min(1).max(600).optional(),
  })
  .strict();

const MAX_MCP_TIMEOUT_MS = 2_147_483_647;
const McpTimeoutMsSchema = z.number().int().min(1).max(MAX_MCP_TIMEOUT_MS);

const McpServerCommonFields = {
  enabled: z.boolean().optional(),
  startupTimeoutMs: McpTimeoutMsSchema.optional(),
  toolTimeoutMs: McpTimeoutMsSchema.optional(),
  enabledTools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
} as const;

const McpServerStdioConfigSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: StringRecordSchema.optional(),
  cwd: z.string().optional(),
  executor: z.enum(['local', 'kaos']).optional(),
  ...McpServerCommonFields,
});

const McpServerHttpConfigSchema = z.object({
  transport: z.literal('http'),
  url: z.string().url(),
  headers: StringRecordSchema.optional(),
  auth: z.literal('oauth').optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  env: StringRecordSchema.optional(),
  ...McpServerCommonFields,
});

const McpServerSseConfigSchema = z.object({
  transport: z.literal('sse'),
  url: z.string().url(),
  headers: StringRecordSchema.optional(),
  auth: z.literal('oauth').optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  env: StringRecordSchema.optional(),
  ...McpServerCommonFields,
});

const McpServerConfigDiscriminatedSchema = z.discriminatedUnion('transport', [
  McpServerStdioConfigSchema,
  McpServerHttpConfigSchema,
  McpServerSseConfigSchema,
]);

export const McpServerConfigSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if ('transport' in obj) return obj;
  if (typeof obj['command'] === 'string' && typeof obj['url'] === 'string') return obj;
  if (typeof obj['command'] === 'string') return { ...obj, transport: 'stdio' };
  if (typeof obj['url'] === 'string') return { ...obj, transport: 'http' };
  return obj;
}, McpServerConfigDiscriminatedSchema);

const ThinkingConfigSchema = z.object({
  enabled: z.boolean().optional(),
  effort: z.string().optional(),
  keep: z.string().optional(),
});

const PermissionModeSchema = z.enum(['yolo', 'manual', 'auto']);

const PermissionRuleDecisionSchema = z.enum(['allow', 'deny', 'ask']);
const PermissionRuleScopeSchema = z.enum([
  'turn-override',
  'session-runtime',
  'project',
  'user',
]);

/**
 * Local TS-only copy of v1's permission-pattern DSL parser (the v1
 * implementation delegates to the Rust native module when present; the TS
 * fallback is equivalent for validation purposes and avoids the dependency).
 * Grammar: `toolName` or `toolName(argPattern)`.
 */
function parsePattern(pattern: string): { toolName: string; argPattern?: string } {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    throw new Error('permission pattern: empty string');
  }

  const openIdx = trimmed.indexOf('(');
  if (openIdx === -1) {
    return { toolName: trimmed };
  }

  if (!trimmed.endsWith(')')) {
    throw new Error(`permission pattern: missing closing paren in "${pattern}"`);
  }

  const toolName = trimmed.slice(0, openIdx);
  const argPattern = trimmed.slice(openIdx + 1, -1);
  if (toolName.length === 0) {
    throw new Error(`permission pattern: empty tool name in "${pattern}"`);
  }
  if (argPattern.length === 0) {
    return { toolName };
  }
  return { toolName, argPattern };
}

function isValidPermissionPattern(pattern: string): boolean {
  try {
    parsePattern(pattern);
    return true;
  } catch {
    return false;
  }
}

const PermissionRuleSchema = z.object({
  decision: PermissionRuleDecisionSchema,
  scope: PermissionRuleScopeSchema.default('user'),
  pattern: z.string().min(1).refine(isValidPermissionPattern, {
    message: 'Invalid permission rule pattern',
  }),
  reason: z.string().optional(),
});

const PermissionConfigSchema = z.object({
  rules: z.array(PermissionRuleSchema).optional(),
});

const LoopControlSchema = z.object({
  maxStepsPerTurn: z.number().int().min(0).optional(),
  maxRetriesPerStep: z.number().int().min(0).optional(),
  maxRalphIterations: z.number().int().min(-1).optional(),
  reservedContextSize: z.number().int().min(0).optional(),
  compactionTriggerRatio: z.number().min(0.5).max(0.99).optional(),
});

const BackgroundConfigSchema = z.object({
  maxRunningTasks: z.number().int().min(1).optional(),
  keepAliveOnExit: z.boolean().optional(),
  bashAutoBackgroundOnTimeout: z.boolean().optional(),
  bashTaskTimeoutS: z.number().int().min(0).optional(),
  killGracePeriodMs: z.number().int().min(0).optional(),
  printWaitCeilingS: z.number().int().min(1).optional(),
  printBackgroundMode: z.enum(['exit', 'drain', 'steer']).optional(),
  printMaxTurns: z.number().int().min(1).optional(),
});

const SubagentConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
});

const ImageConfigSchema = z.object({
  maxEdgePx: z.number().int().min(1).optional(),
  readByteBudget: z.number().int().min(1).optional(),
});

const ModelCatalogConfigSchema = z.object({
  refreshIntervalMs: z.number().int().min(0).optional(),
  refreshOnStart: z.boolean().optional(),
});

const ExperimentalConfigSchema = z.record(
  z.string(),
  z.union([z.boolean(), z.string()]),
);

const MoonshotServiceConfigSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  customHeaders: StringRecordSchema.optional(),
});

const ServicesConfigSchema = z.object({
  moonshotSearch: MoonshotServiceConfigSchema.optional(),
  moonshotFetch: MoonshotServiceConfigSchema.optional(),
});

const AgentConfigSchema = z.object({
  /**
   * Which agent engine to use.
   * - `"js"` (default): the existing TypeScript agent engine
   * - `"rust"`: the Rust agent engine (kimi-agent binary via stdio JSON-RPC)
   */
  engine: z.enum(['js', 'rust']).default('js'),
  /**
   * MultiLLM: list of provider names to use for concurrent execution.
   * When set and `engine === "rust"`, the Rust engine sends the same prompt
   * to all listed providers concurrently and returns the first response
   * ("first past the post").
   */
  multiLlm: z.array(z.string()).optional(),
  /**
   * Native HTTP LLM transport (Rust engine only). Names a provider from
   * `providers` that the Rust engine should call directly over HTTP with
   * SSE streaming, instead of proxying each LLM call back through the JS
   * host. Only `openai`/`kimi` (Chat Completions) and `anthropic`
   * (Messages) provider types are supported; other types fall back to the
   * host proxy.
   */
  nativeLlmProvider: z.string().optional(),
  /**
   * Native tool execution (Rust engine only). When true, read-only tools
   * (Read/Grep/Glob) execute inside the Rust engine process, sandboxed to
   * the workspace root — skipping the host round-trip. Anything outside
   * the sandbox or not natively supported still executes on the JS host
   * under the full permission system.
   */
  nativeTools: z.boolean().optional(),
});

/**
 * The secondary-model recipe (`[secondary_model]` on disk): `model` points at
 * a `[models]` entry and every remaining field is a subagent-only patch,
 * materialized into a synthesized derived model entry at runtime. `default_effort`
 * doubles as the subagent thinking effort.
 */
const SecondaryModelConfigSchema = ModelAliasBaseSchema.omit({
  provider: true,
  model: true,
  protocol: true,
  betaApi: true,
  baseUrl: true,
})
  .partial()
  .extend({
    model: z.string().min(1).optional(),
  });

const McpConfigSchema = z.object({
  /**
   * Global default MCP server startup (connect + tool discovery) timeout in
   * milliseconds. A per-server `startupTimeoutMs` in `mcp.json` and the
   * KIMI_MCP_STARTUP_TIMEOUT_MS env var both win over this value. Defaults
   * to 30s when unset.
   */
  startupTimeoutMs: McpTimeoutMsSchema.optional(),
  /**
   * Global default single MCP tool-call timeout in milliseconds. A
   * per-server `toolTimeoutMs` in `mcp.json` and the
   * KIMI_MCP_TOOL_TIMEOUT_MS env var both win over this value. Falls back to
   * the client built-in default when unset.
   */
  toolTimeoutMs: McpTimeoutMsSchema.optional(),
});

export const KimiConfigSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  models: z.record(z.string(), ModelAliasSchema).optional(),
  thinking: ThinkingConfigSchema.optional(),
  planMode: z.boolean().optional(),
  yolo: z.boolean().optional(),
  defaultPermissionMode: PermissionModeSchema.optional(),
  defaultPlanMode: z.boolean().optional(),
  permission: PermissionConfigSchema.optional(),
  hooks: z.array(HookDefSchema).optional(),
  services: ServicesConfigSchema.optional(),
  mergeAllAvailableSkills: z.boolean().optional(),
  extraSkillDirs: z.array(z.string()).optional(),
  extraAgentDirs: z.array(z.string()).optional(),
  loopControl: LoopControlSchema.optional(),
  background: BackgroundConfigSchema.optional(),
  subagent: SubagentConfigSchema.optional(),
  agent: AgentConfigSchema.optional(),
  secondaryModel: SecondaryModelConfigSchema.optional(),
  mcp: McpConfigSchema.optional(),
  image: ImageConfigSchema.optional(),
  modelCatalog: ModelCatalogConfigSchema.optional(),
  experimental: ExperimentalConfigSchema.optional(),
  telemetry: z.boolean().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

// ---- Experimental flag definitions (only ids needed) ----

/**
 * Experimental feature flags — the full v1 id list (copied from v1
 * `packages/agent-core/src/flags/registry.ts`). Only the `id` fields are used
 * (to build `REGISTERED_EXPERIMENTAL_FLAGS`).
 */
export const FLAG_DEFINITIONS = [
  { id: 'tool-select' },
  { id: 'native_tools' },
  { id: 'rpc_microtask' },
  { id: 'github_tools' },
  { id: 'goal_completion_verifier' },
  { id: 'xunfei_coding_plan' },
  { id: 'secondary-model' },
] as const satisfies readonly { readonly id: string }[];

// ---- TOML transform utilities ----

function snakeToCamel(str: string): string {
  return str.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function transformRecord(
  value: Record<string, unknown>,
  transformEntry: (entry: Record<string, unknown>) => Record<string, unknown>,
  transformName: (name: string) => string = (name) => name,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [entryName, entryConfig] of Object.entries(value)) {
    record[transformName(entryName)] = isPlainObject(entryConfig)
      ? transformEntry(entryConfig)
      : entryConfig;
  }
  return record;
}

function transformPlainObject(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[snakeToCamel(key)] = value;
  }
  return out;
}

function transformProviderData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'oauth') {
      out[targetKey] = isPlainObject(value) ? transformPlainObject(value) : value;
    } else if (targetKey === 'env' || targetKey === 'customHeaders') {
      out[targetKey] = isPlainObject(value) ? JSON.parse(JSON.stringify(value)) : value;
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

function transformModelData(data: Record<string, unknown>): Record<string, unknown> {
  const out = transformPlainObject(data);
  if (isPlainObject(out['overrides'])) {
    out['overrides'] = transformPlainObject(out['overrides']);
  }
  return out;
}

function transformPermissionData(data: Record<string, unknown>): Record<string, unknown> {
  const raw = transformPlainObject(data);
  const out: Record<string, unknown> = {};
  const rules: unknown[] = [];
  appendPermissionRules(rules, raw['rules']);
  appendPermissionRules(rules, raw['deny'], 'deny');
  appendPermissionRules(rules, raw['allow'], 'allow');
  appendPermissionRules(rules, raw['ask'], 'ask');
  if (rules.length > 0) {
    out['rules'] = rules;
  }
  return out;
}

function appendPermissionRules(
  target: unknown[],
  value: unknown,
  decision?: 'allow' | 'deny' | 'ask',
): void {
  if (value === undefined) return;
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    target.push(transformPermissionRule(entry, decision));
  }
}

function transformPermissionRule(value: unknown, decision?: 'allow' | 'deny' | 'ask'): unknown {
  if (!isPlainObject(value)) return value;
  const rule = transformPlainObject(value);
  const tool = rule['tool'];
  const match = rule['match'];
  const pattern = rule['pattern'];
  const out: Record<string, unknown> = {};
  if (decision !== undefined) {
    out['decision'] = decision;
  } else {
    out['decision'] = rule['decision'];
  }
  out['scope'] = rule['scope'];
  out['reason'] = rule['reason'];
  if (typeof tool === 'string') {
    const argPattern = typeof match === 'string' ? match : pattern;
    out['pattern'] = typeof argPattern === 'string' ? `${tool}(${argPattern})` : tool;
  } else {
    out['pattern'] = pattern;
  }
  return out;
}

function transformLoopControlData(data: Record<string, unknown>): Record<string, unknown> {
  const out = transformPlainObject(data);
  if (out['maxStepsPerTurn'] === undefined && out['maxStepsPerRun'] !== undefined) {
    out['maxStepsPerTurn'] = out['maxStepsPerRun'];
  }
  delete out['maxStepsPerRun'];
  return out;
}

function transformServiceData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'oauth') {
      out[targetKey] = isPlainObject(value) ? transformPlainObject(value) : value;
    } else if (targetKey === 'customHeaders') {
      out[targetKey] = isPlainObject(value) ? JSON.parse(JSON.stringify(value)) : value;
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

/**
 * Convert TOML-derived snake_case keys to the camelCase agent-core schema
 * expects, recursively transforming known sub-objects.
 */
export function transformTomlData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);

    if (targetKey === 'providers' && isPlainObject(value)) {
      result[targetKey] = transformRecord(value, transformProviderData);
    } else if (targetKey === 'models' && isPlainObject(value)) {
      result[targetKey] = transformRecord(value, transformModelData);
    } else if (targetKey === 'thinking' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'permission' && isPlainObject(value)) {
      result[targetKey] = transformPermissionData(value);
    } else if (targetKey === 'services' && isPlainObject(value)) {
      result[targetKey] = transformRecord(value, transformServiceData, snakeToCamel);
    } else if (targetKey === 'loopControl' && isPlainObject(value)) {
      result[targetKey] = transformLoopControlData(value);
    } else if (targetKey === 'background' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'image' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'experimental' && isPlainObject(value)) {
      result[targetKey] = cloneRecord(value);
    } else if (targetKey === 'subagent' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'agent' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'secondaryModel' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'mcp' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'modelCatalog' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (!isPlainObject(value)) {
      result[targetKey] = value;
    }
  }
  return result;
}

// ---- Workdir key utilities ----

const WORKDIR_KEY_PREFIX = 'wd_';
const HASH_LENGTH = 12;
const MAX_WORKDIR_SLUG_LENGTH = 40;

function slugifyWorkDirName(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, MAX_WORKDIR_SLUG_LENGTH)
    .replaceAll(/^-+|-+$/g, '');
  return slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

export function normalizeWorkDir(workDir: string): string {
  if (isWindowsAbsolutePath(workDir)) {
    return win32.resolve(workDir).replaceAll('\\', '/');
  }
  return resolve(workDir);
}

export function encodeWorkDirKey(workDir: string): string {
  const normalized = normalizeWorkDir(workDir);
  const slug = slugifyWorkDirName(basename(normalized));
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}