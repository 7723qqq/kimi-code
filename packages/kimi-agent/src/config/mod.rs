//! Pure Rust configuration and credential manager for `kimi-agent` (P27 批 1).
//!
//! Loads and validates `config.toml` without depending on Node/Bun or any JS runtimes.
//! Discovers configuration from standard locations (`./config.toml`, `~/.kimi-code/config.toml`).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::permission::{HookDef, PermissionMode, PolicySnapshot};
use crate::rpc::types::{
    NativeLlmConfig, ResolvedMultiLlmProvider, SecondaryModelEntry, SecondaryModelPool,
};

pub mod write;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderConfig {
    #[serde(rename = "default_model", default)]
    pub default_model: Option<String>,
    #[serde(rename = "type", default)]
    pub provider_type: Option<String>,
    #[serde(rename = "api_key", default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub api_key_env: Option<String>,
    #[serde(rename = "base_url", default)]
    pub base_url: Option<String>,
    #[serde(rename = "max_tokens", default)]
    pub max_tokens: Option<u32>,
    /// OAuth binding (v2 `providers.*.oauth`): its presence marks the
    /// provider OAuth-authenticated even without a static key.
    #[serde(default)]
    pub oauth: Option<serde_json::Value>,
    /// Custom-registry provenance (v2 `providers.*.source`): the api.json
    /// URL (and key) this provider was imported from. Its presence is what
    /// makes the refresh rediscover the provider's registry; without the
    /// field the blob would be dropped on read and the refresh blind.
    #[serde(default)]
    pub source: Option<serde_json::Value>,
    /// Extra HTTP headers sent with every request to this provider
    /// (schema `providers.*.customHeaders`). Self-hosted gateways put their
    /// auth/routing headers here; without it those deployments 401.
    #[serde(rename = "custom_headers", alias = "customHeaders", default)]
    pub custom_headers: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelAliasConfig {
    #[serde(default)]
    pub provider: Option<String>,
    /// The document schema's spelling of `provider` (v2
    /// `ModelRecord.providerId`); it wins when both are set.
    #[serde(rename = "provider_id", alias = "providerId", default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// The wire-facing model name (v2 `ModelRecord.name`): the name sent to
    /// the provider, ahead of `model`. Never the alias.
    #[serde(default)]
    pub name: Option<String>,
    /// Extra names this entry can be looked up by (v2 `ModelRecord.aliases`).
    #[serde(default)]
    pub aliases: Option<Vec<String>>,
    /// Per-model credential (v2 `ModelRecord.apiKey`): wins over the
    /// provider's key.
    #[serde(rename = "api_key", alias = "apiKey", default)]
    pub api_key: Option<String>,
    /// Per-model OAuth binding (v2 `ModelRecord.oauth`), same shape as
    /// `[providers.*].oauth`: its presence marks the model
    /// OAuth-authenticated even without a static key.
    #[serde(default)]
    pub oauth: Option<serde_json::Value>,
    #[serde(rename = "system_prompt", alias = "systemPrompt", default)]
    pub system_prompt: Option<String>,
    /// Catalog fields the REST surface exposes (v2 `ModelRecord`).
    #[serde(rename = "max_context_size", alias = "maxContextSize", default)]
    pub max_context_size: Option<u32>,
    #[serde(rename = "display_name", alias = "displayName", default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub capabilities: Option<Vec<String>>,
    #[serde(rename = "max_output_size", alias = "maxOutputSize", default)]
    pub max_output_size: Option<u32>,
    #[serde(rename = "support_efforts", alias = "supportEfforts", default)]
    pub support_efforts: Option<Vec<String>>,
    #[serde(rename = "default_effort", alias = "defaultEffort", default)]
    pub default_effort: Option<String>,
    #[serde(rename = "adaptive_thinking", alias = "adaptiveThinking", default)]
    pub adaptive_thinking: Option<bool>,
    /// Per-model wire protocol override (v2 `ModelRecord.protocol`).
    #[serde(default)]
    pub protocol: Option<String>,
    /// Route anthropic-protocol models through the beta Messages API.
    #[serde(rename = "beta_api", alias = "betaApi", default)]
    pub beta_api: Option<bool>,
    /// Per-model endpoint override (schema `models.*.baseUrl`): a gateway
    /// provider serving this alias over a different endpoint than the
    /// provider default. Wins over the provider's `base_url`.
    #[serde(rename = "base_url", alias = "baseUrl", default)]
    pub base_url: Option<String>,
    /// Declared prompt/input cap when below the total window (schema
    /// `models.*.maxInputSize`).
    #[serde(rename = "max_input_size", alias = "maxInputSize", default)]
    pub max_input_size: Option<u32>,
    /// The wire field carrying reasoning content for this model (schema
    /// `models.*.reasoningKey`).
    #[serde(rename = "reasoning_key", alias = "reasoningKey", default)]
    pub reasoning_key: Option<String>,
    /// The effort value that encodes "thinking off" on the wire (schema
    /// `models.*.offEffort`): models whose default is to reason need it sent
    /// instead of omitting the effort field.
    #[serde(rename = "off_effort", alias = "offEffort", default)]
    pub off_effort: Option<String>,
    /// Catalog fields overridden on top of the base record (v2
    /// `ModelRecord.overrides`): a provider-model refresh may rewrite the base
    /// fields, so a user override is the only value that survives it.
    #[serde(default)]
    pub overrides: Option<ModelOverrideConfig>,
}

/// `[models.<alias>.overrides]` (v2 `ModelOverrideSchema`): the catalog fields
/// an override may shadow. Identity and routing fields are deliberately absent
/// — an override cannot repoint a model at another provider, endpoint, or wire
/// protocol.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelOverrideConfig {
    #[serde(rename = "max_context_size", alias = "maxContextSize", default)]
    pub max_context_size: Option<u32>,
    #[serde(rename = "max_input_size", alias = "maxInputSize", default)]
    pub max_input_size: Option<u32>,
    #[serde(rename = "max_output_size", alias = "maxOutputSize", default)]
    pub max_output_size: Option<u32>,
    #[serde(default)]
    pub capabilities: Option<Vec<String>>,
    #[serde(rename = "display_name", alias = "displayName", default)]
    pub display_name: Option<String>,
    #[serde(rename = "reasoning_key", alias = "reasoningKey", default)]
    pub reasoning_key: Option<String>,
    #[serde(rename = "adaptive_thinking", alias = "adaptiveThinking", default)]
    pub adaptive_thinking: Option<bool>,
    #[serde(rename = "support_efforts", alias = "supportEfforts", default)]
    pub support_efforts: Option<Vec<String>>,
    #[serde(rename = "default_effort", alias = "defaultEffort", default)]
    pub default_effort: Option<String>,
    #[serde(rename = "off_effort", alias = "offEffort", default)]
    pub off_effort: Option<String>,
}

impl ModelAliasConfig {
    /// The entry with its `overrides` block applied (v2 `effectiveRecordOf`):
    /// an override wins over the base field it shadows, an absent one leaves
    /// the base value. Identity and routing fields are not overridable, so they
    /// always come from the base record.
    fn effective(&self) -> Self {
        let Some(overrides) = self.overrides.as_ref() else {
            return self.clone();
        };
        let mut effective = self.clone();
        effective.max_context_size = overrides.max_context_size.or(self.max_context_size);
        effective.max_input_size = overrides.max_input_size.or(self.max_input_size);
        effective.max_output_size = overrides.max_output_size.or(self.max_output_size);
        effective.capabilities = overrides
            .capabilities
            .clone()
            .or_else(|| self.capabilities.clone());
        effective.display_name = overrides
            .display_name
            .clone()
            .or_else(|| self.display_name.clone());
        effective.reasoning_key = overrides
            .reasoning_key
            .clone()
            .or_else(|| self.reasoning_key.clone());
        effective.adaptive_thinking = overrides.adaptive_thinking.or(self.adaptive_thinking);
        effective.support_efforts = overrides
            .support_efforts
            .clone()
            .or_else(|| self.support_efforts.clone());
        effective.default_effort = overrides
            .default_effort
            .clone()
            .or_else(|| self.default_effort.clone());
        effective.off_effort = overrides
            .off_effort
            .clone()
            .or_else(|| self.off_effort.clone());
        effective
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentConfig {
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(rename = "multi_llm", default)]
    pub multi_llm: Option<Vec<String>>,
    #[serde(rename = "native_llm_provider", default)]
    pub native_llm_provider: Option<String>,
    #[serde(rename = "native_tools", default)]
    pub native_tools: Option<bool>,
    #[serde(rename = "rust_self_contained", default)]
    pub rust_self_contained: Option<bool>,
    #[serde(default)]
    pub yolo: Option<bool>,
    /// `[agent].plan_mode`: start turns in plan mode by default (schema).
    #[serde(rename = "plan_mode", alias = "planMode", default)]
    pub plan_mode: Option<bool>,
}

/// `[model_catalog]` section (schema `ModelCatalogConfig`): automatic
/// provider-model discovery.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelCatalogConfig {
    /// Interval (ms) between automatic provider-model refreshes. `0`/unset
    /// disables the periodic refresh.
    #[serde(rename = "refresh_interval_ms", alias = "refreshIntervalMs", default)]
    pub refresh_interval_ms: Option<u64>,
    /// Refresh once shortly after the daemon starts.
    #[serde(rename = "refresh_on_start", alias = "refreshOnStart", default)]
    pub refresh_on_start: Option<bool>,
}

/// `[shell]` section (v2 `configSection.ts`): pin the local command shell.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ShellConfig {
    /// `auto` (default) | `bash` | `powershell` | `pwsh` | `cmd`. Any other
    /// value falls back to auto-detection. `KIMI_SHELL_PATH` still wins.
    #[serde(default)]
    pub preference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PermissionRuleConfig {
    #[serde(default)]
    pub decision: Option<String>,
    #[serde(default)]
    pub pattern: Option<String>,
    /// Why the rule exists (schema `permission.rules[].reason`): echoed in
    /// the denial so the model and the UI can explain the refusal.
    #[serde(default)]
    pub reason: Option<String>,
    /// Rule origin (schema `permission.rules[].scope`, default `user`):
    /// `turn-override` > `session-runtime` > `project` > `user`. The host
    /// merges rules by scope before handing the engine a snapshot, so the
    /// engine only carries the value through.
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PermissionConfig {
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub rules: Option<Vec<PermissionRuleConfig>>,
    /// `[permission] dangerousCommandGuard` (v2
    /// `isDangerousCommandGuardEnabled`): `false` skips the engine's
    /// DangerousCommandAsk policy. Unset keeps the guard on.
    #[serde(rename = "dangerousCommandGuard", default)]
    pub dangerous_command_guard: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct McpServerConfig {
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    /// Working directory for a stdio server, resolved against the process
    /// working directory when relative (v2 `McpServerStdioConfig.cwd`).
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    /// Environment variable holding a bearer token for a remote server; the
    /// value is read at connect time and sent as `Authorization: Bearer …`
    /// (v2 `bearerTokenEnvVar`, client-remote.ts:9-23).
    #[serde(default, alias = "bearerTokenEnvVar")]
    pub bearer_token_env_var: Option<String>,
    /// Explicit transport (`stdio` / `sse` / `http`). Without it a `url`
    /// defaults to Streamable HTTP and a `command` to stdio, matching the v2
    /// config preprocess (config-schema.ts:58-65).
    #[serde(default)]
    pub transport: Option<String>,
    /// `false` keeps the entry listed as `disabled` without ever connecting
    /// it (v2 `config.enabled`).
    #[serde(default)]
    pub enabled: Option<bool>,
    /// Allowlist of tool names exposed to the model; `None` exposes every
    /// tool the server advertises (v2 `enabledTools`).
    #[serde(default, alias = "enabledTools")]
    pub enabled_tools: Option<Vec<String>>,
    /// Denylist applied after the allowlist (v2 `disabledTools`).
    #[serde(default, alias = "disabledTools")]
    pub disabled_tools: Option<Vec<String>>,
    /// Startup (connect + tool discovery) timeout in milliseconds
    /// (v2 per-server `startupTimeoutMs`).
    #[serde(default, alias = "startupTimeoutMs")]
    pub startup_timeout_ms: Option<u64>,
    /// Single tool-call timeout in milliseconds (v2 per-server `toolTimeoutMs`).
    #[serde(default, alias = "toolTimeoutMs")]
    pub tool_timeout_ms: Option<u64>,
    /// Keep this server's tools out of the model's top-level tool list and let
    /// it load them on demand through `select_tools` (v2 per-server
    /// `deferred`). Takes effect only when the `tool_select` experimental flag
    /// is on *and* the model declares `dynamically_loaded_tools`; otherwise the
    /// field is ignored and the tools are exposed inline, which is also the
    /// default when it is absent.
    #[serde(default)]
    pub deferred: Option<bool>,
}

/// Global MCP defaults, mirroring the v2 `[mcp]` config section
/// (`app/mcpConfig/configSection.ts:9-12`). Both values are also settable per
/// server and through `KIMI_MCP_STARTUP_TIMEOUT_MS` /
/// `KIMI_MCP_TOOL_TIMEOUT_MS`, which win over this section.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct McpTimeoutConfig {
    #[serde(default, alias = "startupTimeoutMs")]
    pub startup_timeout_ms: Option<u64>,
    #[serde(default, alias = "toolTimeoutMs")]
    pub tool_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GitHubConfig {
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
}

/// One `[services.moonshot_search]` / `[services.moonshot_fetch]` entry (v2
/// `MoonshotServiceConfig`). Snake_case is the file contract; the camelCase
/// aliases match the spelling the host schema also accepts.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MoonshotServiceConfig {
    #[serde(rename = "base_url", alias = "baseUrl", default)]
    pub base_url: Option<String>,
    #[serde(rename = "api_key", alias = "apiKey", default)]
    pub api_key: Option<String>,
    #[serde(rename = "custom_headers", alias = "customHeaders", default)]
    pub custom_headers: Option<HashMap<String, String>>,
}

/// The `[services]` section (v2 `configSection.ts`): optional Moonshot
/// backends that replace (search) or front (fetch) the built-in web tools.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ServicesConfig {
    #[serde(rename = "moonshot_search", alias = "moonshotSearch", default)]
    pub moonshot_search: Option<MoonshotServiceConfig>,
    #[serde(rename = "moonshot_fetch", alias = "moonshotFetch", default)]
    pub moonshot_fetch: Option<MoonshotServiceConfig>,
}

/// One web-service backend after the `KIMI_WEB_*` env overlay, ready for the
/// native tool seam.
#[derive(Debug, Clone)]
pub struct ResolvedWebService {
    pub base_url: String,
    pub api_key: Option<String>,
    pub custom_headers: HashMap<String, String>,
}

/// The `[image]` section (v2 `agent/media/configSection.ts`): the limits
/// applied when the model reads an image for itself.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ImageConfig {
    #[serde(rename = "read_byte_budget", alias = "readByteBudget", default)]
    pub read_byte_budget: Option<u64>,
    #[serde(rename = "max_edge_px", alias = "maxEdgePx", default)]
    pub max_edge_px: Option<u32>,
}

/// The `[subagent]` section (v2 `session/subagent/configSection.ts`): the
/// timeout one `Agent` subagent turn may run for, foreground and background.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SubagentConfig {
    #[serde(rename = "timeout_ms", alias = "timeoutMs", default)]
    pub timeout_ms: Option<u64>,
}

/// The `[swarm]` section (v2 `features/swarm/configSection.ts`): the timeout
/// for one `AgentSwarm` subagent, independent of `[subagent]`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SwarmConfig {
    #[serde(rename = "timeout_ms", alias = "timeoutMs", default)]
    pub timeout_ms: Option<u64>,
}

/// The `[secondary_model]` subagent model pool section (v2
/// `session/subagent/configSection.ts`): either a declared pool
/// (`default_model` + the `models` alias table) or the recipe shape
/// (`model` pointing at a `[models]` entry, a single-entry pool).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SecondaryModelConfig {
    #[serde(rename = "default_model", default)]
    pub default_model: Option<String>,
    /// `[secondary_model.models]`: alias → hint shown in the tool description.
    #[serde(default)]
    pub models: Option<HashMap<String, String>>,
    #[serde(default)]
    pub force: Option<bool>,
    /// Recipe pointer to a `[models]` entry; the single-entry pool default.
    #[serde(default)]
    pub model: Option<String>,
    /// Subagent thinking effort override (v2 `default_effort`).
    #[serde(rename = "default_effort", default)]
    pub default_effort: Option<String>,
}

/// The `[loop_control]` section (v2 `loopControl`): per-step limits the host
/// threads into the turn loop. The deprecated spellings
/// (`max_retries_per_step`, `max_steps_per_run`) still resolve when the
/// current key is unset.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LoopControlConfig {
    #[serde(rename = "max_steps_per_turn", default)]
    pub max_steps_per_turn: Option<u32>,
    #[serde(rename = "max_steps_per_run", default)]
    pub max_steps_per_run: Option<u32>,
    #[serde(rename = "max_attempts_per_step", default)]
    pub max_attempts_per_step: Option<u32>,
    #[serde(rename = "max_retries_per_step", default)]
    pub max_retries_per_step: Option<u32>,
    /// Total requests one compaction round may issue (v2 #3750
    /// `loopControl.compactionMaxAttempts`); see
    /// [`KimiConfig::resolve_compaction_max_attempts`].
    #[serde(
        rename = "compaction_max_attempts",
        alias = "compactionMaxAttempts",
        default
    )]
    pub compaction_max_attempts: Option<u32>,
}

/// The `[thinking]` section (v2 `thinking`): the enable switch and the
/// preserved-thinking passthrough (`keep`) it gates.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ThinkingConfig {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub keep: Option<String>,
    /// The user's chosen reasoning effort (schema `thinking.effort`), sent as
    /// `reasoning_effort` on providers that support it.
    #[serde(default)]
    pub effort: Option<String>,
}

/// One `[experimental]` flag value (schema `experimental`): flags are free
/// booleans or strings, so the engine carries them verbatim and only the
/// features that read them interpret the value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum ExperimentalValue {
    Bool(bool),
    String(String),
}

/// The `[background]` section (schema `background`): the knobs governing
/// background task execution — how many may run at once, how long a shell
/// task may live, and how it is torn down.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BackgroundConfig {
    /// Concurrent running background tasks; further spawns are refused.
    #[serde(rename = "max_running_tasks", alias = "maxRunningTasks", default)]
    pub max_running_tasks: Option<u32>,
    /// When a foreground Bash command times out, move it to the background
    /// instead of killing it. Defaults to `true` when unset.
    #[serde(
        rename = "bash_auto_background_on_timeout",
        alias = "bashAutoBackgroundOnTimeout",
        default
    )]
    pub bash_auto_background_on_timeout: Option<bool>,
    /// Default timeout (seconds) for background Bash tasks; `0` means no
    /// timeout. Defaults to the tool's built-in 600s when unset.
    #[serde(rename = "bash_task_timeout_s", alias = "bashTaskTimeoutS", default)]
    pub bash_task_timeout_s: Option<u64>,
    /// How long `stop` waits for a cooperative exit before the task is
    /// considered killed. Defaults to 5s when unset.
    #[serde(rename = "kill_grace_period_ms", alias = "killGracePeriodMs", default)]
    pub kill_grace_period_ms: Option<u64>,
}

/// The global `[tools]` switch (schema `tools.enabled` / `tools.disabled`):
/// an allowlist applied first, then a denylist, intersected with every
/// agent's own tool policy.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ToolsConfig {
    #[serde(default)]
    pub enabled: Vec<String>,
    #[serde(default)]
    pub disabled: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KimiConfig {
    #[serde(rename = "default_model", default)]
    pub default_model: Option<String>,
    /// Global default provider pointer (v2 `default_provider`): the fallback
    /// owner for model aliases that do not name a provider.
    #[serde(rename = "default_provider", default)]
    pub default_provider: Option<String>,
    #[serde(default)]
    pub providers: HashMap<String, ProviderConfig>,
    #[serde(default)]
    pub models: HashMap<String, ModelAliasConfig>,
    #[serde(default)]
    pub agent: AgentConfig,
    /// `[shell]` preference for the local command shell (v2 `configSection.ts`).
    #[serde(default)]
    pub shell: ShellConfig,
    /// Turn-loop limits (v2 `[loop_control]` section); see
    /// [`KimiConfig::resolve_max_attempts_per_step`].
    #[serde(rename = "loop_control", default)]
    pub loop_control: LoopControlConfig,
    /// Thinking configuration (v2 `[thinking]` section); see
    /// [`KimiConfig::resolve_thinking_keep`].
    #[serde(default)]
    pub thinking: ThinkingConfig,
    #[serde(default)]
    pub permission: Option<PermissionConfig>,
    #[serde(rename = "mcp_servers", default)]
    pub mcp_servers: HashMap<String, McpServerConfig>,
    /// Global MCP defaults (v2 `[mcp]` section).
    #[serde(default)]
    pub mcp: McpTimeoutConfig,
    #[serde(default)]
    pub github: GitHubConfig,
    /// `[services]` web-service backends (v2 `configSection.ts`); see
    /// [`KimiConfig::resolve_web_search_service`].
    #[serde(default)]
    pub services: ServicesConfig,
    /// Per-subagent timeout (v2 `[subagent]` section); see
    /// [`KimiConfig::resolve_subagent_timeout_ms`].
    #[serde(default)]
    pub subagent: SubagentConfig,
    /// Per-swarm timeout (v2 `[swarm]` section); see
    /// [`KimiConfig::resolve_swarm_timeout_ms`].
    #[serde(default)]
    pub swarm: SwarmConfig,
    /// Model-initiated image-read limits (v2 `[image]` section); see
    /// [`KimiConfig::resolve_image_read_byte_budget`].
    #[serde(default)]
    pub image: ImageConfig,
    /// Subagent model pool (v2 `[secondary_model]` section); see
    /// [`KimiConfig::extract_secondary_model_pool`].
    #[serde(rename = "secondary_model", default)]
    pub secondary_model: Option<SecondaryModelConfig>,
    /// User-configured external hooks (v2 `[hooks]` section). The engine
    /// executes the `PreToolUse` ones before native tool calls (G-6 #6).
    #[serde(default)]
    pub hooks: Vec<HookDef>,
    /// Global tool switch (schema `[tools]`): applied to every agent in all
    /// sessions. The host-driven paths get it through their own snapshot; the
    /// file-reading entries (REPL / `--serve` / `--acp`) build it here.
    #[serde(default)]
    pub tools: ToolsConfig,
    /// Background task knobs (schema `[background]`).
    #[serde(default)]
    pub background: BackgroundConfig,
    /// Free-form feature flags (schema `[experimental]`).
    #[serde(default)]
    pub experimental: HashMap<String, ExperimentalValue>,
    /// The default permission mode when `[permission].mode` is unset (schema
    /// `default_permission_mode`); `[agent].yolo` still wins.
    #[serde(
        rename = "default_permission_mode",
        alias = "defaultPermissionMode",
        default
    )]
    pub default_permission_mode: Option<String>,
    /// Top-level `yolo` (schema): the v1 flat form of `[agent].yolo`.
    #[serde(default)]
    pub yolo: Option<bool>,
    /// Top-level `plan_mode` / `default_plan_mode` (schema): the initial plan
    /// mode for a new session. `plan_mode` is the v1 flat name; the sectioned
    /// `[agent].plan_mode` is preferred when both are present.
    #[serde(rename = "plan_mode", alias = "planMode", default)]
    pub plan_mode: Option<bool>,
    #[serde(rename = "default_plan_mode", alias = "defaultPlanMode", default)]
    pub default_plan_mode: Option<bool>,
    /// `[model_catalog]` automatic provider-model refresh (schema).
    #[serde(rename = "model_catalog", alias = "modelCatalog", default)]
    pub model_catalog: Option<ModelCatalogConfig>,
    /// Top-level telemetry switch (schema `telemetry`).
    #[serde(default)]
    pub telemetry: Option<bool>,
    /// Whether clients may automatically generate session titles (schema
    /// `auto_session_title`, upstream #3962). `None`/absent means enabled —
    /// only an explicit `false` disables it, matching upstream's
    /// "disabled only when explicitly set to false" semantics. The engine
    /// generates titles only when the host asks (`session/generate_title`),
    /// so this is the host's gate, carried on the config surface.
    #[serde(rename = "auto_session_title", alias = "autoSessionTitle", default)]
    pub auto_session_title: Option<bool>,
    /// Extra directories scanned for skills (schema `extra_skill_dirs`) and
    /// for agent definitions (schema `extra_agent_dirs`), plus the
    /// "merge every discovered skill" switch.
    #[serde(rename = "extra_skill_dirs", alias = "extraSkillDirs", default)]
    pub extra_skill_dirs: Vec<String>,
    #[serde(rename = "extra_agent_dirs", alias = "extraAgentDirs", default)]
    pub extra_agent_dirs: Vec<String>,
    #[serde(
        rename = "merge_all_available_skills",
        alias = "mergeAllAvailableSkills",
        default
    )]
    pub merge_all_available_skills: Option<bool>,
    /// `[models]` entries that cannot resolve, collected by
    /// [`KimiConfig::from_file`] on the real load path (v2 #3681). Not a
    /// config-file key: the server stages them and broadcasts
    /// `event.config.warning` once the global lane is live, which is what
    /// gives the v3 `config.warning` entity its producer. Empty for a config
    /// built by parsing alone ([`std::str::FromStr`] cannot see the raw TOML
    /// an entry's shape lives in).
    #[serde(skip)]
    pub config_warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedNativeLlm {
    pub protocol: String,
    pub base_url: String,
    pub api_key: String,
    /// Name of the environment variable the credential is read from at
    /// request time (`[providers.*].api_key_env`); passed through to the
    /// transport's `api_key_env` channel. `None` when the provider carries a
    /// static key or an OAuth binding.
    #[serde(default)]
    pub api_key_env: Option<String>,
    /// OAuth-managed auth: the provider name the transport asks for a bearer
    /// token instead of using `api_key`. `None` when the provider carries a
    /// static key.
    #[serde(default)]
    pub auth_provider: Option<String>,
    pub model: String,
    pub max_tokens: Option<u32>,
    /// The alias's declared capabilities (`[models.<alias>].capabilities`),
    /// when the file declares them. The image-read gate refuses only a
    /// declared set that lacks `image_in`; `None`/empty stays unknown.
    #[serde(default)]
    pub capabilities: Option<Vec<String>>,
    /// Extra HTTP headers from `[providers.*].custom_headers`.
    #[serde(default)]
    pub custom_headers: HashMap<String, String>,
    /// Route an anthropic-protocol model through the beta Messages API
    /// (`[models.<alias>].beta_api`).
    #[serde(default)]
    pub beta_api: bool,
    /// The alias's own system prompt (`[models.<alias>].system_prompt`).
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Declared output cap (`[models.<alias>].max_output_size`).
    #[serde(default)]
    pub max_output_size: Option<u32>,
    /// Declared input cap when below the window
    /// (`[models.<alias>].max_input_size`).
    #[serde(default)]
    pub max_input_size: Option<u32>,
    /// Explicit adaptive-thinking support, overriding the model-name version
    /// inference (`[models.<alias>].adaptive_thinking`).
    #[serde(default)]
    pub adaptive_thinking: Option<bool>,
    /// The wire field carrying reasoning content
    /// (`[models.<alias>].reasoning_key`).
    #[serde(default)]
    pub reasoning_key: Option<String>,
    /// The effort value that encodes "thinking off" on the wire
    /// (`[models.<alias>].off_effort`).
    #[serde(default)]
    pub off_effort: Option<String>,
}

impl std::str::FromStr for KimiConfig {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        toml::from_str(s).map_err(|e| format!("Invalid TOML configuration: {e}"))
    }
}

impl KimiConfig {
    /// Load configuration from a specific file path.
    ///
    /// The malformed-`[models]`-entry warnings are both logged and staged on
    /// the returned config ([`KimiConfig::config_warnings`]): logging alone
    /// left `event.config.warning` with no producer anywhere in the engine.
    /// Config load happens before the server exists, so the list has to travel
    /// with the config until the server picks it up and broadcasts it
    /// (`server/mod.rs` `publish_config_warnings`).
    pub fn from_file(path: &Path) -> Result<Self, String> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read config at {}: {e}", path.display()))?;
        let mut config: Self = content.parse()?;
        config.config_warnings = Self::malformed_model_entries(&content);
        for warning in &config.config_warnings {
            tracing::warn!(path = %path.display(), "{warning}");
        }
        Ok(config)
    }

    /// `[models]` entries that declare no `model` field (v2 #3681
    /// `collectMalformedModelEntries`): the entry cannot resolve to a wire
    /// model, so it is inert. The usual cause is an unquoted dotted alias —
    /// `[models.a.b]` parses as a nested table under `models.a` — which the
    /// message spells out so the fix is a quoted table name.
    ///
    /// Reads the raw TOML rather than the deserialized config: serde drops the
    /// nested table that makes the entry malformed, and with it the evidence
    /// of what the alias was meant to be.
    pub fn malformed_model_entries(raw_toml: &str) -> Vec<String> {
        let Ok(value) = raw_toml.parse::<toml::Value>() else {
            return Vec::new();
        };
        let Some(models) = value.get("models").and_then(toml::Value::as_table) else {
            return Vec::new();
        };
        let mut warnings = Vec::new();
        for (alias, entry) in models {
            let Some(entry) = entry.as_table() else {
                continue;
            };
            if entry.contains_key("model") {
                continue;
            }
            let base = format!(
                "[models] entry '{alias}' is missing the 'model' field and cannot be used as a model"
            );
            match dotted_alias_suffix(alias, entry) {
                Some(dotted) => warnings.push(format!(
                    "{base}; if the alias contains dots, quote the table name (e.g. [models.\"{dotted}\"])."
                )),
                None => warnings.push(format!("{base}.")),
            }
        }
        warnings
    }

    /// 探测 `config.toml` 路径（严格支持环境变量隔离）：
    /// 1. `KIMI_CONFIG_PATH` 显式指定的文件路径
    /// 2. `KIMI_CODE_HOME/config.toml` 隔离目录
    /// 3. `./config.toml` (当前工作区本地配置)
    /// 4. `~/.kimi-code/config.toml` 全局配置
    /// 5. `~/.kimi/config.toml` 遗留兼容配置
    pub fn discover() -> Result<(Self, PathBuf), String> {
        // 1. 显式指定的配置文件路径
        if let Some(explicit) = std::env::var_os("KIMI_CONFIG_PATH") {
            let path = PathBuf::from(explicit);
            if path.is_file() {
                let config = Self::from_file(&path)?;
                return Ok((config, path));
            }
        }

        // 2. 显式隔离的 HOME 目录
        if let Some(code_home) = std::env::var_os("KIMI_CODE_HOME") {
            let path = PathBuf::from(code_home).join("config.toml");
            if path.is_file() {
                let config = Self::from_file(&path)?;
                return Ok((config, path));
            }
        }

        // 3. 当前工作区本地配置
        let cwd_config = PathBuf::from("config.toml");
        if cwd_config.is_file() {
            let config = Self::from_file(&cwd_config)?;
            return Ok((config, cwd_config));
        }

        // 4. 用户全局配置
        if let Some(home) = dirs_home() {
            let kimi_code_config = home.join(".kimi-code").join("config.toml");
            if kimi_code_config.is_file() {
                let config = Self::from_file(&kimi_code_config)?;
                return Ok((config, kimi_code_config));
            }

            let legacy_config = home.join(".kimi").join("config.toml");
            if legacy_config.is_file() {
                let config = Self::from_file(&legacy_config)?;
                return Ok((config, legacy_config));
            }
        }

        Err("No config.toml discovered in KIMI_CONFIG_PATH, KIMI_CODE_HOME, ./config.toml, or ~/.kimi-code/config.toml".into())
    }

    /// Extract the active Native LLM configuration for the given or default model.
    pub fn extract_native_llm(&self, target_model: Option<&str>) -> Option<ResolvedNativeLlm> {
        let model_key = target_model
            .or(self.default_model.as_deref())
            .unwrap_or("default");

        // v2 `findByName`: the table key first, then any entry that declares
        // the name in its `aliases`, so `default_model` may point at an alias
        // rather than the table key.
        let entry = self.models.get_key_value(model_key).or_else(|| {
            self.models.iter().find(|(_, entry)| {
                entry
                    .aliases
                    .as_ref()
                    .is_some_and(|names| names.iter().any(|name| name == model_key))
            })
        });

        let (provider_name, wire_model) = if let Some((key, alias)) = entry {
            // v2 `buildModel`: `providerId` is the document schema's spelling of
            // `provider`, and the wire name is `name` first, then `model` —
            // never the alias.
            let p = alias
                .provider_id
                .as_deref()
                .or(alias.provider.as_deref())
                .unwrap_or(key.as_str());
            let m = alias
                .name
                .as_deref()
                .or(alias.model.as_deref())
                .unwrap_or(key.as_str());
            (p, m)
        } else if let Some((p_name, _)) = self.providers.iter().find(|(name, _)| *name == model_key)
        {
            (p_name.as_str(), model_key)
        } else {
            let fallback = self.agent.native_llm_provider.as_deref()?;
            (fallback, model_key)
        };

        let provider = self.providers.get(provider_name)?;
        // v2 `effectiveRecordOf`: the entry's `overrides` block wins over the
        // base fields it shadows, so every catalog read below sees the
        // effective value.
        let effective = entry.map(|(_, alias)| alias.effective());
        let alias = effective.as_ref();
        // A declared alias endpoint wins: gateway providers serve one alias
        // over a different path than the provider default
        // (schema `models.*.baseUrl`).
        let p_type = provider
            .provider_type
            .as_deref()
            .unwrap_or("openai")
            .to_lowercase();
        // v2 `resolveModelConnection` (`human/llm/protocol/connection.ts`):
        // the declared endpoint wins, then the provider type's `baseUrlEnv`
        // read from the process environment, then the type's default — what
        // the vendor SDK would pick, which the engine carries itself because
        // it assembles the request URL. Google's default is the host root, so
        // a base-URL-less Gemini provider still resolves natively instead of
        // silently falling back to the host LLM proxy.
        let raw_base_url = alias
            .and_then(|alias| alias.base_url.as_deref())
            .or(provider.base_url.as_deref())
            .map(str::to_string)
            .or_else(|| endpoint_fallback_base_url(&p_type))?;
        // v2 `resolveModelAuthMaterial`: a model-level credential wins over the
        // provider's, and a static key wins over an OAuth binding at the same
        // level. An OAuth-bound model authenticates through the host token
        // channel instead, so its static key is optional; a model with neither
        // credential of its own falls back to the provider's, and one with no
        // credential anywhere cannot serve a request, so it does not resolve.
        let model_api_key = alias
            .and_then(|alias| alias.api_key.clone())
            .filter(|key| !key.is_empty());
        let model_oauth = alias.and_then(|alias| alias.oauth.as_ref());
        let provider_api_key = provider.api_key.clone().unwrap_or_default();
        let (api_key, auth_provider, api_key_env) = if let Some(key) = model_api_key {
            (key, None, None)
        } else if model_oauth.is_some() {
            (String::new(), Some(provider_name.to_string()), None)
        } else if !provider_api_key.is_empty() {
            (provider_api_key, None, provider.api_key_env.clone())
        } else if provider.oauth.is_some() {
            (String::new(), Some(provider_name.to_string()), None)
        } else {
            // An env-bound provider without a static key still resolves: the
            // transport reads the credential from the named variable at
            // request time (v2 `provider.apiKeyEnv`), so startup does not
            // require it to be set yet. Without any credential channel the
            // model cannot serve a request and does not resolve.
            let env_name = provider.api_key_env.as_deref().filter(|e| !e.is_empty())?;
            (String::new(), None, Some(env_name.to_string()))
        };

        let p_type = provider
            .provider_type
            .as_deref()
            .unwrap_or("openai")
            .to_lowercase();
        // The alias declares its wire protocol (schema `models.*.protocol`:
        // "anthropic" | "openai_responses"); the provider type is the
        // fallback, and everything else is Chat Completions.
        //
        // Google has to be matched explicitly: falling through to "openai"
        // sent Gemini traffic to `{base}/chat/completions` with a Chat
        // Completions body — the endpoint is the only thing a Gemini-compatible
        // relay accepts, so the request never even reached the model.
        //
        // `openai_responses` is a provider type of its own (v2 registers it as
        // a definition whose base protocol is the Responses API, and the host
        // config layer keys provider selection off it): a provider declared
        // with that type speaks Responses without the alias also having to
        // repeat the protocol.
        //
        // `vertexai` joins the Google family: the model catalog already maps
        // it to `google-genai` (`server/model_catalog.rs`), the docs describe
        // this fork's Vertex as Gemini-mode over a proxyable endpoint, and
        // v2 selects the Vertex endpoint inside the same Google connection.
        // Leaving it to fall through to Chat Completions contradicted the
        // catalog and sent Vertex-shaped URLs an OpenAI body.
        let protocol = match alias.and_then(|alias| alias.protocol.as_deref()) {
            Some("anthropic") => "anthropic",
            Some("openai_responses") => "openai_responses",
            Some("google") | Some("google-genai") | Some("gemini") | Some("vertexai") => {
                "google-genai"
            }
            _ if p_type == "anthropic" => "anthropic",
            _ if p_type == "google" || p_type == "google-genai" || p_type == "gemini" => {
                "google-genai"
            }
            _ if p_type == "vertexai" => "google-genai",
            _ if p_type == "openai_responses" || p_type == "openai-responses" => "openai_responses",
            _ => "openai",
        };

        let base_url = normalize_base_url(&raw_base_url, protocol);
        let capabilities = alias
            .and_then(|alias| alias.capabilities.clone())
            .filter(|caps| !caps.is_empty());

        Some(ResolvedNativeLlm {
            protocol: protocol.into(),
            base_url,
            api_key,
            api_key_env,
            auth_provider,
            model: wire_model.into(),
            max_tokens: provider.max_tokens,
            capabilities,
            custom_headers: provider.custom_headers.clone().unwrap_or_default(),
            beta_api: alias.and_then(|alias| alias.beta_api).unwrap_or(false),
            system_prompt: alias.and_then(|alias| alias.system_prompt.clone()),
            max_output_size: alias.and_then(|alias| alias.max_output_size),
            max_input_size: alias.and_then(|alias| alias.max_input_size),
            adaptive_thinking: alias.and_then(|alias| alias.adaptive_thinking),
            reasoning_key: alias.and_then(|alias| alias.reasoning_key.clone()),
            off_effort: alias.and_then(|alias| alias.off_effort.clone()),
        })
    }

    /// Resolve `[secondary_model]` into the engine's subagent model pool (v2
    /// `resolveSubagentModelPool` + `assertValidSubagentModelConfig`).
    ///
    /// `Ok(None)` when the section is absent or carries no pool keys (a
    /// patch-only recipe stays inert). A malformed section is an error naming
    /// the offending entry, so the standalone entry points fail at startup
    /// instead of silently disabling the user's configuration. The pool-wide
    /// `default_effort` is validated against every resolved entry (v2 #3785
    /// [`Self::validate_secondary_model_effort`]).
    pub fn extract_secondary_model_pool(
        &self,
        target_model: Option<&str>,
    ) -> Result<Option<SecondaryModelPool>, String> {
        let Some(section) = self.secondary_model.as_ref() else {
            return Ok(None);
        };
        let force = section.force == Some(true);
        let table = section.models.as_ref();
        let default_model = section
            .default_model
            .as_deref()
            .or(section.model.as_deref());

        if force && table.is_some() {
            return Err(
                "[secondary_model].force cannot be combined with [secondary_model.models]: the pool table only exists to offer the main agent a choice, and force removes that choice"
                    .into(),
            );
        }
        if table.is_none() && default_model.is_none() {
            if force {
                return Err(
                    "[secondary_model].default_model is required when [secondary_model].force is set"
                        .into(),
                );
            }
            return Ok(None);
        }
        let entries: Vec<(String, String)> = match table {
            Some(table) => table
                .iter()
                .map(|(alias, hint)| (alias.clone(), hint.clone()))
                .collect(),
            None => vec![(
                default_model
                    .expect("a pool default is required without a table")
                    .to_string(),
                String::new(),
            )],
        };
        if entries
            .iter()
            .any(|(alias, _)| alias == crate::subagent::secondary::PRIMARY_MODEL_CHOICE)
        {
            return Err(format!(
                "[secondary_model.models] key \"{}\" is reserved: it always binds the caller's own model. Rename the pool entry.",
                crate::subagent::secondary::PRIMARY_MODEL_CHOICE
            ));
        }
        let Some(default_model) = default_model else {
            return Err(
                "[secondary_model].default_model is required when [secondary_model.models] is configured"
                    .into(),
            );
        };
        if table.is_some() && !entries.iter().any(|(alias, _)| alias == default_model) {
            let available = entries
                .iter()
                .map(|(alias, _)| alias.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "[secondary_model].default_model \"{default_model}\" is not a [secondary_model.models] key. Available models: {available}."
            ));
        }

        let thinking_keep = self.resolve_thinking_keep();
        let models = entries
            .into_iter()
            .map(|(alias, hint)| {
                let resolved = self.extract_native_llm(Some(alias.as_str())).ok_or_else(|| {
                    format!(
                        "[secondary_model.models] entry \"{alias}\" could not be resolved: add it to [models] with a provider that has credentials."
                    )
                })?;
                Ok(SecondaryModelEntry {
                    alias,
                    hint,
                    llm: native_llm_config(
                        resolved,
                        section.default_effort.as_deref(),
                        thinking_keep.as_deref(),
                    ),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;

        self.validate_secondary_model_effort(
            section.default_effort.as_deref(),
            &models
                .iter()
                .map(|entry| entry.alias.as_str())
                .collect::<Vec<_>>(),
        )?;

        Ok(Some(SecondaryModelPool {
            force,
            default_model: default_model.to_string(),
            caller_model_alias: target_model
                .map(str::to_string)
                .or_else(|| self.default_model.clone()),
            models,
        }))
    }

    /// Resolve `[agent].multi_llm` into the engine's concurrent-provider race
    /// (`MultiLLM`, first-past-the-post). Each named entry is a `[models]`
    /// alias resolved through the same [`Self::extract_native_llm`] path the
    /// session model and the `[secondary_model]` pool use, so a racer carries
    /// a real native HTTP transport rather than a host proxy — the latter is
    /// what the race used to be limited to, and every config-reading entry
    /// point answers `host/llm_chat` with an error, so such a race could never
    /// produce a winner.
    ///
    /// `Ok(None)` when the key is absent or empty (the default: no race). An
    /// alias that cannot resolve is an error naming it, matching how the
    /// `[secondary_model]` pool reports an unresolvable entry, because
    /// silently dropping a racer would leave the user with a slower single
    /// provider and no explanation.
    pub fn extract_multi_llm(
        &self,
        _target_model: Option<&str>,
    ) -> Result<Option<Vec<ResolvedMultiLlmProvider>>, String> {
        let Some(aliases) = self.agent.multi_llm.as_ref() else {
            return Ok(None);
        };
        let aliases: Vec<String> = aliases
            .iter()
            .map(|alias| alias.trim().to_string())
            .filter(|alias| !alias.is_empty())
            .collect();
        if aliases.is_empty() {
            return Ok(None);
        }
        // A race of one is not a race: the single-provider case is the plain
        // session model, which `build_llm_for_spec` already handles. Refusing
        // it here keeps `providers` non-empty meaningful (it outranks
        // `native_llm`).
        if aliases.len() < 2 {
            return Err(
                "[agent].multi_llm needs at least two entries to race; a single provider should be set as default_model"
                    .into(),
            );
        }
        let thinking_keep = self.resolve_thinking_keep();
        let mut resolved = Vec::with_capacity(aliases.len());
        for alias in &aliases {
            let native = self.extract_native_llm(Some(alias)).ok_or_else(|| {
                format!(
                    "[agent].multi_llm entry \"{alias}\" could not be resolved: add it to [models] with a provider that has credentials."
                )
            })?;
            // Each racer carries its own declared effort: the entries are
            // different models with their own capabilities, so inheriting the
            // session model's effort would misconfigure them.
            let entry = self.models.get(alias).or_else(|| {
                self.models.values().find(|entry| {
                    entry
                        .aliases
                        .as_ref()
                        .is_some_and(|names| names.iter().any(|name| name == alias))
                })
            });
            let effort = entry.and_then(|entry| entry.default_effort.clone());
            resolved.push(ResolvedMultiLlmProvider {
                name: alias.clone(),
                llm: native_llm_config(native, effort.as_deref(), thinking_keep.as_deref()),
            });
        }
        Ok(Some(resolved))
    }

    /// Reject a pool-wide `default_effort` no pool model can run (v2 #3785
    /// `assertValidSubagentDefaultEffort`). The effort is applied to every
    /// entry of the pool, so one model that cannot honor it would silently
    /// degrade that subagent's thinking; failing at startup names the model
    /// instead. Runs after the pool resolves, so an unknown alias still
    /// reports as unresolvable rather than as an effort mismatch.
    fn validate_secondary_model_effort(
        &self,
        effort: Option<&str>,
        aliases: &[&str],
    ) -> Result<(), String> {
        let Some(effort) = effort
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_ascii_lowercase)
        else {
            return Ok(());
        };
        for alias in aliases {
            // The effort is checked against the effective record: an override
            // that adds or narrows `support_efforts` is what the model runs
            // with, so validating the base fields would reject a valid pool.
            let effective = self.models.get(*alias).map(ModelAliasConfig::effective);
            let model = effective.as_ref();
            if effort == "off" && model_always_thinks(model) {
                return Err(format!(
                    "[secondary_model].default_effort \"off\" cannot disable thinking for model \"{alias}\", which always reasons. Choose a concrete thinking effort instead of \"off\"."
                ));
            }
            if model_supports_effort(&effort, model) {
                continue;
            }
            if !model_supports_thinking(model) {
                return Err(format!(
                    "[secondary_model].default_effort \"{effort}\" is set but model \"{alias}\" does not support thinking."
                ));
            }
            let supported = model
                .and_then(|model| model.support_efforts.as_ref())
                .map(|efforts| efforts.join(", "))
                .unwrap_or_default();
            return Err(format!(
                "[secondary_model].default_effort \"{effort}\" is not supported by model \"{alias}\". Supported efforts: {supported}."
            ));
        }
        Ok(())
    }

    /// Resolve the per-step LLM attempt cap (v2 `resolveMaxAttemptsPerStep`):
    /// env `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP` > deprecated
    /// `KIMI_LOOP_MAX_RETRIES_PER_STEP` > `[loop_control].max_attempts_per_step`
    /// > the deprecated `max_retries_per_step`. `None` keeps the engine
    /// > default (10), so an unset section changes nothing.
    pub fn resolve_max_attempts_per_step(&self) -> Option<u32> {
        env_non_negative("KIMI_LOOP_MAX_ATTEMPTS_PER_STEP")
            .or_else(|| env_non_negative("KIMI_LOOP_MAX_RETRIES_PER_STEP"))
            .or(self.loop_control.max_attempts_per_step)
            .or(self.loop_control.max_retries_per_step)
    }

    /// Resolve the per-turn step cap (v2 `loopControl.maxStepsPerTurn`): env
    /// `KIMI_LOOP_MAX_STEPS_PER_TURN` > `[loop_control].max_steps_per_turn` >
    /// the deprecated `max_steps_per_run`. Unset or `0` means unlimited
    /// (v2 only enforces a positive cap), so both resolve to `None` and the
    /// engine keeps its own default.
    pub fn resolve_max_steps_per_turn(&self) -> Option<u32> {
        env_non_negative("KIMI_LOOP_MAX_STEPS_PER_TURN")
            .or(self.loop_control.max_steps_per_turn)
            .or(self.loop_control.max_steps_per_run)
            .filter(|value| *value > 0)
    }

    /// Resolve the total-request cap for one compaction round (v2 #3750
    /// `loopControl.compactionMaxAttempts`). Upstream binds no env var to this
    /// key, so the file is the only source. The schema floor is 1 (v2
    /// `z.number().int().min(1)`), so a `0` is ignored rather than read as "no
    /// attempts"; `None` keeps the engine default of
    /// [`crate::compaction::DEFAULT_COMPACTION_MAX_ATTEMPTS`].
    pub fn resolve_compaction_max_attempts(&self) -> Option<u32> {
        self.loop_control
            .compaction_max_attempts
            .filter(|value| *value > 0)
    }

    /// Resolve the preserved-thinking passthrough (v2 `resolveThinkingKeep`):
    /// env `KIMI_MODEL_THINKING_KEEP` > `[thinking].keep`. Off values
    /// (`false`/`0`/`no`/`off`/`none`/`null`) and `[thinking].enabled = false`
    /// resolve to `None`; unset stays `None` — the native wire is opt-in,
    /// unlike the host-proxy path's `"all"` default.
    pub fn resolve_thinking_keep(&self) -> Option<String> {
        if self.thinking.enabled == Some(false) {
            return None;
        }
        let raw = std::env::var("KIMI_MODEL_THINKING_KEEP")
            .ok()
            .or_else(|| self.thinking.keep.clone())?;
        let value = raw.trim();
        if value.is_empty()
            || matches!(
                value.to_ascii_lowercase().as_str(),
                "false" | "0" | "no" | "off" | "none" | "null"
            )
        {
            return None;
        }
        Some(value.to_string())
    }

    /// Resolve `[services.moonshot_search]` into the native WebSearch backend
    /// (v2 `isolateEnvServiceCredentials`: env `KIMI_WEB_SEARCH_BASE_URL` /
    /// `KIMI_WEB_SEARCH_API_KEY` over `config.toml`). An `oauth`-only entry
    /// (managed login) resolves without a credential, mirroring the host
    /// resolver; the tools then report or fall back accordingly.
    pub fn resolve_web_search_service(&self) -> Option<ResolvedWebService> {
        resolve_web_service(
            self.services.moonshot_search.as_ref(),
            "KIMI_WEB_SEARCH_BASE_URL",
            "KIMI_WEB_SEARCH_API_KEY",
        )
    }

    /// Resolve `[services.moonshot_fetch]` into the native FetchURL backend
    /// (env `KIMI_WEB_FETCH_BASE_URL` / `KIMI_WEB_FETCH_API_KEY` over
    /// `config.toml`).
    pub fn resolve_web_fetch_service(&self) -> Option<ResolvedWebService> {
        resolve_web_service(
            self.services.moonshot_fetch.as_ref(),
            "KIMI_WEB_FETCH_BASE_URL",
            "KIMI_WEB_FETCH_API_KEY",
        )
    }

    /// Resolve the per-`Agent` subagent timeout (v2
    /// `resolveSubagentTimeoutMs`): env `KIMI_SUBAGENT_TIMEOUT_MS` (a
    /// non-negative integer) over `[subagent].timeout_ms`. `None` keeps the
    /// engine default (2h); `0` is passed through and the tools treat it as
    /// the default, matching the host-driven paths.
    pub fn resolve_subagent_timeout_ms(&self) -> Option<u64> {
        env_non_negative_u64("KIMI_SUBAGENT_TIMEOUT_MS").or(self.subagent.timeout_ms)
    }

    /// Resolve the per-`AgentSwarm` subagent timeout (v2
    /// `resolveSwarmTimeoutMs`): env `KIMI_CODE_SWARM_TIMEOUT_MS` over
    /// `[swarm].timeout_ms`. A dedicated knob — swarms never inherit the
    /// subagent timeout.
    pub fn resolve_swarm_timeout_ms(&self) -> Option<u64> {
        env_non_negative_u64("KIMI_CODE_SWARM_TIMEOUT_MS").or(self.swarm.timeout_ms)
    }

    /// Resolve the raw-byte budget for model-initiated image reads (v2
    /// `resolveReadImageByteBudget`): env `KIMI_IMAGE_READ_BYTE_BUDGET` (a
    /// positive integer) over `[image].read_byte_budget`. `None` keeps the
    /// engine default (256KB).
    pub fn resolve_image_read_byte_budget(&self) -> Option<u64> {
        env_positive_u64("KIMI_IMAGE_READ_BYTE_BUDGET")
            .or(self.image.read_byte_budget.filter(|value| *value > 0))
    }

    /// Resolve the longest-edge ceiling for model-initiated image reads (v2
    /// `resolveMaxImageEdgePx`): env `KIMI_IMAGE_MAX_EDGE_PX` over
    /// `[image].max_edge_px`. `None` keeps the engine default (2000px).
    pub fn resolve_image_max_edge_px(&self) -> Option<u32> {
        env_positive_u64("KIMI_IMAGE_MAX_EDGE_PX")
            .and_then(|value| u32::try_from(value).ok())
            .or(self.image.max_edge_px.filter(|value| *value > 0))
    }

    /// Resolve the concurrent-background-task cap: env
    /// `KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS` over
    /// `[background].max_running_tasks` (the env var has priority, and a
    /// non-positive/invalid value is ignored). `None` keeps the engine
    /// default (unlimited).
    pub fn resolve_background_max_running_tasks(&self) -> Option<u32> {
        env_positive_u64("KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS")
            .and_then(|value| u32::try_from(value).ok())
            .or(self.background.max_running_tasks.filter(|value| *value > 0))
    }

    /// Resolve the default timeout for background Bash tasks (schema
    /// `[background].bash_task_timeout_s`). `None` keeps the tool's built-in
    /// ceiling; `Some(0)` means "no timeout".
    pub fn resolve_bash_task_timeout_s(&self) -> Option<u64> {
        self.background.bash_task_timeout_s
    }

    /// The whole `[background]` section, normalized, for the entries that read
    /// the file themselves and hand the knobs to one engine context
    /// (`PipelineSpec`): the host-driven entries pass the equivalent values as
    /// session params so every entry ends up with the same behavior.
    ///
    /// Each field is resolved as documented: `kill_grace_period_ms` and
    /// `bash_auto_background_on_timeout` pass through (unset = built-in),
    /// `max_running_tasks` honors `KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS`,
    /// and `bash_task_timeout_s` keeps `Some(0)` as "no timeout".
    pub fn background_limits(&self) -> crate::storage::BackgroundLimits {
        crate::storage::BackgroundLimits {
            kill_grace_period_ms: self.background.kill_grace_period_ms,
            max_running_tasks: self.resolve_background_max_running_tasks(),
            bash_auto_background_on_timeout: self.background.bash_auto_background_on_timeout,
            bash_task_timeout_s: self.resolve_bash_task_timeout_s(),
        }
    }

    /// The user's `extra_skill_dirs` as paths (schema): relative entries
    /// resolve against the current directory.
    pub fn extra_skill_dirs_paths(&self) -> Vec<PathBuf> {
        self.extra_skill_dirs
            .iter()
            .map(std::path::PathBuf::from)
            .collect()
    }

    /// Resolve the `merge_all_available_skills` switch (schema; docs
    /// `config-files.md`): unset means the documented default `true`, so an
    /// untouched file keeps merging every discovered skill directory.
    pub fn resolve_merge_all_available_skills(&self) -> bool {
        self.merge_all_available_skills.unwrap_or(true)
    }

    /// Resolve the thinking effort for the wire (schema `thinking.effort`,
    /// stored globally rather than per model): the off-effort when the model
    /// declares one and thinking is disabled, else the chosen effort.
    pub fn resolve_effort(&self, model_off_effort: Option<&str>) -> Option<String> {
        let enabled = self.thinking.enabled.unwrap_or(true);
        if !enabled {
            return model_off_effort.map(str::to_string);
        }
        self.thinking
            .effort
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    /// Build a [`PolicySnapshot`] from the configuration.
    pub fn build_policy_snapshot(&self, git_cwd: Option<PathBuf>) -> PolicySnapshot {
        // `[agent].yolo` (or the flat top-level `yolo`) wins, then
        // `[permission].mode`, then the top-level `default_permission_mode`
        // (schema); manual is the fallback.
        let mode = if self.agent.yolo == Some(true) || self.yolo == Some(true) {
            PermissionMode::Yolo
        } else {
            let declared = self
                .permission
                .as_ref()
                .and_then(|p| p.mode.as_deref())
                .or(self.default_permission_mode.as_deref());
            match declared {
                Some("yolo") => PermissionMode::Yolo,
                Some("auto") => PermissionMode::Auto,
                _ => PermissionMode::Manual,
            }
        };

        let mut deny_rules = Vec::new();
        let mut ask_rules = Vec::new();
        let mut allow_rules = Vec::new();

        let mut rule_reasons = std::collections::HashMap::new();
        if let Some(ref p) = self.permission
            && let Some(ref rules) = p.rules
        {
            for r in rules {
                let pattern = match r.pattern.as_deref() {
                    Some(p) => p.to_string(),
                    None => continue,
                };
                if let Some(why) = r
                    .reason
                    .as_deref()
                    .map(str::trim)
                    .filter(|why| !why.is_empty())
                {
                    rule_reasons.insert(pattern.clone(), why.to_string());
                }
                match r.decision.as_deref() {
                    Some("deny") => deny_rules.push(pattern),
                    Some("ask") => ask_rules.push(pattern),
                    Some("allow") => allow_rules.push(pattern),
                    _ => {}
                }
            }
        }

        // The global `[tools]` switch: an empty pair of lists constrains
        // nothing, so it stays `None` and every tool survives.
        let tools_filter = if self.tools.enabled.is_empty() && self.tools.disabled.is_empty() {
            None
        } else {
            Some(crate::tools::tool_policy::ToolsFilter {
                enabled: self.tools.enabled.clone(),
                disabled: self.tools.disabled.clone(),
            })
        };

        PolicySnapshot {
            mode,
            deny_rules,
            ask_rules,
            allow_rules,
            session_approvals: Vec::new(),
            git_cwd: git_cwd.map(|p| p.to_string_lossy().to_string()),
            tools_filter,
            pre_tool_hooks: self.hooks.clone(),
            rule_reasons,
            non_interactive: false,
            // v2 env binding (`KIMI_CODE_DANGEROUS_COMMAND_GUARD`): only the
            // literal `true` / `false` overrides the file setting; anything
            // else leaves the config in charge (`parseDangerousCommandGuardEnv`).
            dangerous_command_guard: match std::env::var("KIMI_CODE_DANGEROUS_COMMAND_GUARD") {
                Ok(v) if v == "true" => true,
                Ok(v) if v == "false" => false,
                _ => self
                    .permission
                    .as_ref()
                    .and_then(|p| p.dangerous_command_guard)
                    .unwrap_or(true),
            },
        }
    }
}

/// `merge_all_available_skills` as the process config resolves it — `true` when
/// no config file is discoverable (the documented default).
///
/// The prompt builder and the `Skill` tool must read the **same** value: an
/// entry that builds a [`PipelineSpec`] without a loaded config (the addon, the
/// stdio run-turn adapter) resolves it here, so both halves of the pair agree.
///
/// [`PipelineSpec`]: crate::pipeline::PipelineSpec
pub fn resolved_merge_all_available_skills() -> bool {
    KimiConfig::discover()
        .map(|(config, _)| config.resolve_merge_all_available_skills())
        .unwrap_or(true)
}

/// A non-blank trimmed string (v2 `nonBlankEnv` / `nonEmptyString`).
fn non_blank(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Resolve one `[services.moonshot_*]` entry with its `KIMI_WEB_*` env
/// overlay (v2 `isolateEnvServiceCredentials`): an env base URL is a
/// credential boundary — persisted api keys and custom headers never cross
/// into an env-selected endpoint — otherwise the env api key outranks the
/// persisted one. A missing (or blank) base URL resolves to `None`, leaving
/// the tool on its built-in path.
fn resolve_web_service(
    service: Option<&MoonshotServiceConfig>,
    base_url_env: &str,
    api_key_env: &str,
) -> Option<ResolvedWebService> {
    let env_base_url = non_blank(std::env::var(base_url_env).ok().as_deref());
    let env_api_key = non_blank(std::env::var(api_key_env).ok().as_deref());
    if let Some(base_url) = env_base_url {
        return Some(ResolvedWebService {
            base_url,
            api_key: env_api_key,
            custom_headers: HashMap::new(),
        });
    }
    let service = service?;
    let base_url = non_blank(service.base_url.as_deref())?;
    Some(ResolvedWebService {
        base_url,
        api_key: env_api_key.or_else(|| non_blank(service.api_key.as_deref())),
        custom_headers: service.custom_headers.clone().unwrap_or_default(),
    })
}

/// One provider type's endpoint declaration (v2 `ProtocolEndpoint`,
/// `human/llm/protocol/connection.ts`, with the registrations in
/// `llm-adapter/provider/provider-definition.ts` and
/// `human/llm/provider/providers/standard.ts`). `base_url_env` is the
/// process-environment variable the type falls back to when the config
/// declares no endpoint; `default_base_url` is the vendor SDK's own default,
/// which the engine has to carry itself because it assembles the request URL
/// rather than handing it to an SDK.
struct EndpointDeclaration {
    base_url_env: &'static str,
    default_base_url: Option<&'static str>,
}

/// The endpoint declaration for a provider type, or `None` for a type the
/// engine has no declaration for.
///
/// `vertexai` is deliberately absent: the engine has no Vertex wire protocol
/// — a Vertex provider resolves on the OpenAI one — so honoring
/// `GOOGLE_VERTEX_BASE_URL` here would pull traffic the host layer serves
/// correctly into a mis-shaped request. Vertex stays on the host proxy.
fn endpoint_declaration(provider_type: &str) -> Option<EndpointDeclaration> {
    let declaration = match provider_type {
        // v2 `kimiConnection` (`human/llm-kimi/trait.ts`).
        "kimi" => EndpointDeclaration {
            base_url_env: "KIMI_BASE_URL",
            default_base_url: Some("https://api.moonshot.ai/v1"),
        },
        // v2 `anthropicConnection`; the SDK's own default is the API root.
        "anthropic" => EndpointDeclaration {
            base_url_env: "ANTHROPIC_BASE_URL",
            default_base_url: Some("https://api.anthropic.com"),
        },
        // v2 `openAIConnection`, shared by the Responses protocol.
        "openai" | "openai_responses" | "openai-responses" => EndpointDeclaration {
            base_url_env: "OPENAI_BASE_URL",
            default_base_url: Some("https://api.openai.com/v1"),
        },
        // v2 `geminiEndpoint`; the SDK default is the host root.
        "google" | "google-genai" | "gemini" => EndpointDeclaration {
            base_url_env: "GOOGLE_GEMINI_BASE_URL",
            default_base_url: Some("https://generativelanguage.googleapis.com"),
        },
        _ => return None,
    };
    Some(declaration)
}

/// The base URL a provider falls back to when the config declares none (v2
/// `resolveModelConnection`): the type's `baseUrlEnv` read from the process
/// environment — a blank value counts as unset, same as v2's `read` — then
/// the type's default.
fn endpoint_fallback_base_url(provider_type: &str) -> Option<String> {
    let declaration = endpoint_declaration(provider_type)?;
    non_blank(std::env::var(declaration.base_url_env).ok().as_deref())
        .or_else(|| declaration.default_base_url.map(str::to_string))
}

fn normalize_base_url(url: &str, protocol: &str) -> String {
    let trimmed = url.trim_end_matches('/');
    // GenerateContent lives under an API version segment, and the documented
    // contract is host-root-only — see [`crate::llm::http::google_api_base`],
    // which the endpoint builder also applies.
    if protocol == "google" || protocol == "google-genai" || protocol == "gemini" {
        return crate::llm::http::google_api_base(trimmed);
    }
    if protocol == "anthropic" {
        if trimmed.ends_with("/v1") {
            trimmed.to_string()
        } else {
            format!("{trimmed}/v1")
        }
    } else if trimmed.ends_with("/v1") || trimmed.ends_with("/v1/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1")
    }
}

/// Whether a `[models.<alias>]` entry declares thinking support (v2
/// `modelSupportsThinking`): the `thinking` / `always_thinking` capability, or
/// an explicit `adaptive_thinking`. The fork carries `always_thinking` as a
/// capability string rather than a field of its own.
fn model_supports_thinking(alias: Option<&ModelAliasConfig>) -> bool {
    alias.is_some_and(|alias| {
        alias.adaptive_thinking == Some(true)
            || model_capabilities(alias).any(is_thinking_capability)
    })
}

/// Whether the entry declares that it cannot stop reasoning (v2
/// `alwaysThinking`).
fn model_always_thinks(alias: Option<&ModelAliasConfig>) -> bool {
    alias.is_some_and(|alias| {
        model_capabilities(alias).any(|capability| capability == "always_thinking")
    })
}

/// v2 `modelSupportsThinkingEffort(effort, model, true)`: `off` is always
/// accepted, a model without thinking support never is, and an empty effort
/// list means "any effort". Declared efforts are compared verbatim (upstream
/// only normalizes the requested side).
fn model_supports_effort(effort: &str, alias: Option<&ModelAliasConfig>) -> bool {
    if effort == "off" {
        return true;
    }
    if !model_supports_thinking(alias) {
        return false;
    }
    let efforts: Vec<&str> = alias
        .and_then(|alias| alias.support_efforts.as_ref())
        .map(|efforts| {
            efforts
                .iter()
                .map(|effort| effort.trim())
                .filter(|effort| !effort.is_empty())
                .collect()
        })
        .unwrap_or_default();
    efforts.is_empty() || effort == "on" || efforts.contains(&effort)
}

fn model_capabilities(alias: &ModelAliasConfig) -> impl Iterator<Item = &str> {
    alias
        .capabilities
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|capability| capability.trim())
}

fn is_thinking_capability(capability: &str) -> bool {
    capability == "thinking" || capability == "always_thinking"
}

/// The dotted alias a malformed `[models]` entry was probably meant to be: the
/// first nested table it carries, walked to its deepest level. `None` when the
/// entry has no nested table at all.
fn dotted_alias_suffix(alias: &str, entry: &toml::value::Table) -> Option<String> {
    for (key, value) in entry {
        let Some(nested) = value.as_table() else {
            continue;
        };
        return Some(
            dotted_alias_suffix(&format!("{alias}.{key}"), nested)
                .unwrap_or_else(|| format!("{alias}.{key}")),
        );
    }
    None
}

/// Convert one resolved native model into the wire config, applying the
/// pool-level `default_effort` the way the host's `resolveNativeLlmForAlias`
/// does: an anthropic entry gets a thinking budget, an OpenAI-compatible one
/// the `reasoning_effort` passthrough (off values never enable thinking).
/// `thinking_keep` rides every entry, exactly as the host sets it.
fn native_llm_config(
    resolved: ResolvedNativeLlm,
    effort: Option<&str>,
    thinking_keep: Option<&str>,
) -> NativeLlmConfig {
    let mut llm = NativeLlmConfig {
        protocol: resolved.protocol,
        base_url: resolved.base_url,
        api_key: resolved.api_key,
        api_key_env: None,
        model: resolved.model,
        max_tokens: resolved.max_tokens,
        custom_headers: Default::default(),
        reasoning_effort: None,
        thinking_budget: None,
        auth_provider: None,
        thinking_keep: thinking_keep.map(str::to_string),
        beta_api: resolved.beta_api,
        capabilities: resolved.capabilities,
        system_prompt: resolved.system_prompt,
        max_input_size: resolved.max_input_size,
        adaptive_thinking: resolved.adaptive_thinking,
        reasoning_key: resolved.reasoning_key,
        off_effort: resolved.off_effort,
    };
    if let Some(effort) = effort
        && effort != "off"
        && effort != "none"
    {
        if llm.protocol == "anthropic" {
            llm.thinking_budget = Some(match effort {
                "low" => 1024,
                "medium" => 4096,
                "high" | "on" => 32000,
                other => other
                    .parse::<u32>()
                    .ok()
                    .filter(|value| *value > 0)
                    .unwrap_or(32000),
            });
        } else {
            llm.reasoning_effort = Some(effort.to_string());
        }
    }
    llm
}

pub(crate) fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Parse a non-negative integer environment variable (v2 `nonNegativeInt`):
/// an invalid value is ignored so a bad entry degrades to the next source
/// instead of failing the session.
fn env_non_negative(name: &str) -> Option<u32> {
    std::env::var(name).ok()?.trim().parse::<u32>().ok()
}

/// The `u64` sibling of [`env_non_negative`] for millisecond timeouts.
fn env_non_negative_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok()?.trim().parse::<u64>().ok()
}

/// A positive integer environment variable (v2 `positiveInt`): zero and
/// invalid values are ignored so the next source applies.
fn env_positive_u64(name: &str) -> Option<u64> {
    env_non_negative_u64(name).filter(|value| *value > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    const SAMPLE_CONFIG: &str = r#"
default_model = "kimi-k2"

[providers.kimi]
type = "openai"
api_key = "sk-kimi-key"
base_url = "https://api.moonshot.cn/v1"

[providers.anthropic]
type = "anthropic"
api_key = "sk-ant-key"
base_url = "https://api.anthropic.com"

[models.kimi-k2]
provider = "kimi"
model = "kimi-k2-0711"
system_prompt = "You are Kimi."

[agent]
engine = "rust"
native_tools = true
yolo = false

[permission]
mode = "manual"

[[permission.rules]]
decision = "deny"
pattern = "Write(secret.txt)"

[[permission.rules]]
decision = "allow"
pattern = "Read(*)"
"#;

    #[test]
    fn provider_env_binding_survives_config_roundtrip() {
        let config = KimiConfig::from_str(
            "[providers.example]\ntype = \"openai\"\napi_key_env = \"EXAMPLE_API_KEY\"\n",
        )
        .unwrap();
        let provider = &config.providers["example"];
        let value = serde_json::to_value(provider).unwrap();
        assert_eq!(value["api_key_env"], "EXAMPLE_API_KEY");
        assert!(provider.api_key.is_none());
        let encoded = toml::to_string(provider).unwrap();
        let restored: ProviderConfig = toml::from_str(&encoded).unwrap();
        assert_eq!(
            serde_json::to_value(restored).unwrap()["api_key_env"],
            "EXAMPLE_API_KEY"
        );
    }

    #[test]
    fn test_parse_sample_config() {
        let config = KimiConfig::from_str(SAMPLE_CONFIG).unwrap();
        assert_eq!(config.default_model.as_deref(), Some("kimi-k2"));
        assert_eq!(config.agent.native_tools, Some(true));

        let native_llm = config.extract_native_llm(None).unwrap();
        assert_eq!(native_llm.protocol, "openai");
        assert_eq!(native_llm.base_url, "https://api.moonshot.cn/v1");
        assert_eq!(native_llm.api_key, "sk-kimi-key");
        assert_eq!(native_llm.model, "kimi-k2-0711");

        let policy = config.build_policy_snapshot(None);
        assert_eq!(policy.mode, PermissionMode::Manual);
        assert_eq!(policy.deny_rules, vec!["Write(secret.txt)"]);
        assert_eq!(policy.allow_rules, vec!["Read(*)"]);
    }

    #[test]
    fn test_extract_anthropic_llm() {
        let config = KimiConfig::from_str(SAMPLE_CONFIG).unwrap();
        let native_llm = config.extract_native_llm(Some("anthropic")).unwrap();
        assert_eq!(native_llm.protocol, "anthropic");
        assert_eq!(native_llm.base_url, "https://api.anthropic.com/v1");
        assert_eq!(native_llm.api_key, "sk-ant-key");
    }

    /// A one-provider config whose provider carries a credential but no
    /// endpoint, so the provider type's env/default chain is what resolves.
    fn endpoint_less_config(provider_type: &str) -> KimiConfig {
        KimiConfig::from_str(&format!(
            r#"
default_model = "m"

[providers.p]
type = "{provider_type}"
api_key = "sk-x"

[models.m]
provider = "p"
model = "some-model"
"#
        ))
        .unwrap()
    }

    #[test]
    fn anthropic_endpoint_falls_back_to_env_then_default() {
        let keys = ["ANTHROPIC_BASE_URL"];
        let saved: Vec<Option<String>> = keys.iter().map(|key| std::env::var(key).ok()).collect();
        unsafe {
            for key in keys {
                std::env::remove_var(key);
            }
        }

        // No declared endpoint and no env: the SDK default, carried by the
        // engine because it assembles the URL itself.
        let native = endpoint_less_config("anthropic")
            .extract_native_llm(None)
            .unwrap();
        assert_eq!(native.protocol, "anthropic");
        assert_eq!(native.base_url, "https://api.anthropic.com/v1");

        // The env endpoint wins over the default and rides the same
        // normalization a declared `base_url` does.
        unsafe { std::env::set_var("ANTHROPIC_BASE_URL", "https://ant-proxy.example.com") };
        let native = endpoint_less_config("anthropic")
            .extract_native_llm(None)
            .unwrap();
        assert_eq!(native.base_url, "https://ant-proxy.example.com/v1");

        // A blank env value counts as unset (v2 `read`), so the default stands.
        unsafe { std::env::set_var("ANTHROPIC_BASE_URL", "   ") };
        let native = endpoint_less_config("anthropic")
            .extract_native_llm(None)
            .unwrap();
        assert_eq!(native.base_url, "https://api.anthropic.com/v1");

        // A declared endpoint outranks the env variable.
        let declared = KimiConfig::from_str(
            r#"
default_model = "m"

[providers.p]
type = "anthropic"
base_url = "https://declared.example.com"
api_key = "sk-x"

[models.m]
provider = "p"
model = "some-model"
"#,
        )
        .unwrap();
        let native = declared.extract_native_llm(None).unwrap();
        assert_eq!(native.base_url, "https://declared.example.com/v1");

        unsafe {
            for (key, value) in keys.iter().zip(saved) {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    #[test]
    fn openai_endpoint_falls_back_to_env_then_default() {
        let keys = ["OPENAI_BASE_URL"];
        let saved: Vec<Option<String>> = keys.iter().map(|key| std::env::var(key).ok()).collect();
        unsafe {
            for key in keys {
                std::env::remove_var(key);
            }
        }

        let native = endpoint_less_config("openai")
            .extract_native_llm(None)
            .unwrap();
        assert_eq!(native.protocol, "openai");
        assert_eq!(native.base_url, "https://api.openai.com/v1");

        unsafe { std::env::set_var("OPENAI_BASE_URL", "https://oai-proxy.example.com/v1") };
        let native = endpoint_less_config("openai")
            .extract_native_llm(None)
            .unwrap();
        assert_eq!(native.base_url, "https://oai-proxy.example.com/v1");

        // The Responses protocol shares the OpenAI declaration.
        unsafe { std::env::set_var("OPENAI_BASE_URL", "   ") };
        let native = endpoint_less_config("openai_responses")
            .extract_native_llm(None)
            .unwrap();
        assert_eq!(native.protocol, "openai_responses");
        assert_eq!(native.base_url, "https://api.openai.com/v1");

        unsafe {
            for (key, value) in keys.iter().zip(saved) {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    #[test]
    fn kimi_endpoint_falls_back_to_env_then_default() {
        let keys = ["KIMI_BASE_URL"];
        let saved: Vec<Option<String>> = keys.iter().map(|key| std::env::var(key).ok()).collect();
        unsafe {
            for key in keys {
                std::env::remove_var(key);
            }
        }

        let native = endpoint_less_config("kimi")
            .extract_native_llm(None)
            .unwrap();
        assert_eq!(native.protocol, "openai");
        assert_eq!(native.base_url, "https://api.moonshot.ai/v1");

        unsafe { std::env::set_var("KIMI_BASE_URL", "https://kimi-proxy.example.com") };
        let native = endpoint_less_config("kimi")
            .extract_native_llm(None)
            .unwrap();
        assert_eq!(native.base_url, "https://kimi-proxy.example.com/v1");

        unsafe {
            for (key, value) in keys.iter().zip(saved) {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    #[test]
    fn google_genai_endpoint_prefers_the_env_over_the_host_root() {
        let keys = ["GOOGLE_GEMINI_BASE_URL"];
        let saved: Vec<Option<String>> = keys.iter().map(|key| std::env::var(key).ok()).collect();
        unsafe {
            for key in keys {
                std::env::remove_var(key);
            }
        }

        let native = endpoint_less_config("google-genai")
            .extract_native_llm(None)
            .unwrap();
        assert_eq!(native.protocol, "google-genai");
        assert_eq!(
            native.base_url,
            "https://generativelanguage.googleapis.com/v1beta"
        );

        unsafe { std::env::set_var("GOOGLE_GEMINI_BASE_URL", "https://gem-proxy.example.com") };
        let native = endpoint_less_config("google-genai")
            .extract_native_llm(None)
            .unwrap();
        assert_eq!(native.base_url, "https://gem-proxy.example.com/v1beta");

        unsafe {
            for (key, value) in keys.iter().zip(saved) {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    #[test]
    fn undeclared_provider_type_without_an_endpoint_does_not_resolve() {
        // A type the engine has no endpoint declaration for keeps the old
        // behavior: without a declared `base_url` the model does not resolve
        // natively and the host proxy takes it.
        assert!(
            endpoint_less_config("deepseek")
                .extract_native_llm(None)
                .is_none()
        );
    }

    #[test]
    fn oauth_bound_provider_resolves_without_a_static_key() {
        let config = KimiConfig::from_str(
            r#"
default_model = "managed"

[providers.managed]
type = "openai"
base_url = "https://api.kimi.com/v1"
oauth = { provider = "kimi" }

[models.managed]
provider = "managed"
model = "kimi-k2-0711"
"#,
        )
        .unwrap();
        let native = config.extract_native_llm(None).unwrap();
        assert_eq!(native.api_key, "");
        assert_eq!(native.auth_provider.as_deref(), Some("managed"));
    }

    #[test]
    fn provider_without_key_or_oauth_does_not_resolve() {
        let config = KimiConfig::from_str(
            r#"
default_model = "naked"

[providers.naked]
type = "openai"
base_url = "https://api.example.com/v1"

[models.naked]
provider = "naked"
model = "some-model"
"#,
        )
        .unwrap();
        assert!(config.extract_native_llm(None).is_none());
    }

    #[test]
    fn top_level_yolo_resolves_to_yolo_mode() {
        // v1 flat form.
        let flat = KimiConfig::from_str("yolo = true\n").unwrap();
        assert_eq!(flat.build_policy_snapshot(None).mode, PermissionMode::Yolo);
        // The sectioned form keeps working.
        let sectioned = KimiConfig::from_str("[agent]\nyolo = true\n").unwrap();
        assert_eq!(
            sectioned.build_policy_snapshot(None).mode,
            PermissionMode::Yolo
        );
    }

    #[test]
    fn top_level_plan_mode_and_default_plan_mode_parse() {
        let config = KimiConfig::from_str("plan_mode = true\ndefault_plan_mode = true\n").unwrap();
        assert_eq!(config.plan_mode, Some(true));
        assert_eq!(config.default_plan_mode, Some(true));
        // camelCase aliases (the document schema's spelling).
        let camel = KimiConfig::from_str("planMode = true\ndefaultPlanMode = true\n").unwrap();
        assert_eq!(camel.plan_mode, Some(true));
        assert_eq!(camel.default_plan_mode, Some(true));
    }

    #[test]
    fn model_catalog_and_telemetry_parse() {
        let config = KimiConfig::from_str(
            "telemetry = true\n\n[model_catalog]\nrefresh_interval_ms = 3600000\nrefresh_on_start = true\n",
        )
        .unwrap();
        assert_eq!(config.telemetry, Some(true));
        let catalog = config.model_catalog.expect("model_catalog parsed");
        assert_eq!(catalog.refresh_interval_ms, Some(3_600_000));
        assert_eq!(catalog.refresh_on_start, Some(true));
    }

    #[test]
    fn auto_session_title_parses_and_defaults_to_enabled() {
        // Absent means enabled (upstream #3962: only an explicit false
        // disables); both spellings parse.
        let absent = KimiConfig::from_str("yolo = true\n").unwrap();
        assert_eq!(absent.auto_session_title, None);
        let off = KimiConfig::from_str("auto_session_title = false\n").unwrap();
        assert_eq!(off.auto_session_title, Some(false));
        let camel = KimiConfig::from_str("autoSessionTitle = false\n").unwrap();
        assert_eq!(camel.auto_session_title, Some(false));
    }

    const POOL_CONFIG: &str = r#"
default_model = "kimi-k2"

[providers.kimi]
type = "openai"
api_key = "sk-kimi-key"
base_url = "https://api.moonshot.cn/v1"

[providers.anthropic]
type = "anthropic"
api_key = "sk-ant-key"
base_url = "https://api.anthropic.com"

[models.kimi-k2]
provider = "kimi"
model = "kimi-k2-0711"
capabilities = ["thinking"]

[models.fast]
provider = "kimi"
model = "kimi-k2-fast"
capabilities = ["thinking"]

[models.thinky]
provider = "anthropic"
model = "claude-sonnet"
capabilities = ["thinking"]
"#;

    #[test]
    fn test_extract_secondary_model_pool() {
        let config = KimiConfig::from_str(&format!(
            r#"{POOL_CONFIG}
[secondary_model]
default_model = "fast"
default_effort = "high"

[secondary_model.models]
"kimi-k2" = "Hard problems."
"fast" = "Cheap and quick."
"thinky" = ""
"#
        ))
        .unwrap();
        let pool = config.extract_secondary_model_pool(None).unwrap().unwrap();
        assert!(!pool.force);
        assert_eq!(pool.default_model, "fast");
        assert_eq!(pool.caller_model_alias.as_deref(), Some("kimi-k2"));

        let fast = pool
            .models
            .iter()
            .find(|entry| entry.alias == "fast")
            .unwrap();
        assert_eq!(fast.hint, "Cheap and quick.");
        assert_eq!(fast.llm.model, "kimi-k2-fast");
        assert_eq!(fast.llm.reasoning_effort.as_deref(), Some("high"));

        let thinky = pool
            .models
            .iter()
            .find(|entry| entry.alias == "thinky")
            .unwrap();
        assert_eq!(thinky.llm.protocol, "anthropic");
        assert_eq!(thinky.llm.thinking_budget, Some(32000));

        // The session's own alias (`--model`) wins the `[main model]` marker.
        let pool = config
            .extract_secondary_model_pool(Some("thinky"))
            .unwrap()
            .unwrap();
        assert_eq!(pool.caller_model_alias.as_deref(), Some("thinky"));
    }

    /// `[agent].multi_llm` resolves each named alias into a native transport.
    /// That is what makes the race runnable at all: a racer without one is a
    /// host proxy, and every config-reading entry point answers `host/llm_chat`
    /// with an error, so such a race can never produce a winner.
    #[test]
    fn test_extract_multi_llm_resolves_native_racers() {
        let config = KimiConfig::from_str(
            r#"
default_model = "kimi-k2"

[providers.kimi]
type = "openai"
api_key = "sk-kimi-key"
base_url = "https://api.moonshot.cn/v1"

[providers.anthropic]
type = "anthropic"
api_key = "sk-ant-key"
base_url = "https://api.anthropic.com"

[models.kimi-k2]
provider = "kimi"
model = "kimi-k2-0711"
default_effort = "high"
capabilities = ["thinking"]

[models.thinky]
provider = "anthropic"
model = "claude-sonnet"
capabilities = ["thinking"]

[agent]
multi_llm = ["kimi-k2", "thinky"]
"#,
        )
        .unwrap();
        let racers = config.extract_multi_llm(None).unwrap().unwrap();
        assert_eq!(racers.len(), 2);

        let kimi = racers.iter().find(|racer| racer.name == "kimi-k2").unwrap();
        assert_eq!(kimi.llm.model, "kimi-k2-0711");
        assert_eq!(kimi.llm.protocol, "openai");
        // The alias's own declared effort rides its transport, not the session's.
        assert_eq!(kimi.llm.reasoning_effort.as_deref(), Some("high"));

        let thinky = racers.iter().find(|racer| racer.name == "thinky").unwrap();
        assert_eq!(thinky.llm.protocol, "anthropic");
        // `thinky` declares none, so it carries none — the racers are different
        // models with their own capabilities and must not inherit each other's.
        assert!(thinky.llm.reasoning_effort.is_none());
        assert!(thinky.llm.thinking_budget.is_none());
    }

    #[test]
    fn test_extract_multi_llm_absent_and_inert_cases() {
        // Absent key: no race, which is the default.
        let bare = KimiConfig::from_str(POOL_CONFIG).unwrap();
        assert!(bare.extract_multi_llm(None).unwrap().is_none());

        // An empty list is inert rather than a one-racer race.
        let empty = KimiConfig::from_str(&format!(
            r#"{POOL_CONFIG}
[agent]
multi_llm = []
"#
        ))
        .unwrap();
        assert!(empty.extract_multi_llm(None).unwrap().is_none());

        // Blank entries are trimmed away, so `["", "fast"]` is a lone racer.
        let blanks = KimiConfig::from_str(&format!(
            r#"{POOL_CONFIG}
[agent]
multi_llm = ["", "  "]
"#
        ))
        .unwrap();
        assert!(blanks.extract_multi_llm(None).unwrap().is_none());
    }

    #[test]
    fn test_extract_multi_llm_rejects_a_lone_racer_and_unknown_alias() {
        // One entry is not a race; silently racing a single provider would let
        // `providers` outrank `native_llm` for no benefit.
        let lone = KimiConfig::from_str(&format!(
            r#"{POOL_CONFIG}
[agent]
multi_llm = ["kimi-k2"]
"#
        ))
        .unwrap();
        let error = lone.extract_multi_llm(None).unwrap_err();
        assert!(error.contains("at least two"), "unexpected error: {error}");

        // An alias that cannot resolve names itself instead of being dropped.
        let unknown = KimiConfig::from_str(&format!(
            r#"{POOL_CONFIG}
[agent]
multi_llm = ["kimi-k2", "not-a-model"]
"#
        ))
        .unwrap();
        let error = unknown.extract_multi_llm(None).unwrap_err();
        assert!(
            error.contains("not-a-model"),
            "the unresolvable alias must be named: {error}"
        );
    }

    #[test]
    fn test_secondary_model_pool_shapes_and_errors() {
        let lone = KimiConfig::from_str(&format!(
            r#"{POOL_CONFIG}
[secondary_model]
default_model = "fast"
"#
        ))
        .unwrap();
        let pool = lone.extract_secondary_model_pool(None).unwrap().unwrap();
        assert_eq!(pool.default_model, "fast");
        assert_eq!(pool.models.len(), 1);
        assert_eq!(pool.models[0].alias, "fast");
        assert_eq!(pool.models[0].hint, "");

        let recipe = KimiConfig::from_str(&format!(
            r#"{POOL_CONFIG}
[secondary_model]
model = "fast"
"#
        ))
        .unwrap();
        let pool = recipe.extract_secondary_model_pool(None).unwrap().unwrap();
        assert_eq!(pool.default_model, "fast");
        assert_eq!(pool.models.len(), 1);

        // A section with no pool keys (patch-only recipe) stays inert.
        let inert = KimiConfig::from_str(&format!(
            r#"{POOL_CONFIG}
[secondary_model]
default_effort = "high"
"#
        ))
        .unwrap();
        assert!(inert.extract_secondary_model_pool(None).unwrap().is_none());
        assert!(
            KimiConfig::from_str(SAMPLE_CONFIG)
                .unwrap()
                .extract_secondary_model_pool(None)
                .unwrap()
                .is_none()
        );

        let unknown_default = KimiConfig::from_str(&format!(
            r#"{POOL_CONFIG}
[secondary_model]
default_model = "missing"

[secondary_model.models]
"fast" = ""
"#
        ))
        .unwrap();
        let error = unknown_default
            .extract_secondary_model_pool(None)
            .unwrap_err();
        assert!(
            error.contains("is not a [secondary_model.models] key"),
            "{error}"
        );

        let force_with_table = KimiConfig::from_str(&format!(
            r#"{POOL_CONFIG}
[secondary_model]
default_model = "fast"
force = true

[secondary_model.models]
"fast" = ""
"#
        ))
        .unwrap();
        let error = force_with_table
            .extract_secondary_model_pool(None)
            .unwrap_err();
        assert!(error.contains("force cannot be combined"), "{error}");

        let force_without_default = KimiConfig::from_str(&format!(
            r#"{POOL_CONFIG}
[secondary_model]
force = true
"#
        ))
        .unwrap();
        let error = force_without_default
            .extract_secondary_model_pool(None)
            .unwrap_err();
        assert!(
            error.contains("required when [secondary_model].force is set"),
            "{error}"
        );

        let reserved = KimiConfig::from_str(&format!(
            r#"{POOL_CONFIG}
[secondary_model]
default_model = "primary"

[secondary_model.models]
primary = ""
"#
        ))
        .unwrap();
        let error = reserved.extract_secondary_model_pool(None).unwrap_err();
        assert!(error.contains("reserved"), "{error}");

        let unresolvable = KimiConfig::from_str(&format!(
            r#"{POOL_CONFIG}
[secondary_model]
default_model = "nope"

[secondary_model.models]
"nope" = ""
"#
        ))
        .unwrap();
        let error = unresolvable.extract_secondary_model_pool(None).unwrap_err();
        assert!(error.contains("could not be resolved"), "{error}");
    }

    #[test]
    fn test_resolve_max_attempts_per_step() {
        let keys = [
            "KIMI_LOOP_MAX_ATTEMPTS_PER_STEP",
            "KIMI_LOOP_MAX_RETRIES_PER_STEP",
        ];
        let saved: Vec<Option<String>> = keys.iter().map(|key| std::env::var(key).ok()).collect();
        // The env vars outrank the file: clear them first so the config-only
        // precedence below is not poisoned by the developer's shell.
        unsafe {
            for key in keys {
                std::env::remove_var(key);
            }
        }

        let explicit = KimiConfig::from_str(
            r#"
[loop_control]
max_attempts_per_step = 3
"#,
        )
        .unwrap();
        assert_eq!(explicit.resolve_max_attempts_per_step(), Some(3));

        // The deprecated spelling still resolves, but the current key wins.
        let deprecated = KimiConfig::from_str(
            r#"
[loop_control]
max_retries_per_step = 5
"#,
        )
        .unwrap();
        assert_eq!(deprecated.resolve_max_attempts_per_step(), Some(5));

        let both = KimiConfig::from_str(
            r#"
[loop_control]
max_attempts_per_step = 3
max_retries_per_step = 5
"#,
        )
        .unwrap();
        assert_eq!(both.resolve_max_attempts_per_step(), Some(3));

        // An absent (or empty) section keeps the engine default.
        assert_eq!(
            KimiConfig::from_str(SAMPLE_CONFIG)
                .unwrap()
                .resolve_max_attempts_per_step(),
            None
        );
        assert_eq!(
            KimiConfig::from_str("[loop_control]\n")
                .unwrap()
                .resolve_max_attempts_per_step(),
            None
        );

        unsafe {
            std::env::set_var(keys[0], "7");
            std::env::set_var(keys[1], "9");
        }
        assert_eq!(both.resolve_max_attempts_per_step(), Some(7), "env wins");
        unsafe { std::env::remove_var(keys[0]) };
        assert_eq!(
            both.resolve_max_attempts_per_step(),
            Some(9),
            "the deprecated env is the next source"
        );
        unsafe { std::env::remove_var(keys[1]) };
        assert_eq!(both.resolve_max_attempts_per_step(), Some(3), "config next");

        unsafe {
            for (key, value) in keys.iter().zip(saved) {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    /// v2 #3750: `[loop_control].compaction_max_attempts` caps one compaction
    /// round's total requests. Upstream binds no env var to the key, so the
    /// file is the only source; the schema floor is 1, so a `0` is ignored
    /// rather than read as "no attempts at all".
    #[test]
    fn test_resolve_compaction_max_attempts() {
        let explicit = KimiConfig::from_str(
            r#"
[loop_control]
compaction_max_attempts = 3
"#,
        )
        .unwrap();
        assert_eq!(explicit.resolve_compaction_max_attempts(), Some(3));

        // The camelCase spelling the TS schema writes round-trips too.
        let camel = KimiConfig::from_str(
            r#"
[loop_control]
compactionMaxAttempts = 4
"#,
        )
        .unwrap();
        assert_eq!(camel.resolve_compaction_max_attempts(), Some(4));

        // Unset, empty, and below the schema floor all keep the engine default.
        for raw in [
            SAMPLE_CONFIG,
            "[loop_control]\n",
            "[loop_control]\ncompaction_max_attempts = 0\n",
        ] {
            assert_eq!(
                KimiConfig::from_str(raw)
                    .unwrap()
                    .resolve_compaction_max_attempts(),
                None,
                "{raw}"
            );
        }
    }

    /// v2 #3785 `assertValidSubagentDefaultEffort`: a pool-wide
    /// `default_effort` must be one every pool model can run, so a typo fails
    /// at startup instead of silently degrading the subagent's thinking.
    #[test]
    fn test_secondary_model_default_effort_validation() {
        const EFFORT_CONFIG: &str = r#"
[providers.kimi]
type = "openai"
api_key = "sk-kimi-key"
base_url = "https://api.moonshot.cn/v1"

[models.fast]
provider = "kimi"
model = "kimi-k2-fast"
"#;
        let config = |effort: &str, model_extra: &str| {
            KimiConfig::from_str(&format!(
                r#"{EFFORT_CONFIG}{model_extra}
[secondary_model]
default_model = "fast"
default_effort = "{effort}"

[secondary_model.models]
"fast" = ""
"#
            ))
            .unwrap()
        };

        // A thinking model that declares no effort list accepts any effort.
        let no_list = config("xhigh", "capabilities = [\"thinking\"]\n");
        assert!(no_list.extract_secondary_model_pool(None).is_ok());

        // A declared list bounds it, and the error names the model and the
        // supported set.
        let bounded = config(
            "xhigh",
            "capabilities = [\"thinking\"]\nsupport_efforts = [\"low\", \"high\", \"max\"]\n",
        );
        let error = bounded.extract_secondary_model_pool(None).unwrap_err();
        assert!(
            error.contains("[secondary_model].default_effort \"xhigh\"")
                && error.contains("\"fast\"")
                && error.contains("low, high, max"),
            "{error}"
        );

        // A model without thinking support rejects any concrete effort...
        let plain = config("xhigh", "capabilities = [\"tools\"]\n");
        let error = plain.extract_secondary_model_pool(None).unwrap_err();
        assert!(error.contains("does not support thinking"), "{error}");

        // ...but `off` is always acceptable for it.
        let plain_off = config("off", "capabilities = [\"tools\"]\n");
        assert!(plain_off.extract_secondary_model_pool(None).is_ok());

        // `off` cannot silence a model that always reasons.
        let always = config(
            "off",
            "capabilities = [\"thinking\", \"always_thinking\"]\n",
        );
        let error = always.extract_secondary_model_pool(None).unwrap_err();
        assert!(
            error.contains("cannot disable thinking") && error.contains("\"fast\""),
            "{error}"
        );

        // `adaptive_thinking` alone counts as thinking support.
        let adaptive = config("high", "adaptive_thinking = true\n");
        assert!(adaptive.extract_secondary_model_pool(None).is_ok());

        // The effort is normalized before comparison, so casing and padding
        // do not turn a supported effort into a failure.
        let padded = config(
            "  HIGH  ",
            "capabilities = [\"thinking\"]\nsupport_efforts = [\"low\", \"high\"]\n",
        );
        assert!(padded.extract_secondary_model_pool(None).is_ok());

        // An unset effort skips the check entirely.
        let unset = KimiConfig::from_str(&format!(
            r#"{EFFORT_CONFIG}
[secondary_model]
default_model = "fast"
"#
        ))
        .unwrap();
        assert!(unset.extract_secondary_model_pool(None).is_ok());
    }

    /// v2 #3681 `collectMalformedModelEntries`: a `[models]` entry without a
    /// `model` field cannot resolve, and the usual cause is an unquoted dotted
    /// alias — the warning spells out the quoted table name to write instead.
    #[test]
    fn test_malformed_model_entries_warn() {
        let warnings = KimiConfig::malformed_model_entries(
            r#"
[models.good]
provider = "kimi"
model = "kimi-k2"

[models."dotted.alias"]
provider = "kimi"
model = "kimi-k2"

[models.typo]
provider = "kimi"
max_context_size = 1000

[models.unquoted.dotted]
provider = "kimi"
model = "kimi-k2"
"#,
        );
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert!(
            warnings[0].contains("[models] entry 'typo' is missing the 'model' field")
                && warnings[0].ends_with('.'),
            "{}",
            warnings[0]
        );
        assert!(
            warnings[1].contains("[models] entry 'unquoted' is missing the 'model' field")
                && warnings[1].contains(r#"[models."unquoted.dotted"]"#),
            "{}",
            warnings[1]
        );

        // A config with no `[models]` table, or one that is not TOML at all,
        // produces nothing rather than a second error.
        assert!(KimiConfig::malformed_model_entries("default_model = \"k2\"\n").is_empty());
        assert!(KimiConfig::malformed_model_entries("not = = toml").is_empty());
    }

    /// The same warnings the load path logs are staged on the config, which is
    /// what gives the server something to broadcast as `event.config.warning`
    /// (and the v3 `config.warning` entity) once a lane exists.
    #[test]
    fn from_file_stages_the_malformed_model_entry_warnings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            r#"
[models.good]
provider = "kimi"
model = "kimi-k2"

[models.typo]
provider = "kimi"
max_context_size = 1000
"#,
        )
        .unwrap();

        let config = KimiConfig::from_file(&path).unwrap();
        assert_eq!(
            config.config_warnings.len(),
            1,
            "{:?}",
            config.config_warnings
        );
        assert!(
            config.config_warnings[0].contains("[models] entry 'typo' is missing"),
            "{}",
            config.config_warnings[0]
        );

        // A file whose `[models]` entries all resolve stages nothing, so the
        // server has no empty warning entity to broadcast.
        std::fs::write(
            &path,
            "[models.good]\nprovider = \"kimi\"\nmodel = \"kimi-k2\"\n",
        )
        .unwrap();
        assert!(
            KimiConfig::from_file(&path)
                .unwrap()
                .config_warnings
                .is_empty()
        );

        // Parsing alone cannot see the raw TOML an entry's shape lives in, so
        // the staged list stays empty on that path.
        assert!(
            KimiConfig::from_str("[models.typo]\nprovider = \"kimi\"\n")
                .unwrap()
                .config_warnings
                .is_empty()
        );
    }

    #[test]
    fn test_resolve_max_steps_per_turn() {
        let key = "KIMI_LOOP_MAX_STEPS_PER_TURN";
        let saved = std::env::var(key).ok();
        unsafe { std::env::remove_var(key) };

        let explicit = KimiConfig::from_str(
            r#"
[loop_control]
max_steps_per_turn = 25
"#,
        )
        .unwrap();
        assert_eq!(explicit.resolve_max_steps_per_turn(), Some(25));

        // The deprecated rename still resolves, but the current key wins.
        let deprecated = KimiConfig::from_str(
            r#"
[loop_control]
max_steps_per_run = 30
"#,
        )
        .unwrap();
        assert_eq!(deprecated.resolve_max_steps_per_turn(), Some(30));

        let both = KimiConfig::from_str(
            r#"
[loop_control]
max_steps_per_turn = 25
max_steps_per_run = 30
"#,
        )
        .unwrap();
        assert_eq!(both.resolve_max_steps_per_turn(), Some(25));

        // `0` means unlimited, exactly like an unset value.
        let unlimited = KimiConfig::from_str(
            r#"
[loop_control]
max_steps_per_turn = 0
"#,
        )
        .unwrap();
        assert_eq!(unlimited.resolve_max_steps_per_turn(), None);

        let absent = KimiConfig::from_str(SAMPLE_CONFIG).unwrap();
        assert_eq!(absent.resolve_max_steps_per_turn(), None);

        unsafe { std::env::set_var(key, "12") };
        assert_eq!(both.resolve_max_steps_per_turn(), Some(12), "env wins");
        unsafe { std::env::set_var(key, "0") };
        assert_eq!(
            both.resolve_max_steps_per_turn(),
            None,
            "an env 0 means unlimited and outranks the config"
        );

        unsafe {
            match saved {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }

    const SERVICES_CONFIG: &str = r#"
[services.moonshot_search]
base_url = "https://search.example.test/v1"
api_key = "sk-search"
custom_headers = { "X-Trace" = "t1" }

[services.moonshotFetch]
baseUrl = "https://fetch.example.test/v1"
apiKey = "sk-fetch"
"#;

    #[test]
    fn test_parse_services_config() {
        // Snake_case is the file contract; the camelCase section + keys parse
        // too (the host schema accepts both spellings).
        let config = KimiConfig::from_str(SERVICES_CONFIG).unwrap();
        let search = config.services.moonshot_search.as_ref().unwrap();
        assert_eq!(
            search.base_url.as_deref(),
            Some("https://search.example.test/v1")
        );
        assert_eq!(search.api_key.as_deref(), Some("sk-search"));
        assert_eq!(
            search
                .custom_headers
                .as_ref()
                .unwrap()
                .get("X-Trace")
                .map(String::as_str),
            Some("t1")
        );
        let fetch = config.services.moonshot_fetch.as_ref().unwrap();
        assert_eq!(
            fetch.base_url.as_deref(),
            Some("https://fetch.example.test/v1")
        );
        assert_eq!(fetch.api_key.as_deref(), Some("sk-fetch"));
        // An absent section stays inert.
        assert!(
            KimiConfig::from_str(SAMPLE_CONFIG)
                .unwrap()
                .services
                .moonshot_search
                .is_none()
        );
    }

    #[test]
    fn test_resolve_web_services_env_overlay() {
        let keys = [
            "KIMI_WEB_SEARCH_BASE_URL",
            "KIMI_WEB_SEARCH_API_KEY",
            "KIMI_WEB_FETCH_BASE_URL",
            "KIMI_WEB_FETCH_API_KEY",
        ];
        let saved: Vec<Option<String>> = keys.iter().map(|key| std::env::var(key).ok()).collect();
        // The env vars outrank the file: clear them first so the config-only
        // precedence below is not poisoned by the developer's shell.
        unsafe {
            for key in keys {
                std::env::remove_var(key);
            }
        }

        let config = KimiConfig::from_str(SERVICES_CONFIG).unwrap();
        let search = config.resolve_web_search_service().unwrap();
        assert_eq!(search.base_url, "https://search.example.test/v1");
        assert_eq!(search.api_key.as_deref(), Some("sk-search"));
        assert_eq!(search.custom_headers.len(), 1);

        // An env api key outranks the persisted one; config headers stay.
        unsafe { std::env::set_var("KIMI_WEB_SEARCH_API_KEY", "sk-env") };
        let search = config.resolve_web_search_service().unwrap();
        assert_eq!(search.api_key.as_deref(), Some("sk-env"));
        assert_eq!(search.custom_headers.len(), 1);

        // An env base URL is a credential boundary: the persisted key and
        // headers never cross into it, and a blank env key is unset rather
        // than the config key.
        unsafe {
            std::env::set_var(
                "KIMI_WEB_SEARCH_BASE_URL",
                "https://env.example.test/search",
            );
            std::env::set_var("KIMI_WEB_SEARCH_API_KEY", "  ");
        }
        let search = config.resolve_web_search_service().unwrap();
        assert_eq!(search.base_url, "https://env.example.test/search");
        assert_eq!(search.api_key, None);
        assert!(search.custom_headers.is_empty());

        // The fetch entry resolves independently of the search env overlay.
        assert_eq!(
            config
                .resolve_web_fetch_service()
                .unwrap()
                .api_key
                .as_deref(),
            Some("sk-fetch")
        );

        // A blank base URL (and an absent entry) resolve to None.
        unsafe { std::env::remove_var("KIMI_WEB_SEARCH_BASE_URL") };
        let blank = KimiConfig::from_str(
            r#"
[services.moonshot_search]
base_url = "   "
api_key = "sk-search"
"#,
        )
        .unwrap();
        assert!(blank.resolve_web_search_service().is_none());
        assert!(
            KimiConfig::from_str(SAMPLE_CONFIG)
                .unwrap()
                .resolve_web_search_service()
                .is_none()
        );

        unsafe {
            for (key, value) in keys.iter().zip(saved) {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    #[test]
    fn test_resolve_subagent_and_swarm_timeouts() {
        let keys = ["KIMI_SUBAGENT_TIMEOUT_MS", "KIMI_CODE_SWARM_TIMEOUT_MS"];
        let saved: Vec<Option<String>> = keys.iter().map(|key| std::env::var(key).ok()).collect();
        unsafe {
            for key in keys {
                std::env::remove_var(key);
            }
        }

        let config = KimiConfig::from_str(
            r#"
[subagent]
timeout_ms = 5000

[swarm]
timeoutMs = 7000
"#,
        )
        .unwrap();
        assert_eq!(config.resolve_subagent_timeout_ms(), Some(5000));
        assert_eq!(config.resolve_swarm_timeout_ms(), Some(7000));

        // The env overlay outranks the file and each knob is independent.
        unsafe { std::env::set_var("KIMI_SUBAGENT_TIMEOUT_MS", "9000") };
        assert_eq!(config.resolve_subagent_timeout_ms(), Some(9000));
        assert_eq!(config.resolve_swarm_timeout_ms(), Some(7000));
        unsafe { std::env::set_var("KIMI_CODE_SWARM_TIMEOUT_MS", "8000") };
        assert_eq!(config.resolve_swarm_timeout_ms(), Some(8000));
        unsafe { std::env::remove_var("KIMI_CODE_SWARM_TIMEOUT_MS") };

        // `0` passes through — the tools read it as the engine default,
        // matching the host-driven paths; an invalid env value falls back to
        // the file.
        unsafe { std::env::set_var("KIMI_SUBAGENT_TIMEOUT_MS", "0") };
        assert_eq!(config.resolve_subagent_timeout_ms(), Some(0));
        unsafe { std::env::set_var("KIMI_SUBAGENT_TIMEOUT_MS", "-1") };
        assert_eq!(config.resolve_subagent_timeout_ms(), Some(5000));
        unsafe { std::env::set_var("KIMI_SUBAGENT_TIMEOUT_MS", "soon") };
        assert_eq!(config.resolve_subagent_timeout_ms(), Some(5000));

        // Absent sections resolve to None (the engine keeps its 2h default).
        let absent = KimiConfig::from_str(SAMPLE_CONFIG).unwrap();
        assert_eq!(absent.resolve_subagent_timeout_ms(), None);
        assert_eq!(absent.resolve_swarm_timeout_ms(), None);

        unsafe {
            for (key, value) in keys.iter().zip(saved) {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    #[test]
    fn provider_custom_headers_reach_the_resolved_llm() {
        // Self-hosted gateways carry their auth/routing in custom headers;
        // without this the deployment 401s on every request.
        let config = KimiConfig::from_str(
            r#"
default_model = "gw"

[providers.gw]
type = "openai"
base_url = "https://gw.internal/v1"
api_key = "k"
customHeaders = { "X-Gateway-Key" = "abc", "X-Tenant" = "t1" }

[models.gw]
provider = "gw"
model = "gpt"
"#,
        )
        .unwrap();
        let native = config.extract_native_llm(None).unwrap();
        assert_eq!(
            native
                .custom_headers
                .get("X-Gateway-Key")
                .map(String::as_str),
            Some("abc")
        );
        assert_eq!(
            native.custom_headers.get("X-Tenant").map(String::as_str),
            Some("t1")
        );

        // Snake_case is the file contract; both spellings must parse.
        let snake = KimiConfig::from_str(
            r#"
default_model = "gw"

[providers.gw]
type = "openai"
base_url = "https://gw.internal/v1"
api_key = "k"
custom_headers = { "X-Gateway-Key" = "abc" }

[models.gw]
provider = "gw"
model = "gpt"
"#,
        )
        .unwrap();
        assert_eq!(
            snake
                .extract_native_llm(None)
                .unwrap()
                .custom_headers
                .get("X-Gateway-Key")
                .map(String::as_str),
            Some("abc")
        );
    }

    #[test]
    fn alias_base_url_and_protocol_override_the_provider() {
        let config = KimiConfig::from_str(
            r#"
default_model = "kimi"

[providers.moonshot]
type = "openai"
base_url = "https://api.moonshot.ai/v1"
api_key = "k"

[models.kimi]
provider = "moonshot"
model = "kimi-k2"
baseUrl = "https://gateway.example.com/v1"
protocol = "anthropic"
betaApi = true
"#,
        )
        .unwrap();
        let native = config.extract_native_llm(None).unwrap();
        // A declared alias endpoint wins over the provider default.
        assert_eq!(native.base_url, "https://gateway.example.com/v1");
        // The alias's wire protocol wins over the provider type.
        assert_eq!(native.protocol, "anthropic");
        assert!(native.beta_api);

        // Without an alias override the provider decides, and the default is
        // Chat Completions.
        let plain = KimiConfig::from_str(
            r#"
default_model = "kimi"

[providers.moonshot]
type = "openai"
base_url = "https://api.moonshot.ai/v1"
api_key = "k"

[models.kimi]
provider = "moonshot"
model = "kimi-k2"
"#,
        )
        .unwrap();
        let native = plain.extract_native_llm(None).unwrap();
        assert_eq!(native.base_url, "https://api.moonshot.ai/v1");
        assert_eq!(native.protocol, "openai");
        assert!(!native.beta_api);
    }

    #[test]
    fn vertexai_provider_type_resolves_the_google_protocol() {
        // The model catalog maps `vertexai` to `google-genai`; the endpoint
        // resolver must not answer differently, or a Vertex-shaped URL gets
        // an OpenAI body. The endpoint declaration table still excludes it
        // (no Vertex wire protocol, no env fallback) — only an explicitly
        // declared `base_url` resolves.
        let config = KimiConfig::from_str(
            r#"
default_model = "v"

[providers.vertex]
type = "vertexai"
base_url = "https://us-central1-aiplatform.googleapis.com"
api_key = "k"

[models.v]
provider = "vertex"
model = "gemini-2.5-pro"
"#,
        )
        .unwrap();
        let native = config.extract_native_llm(None).unwrap();
        assert_eq!(native.protocol, "google-genai");
        assert_eq!(
            native.base_url,
            "https://us-central1-aiplatform.googleapis.com/v1beta"
        );

        // Without a declared endpoint it still does not resolve: Vertex has
        // no default host (it is regional) and no env fallback here.
        let bare = KimiConfig::from_str(
            r#"
default_model = "v"

[providers.vertex]
type = "vertexai"
api_key = "k"

[models.v]
provider = "vertex"
model = "gemini-2.5-pro"
"#,
        )
        .unwrap();
        assert!(bare.extract_native_llm(None).is_none());
    }

    #[test]
    fn tools_switch_and_effort_reach_the_engine() {
        let config = KimiConfig::from_str(
            r#"
[tools]
enabled = ["Read", "Bash", "mcp__github__*"]
disabled = ["Write"]

[thinking]
effort = "high"
"#,
        )
        .unwrap();
        let snapshot = config.build_policy_snapshot(None);
        let filter = snapshot
            .tools_filter
            .as_ref()
            .expect("the [tools] switch must reach the snapshot");
        assert!(filter.allows("Read"));
        assert!(filter.allows("mcp__github__search"), "MCP names are globs");
        assert!(!filter.allows("Write"));
        // Thinking on: the chosen effort goes on the wire.
        assert_eq!(config.resolve_effort(None).as_deref(), Some("high"));

        // No switch at all leaves the filter unset (every tool survives).
        let bare = KimiConfig::from_str("default_model = \"m\"\n").unwrap();
        assert!(bare.build_policy_snapshot(None).tools_filter.is_none());
        assert_eq!(bare.resolve_effort(None), None);
    }

    #[test]
    fn thinking_off_sends_the_model_off_effort() {
        // Models whose default is to reason need the "off" effort sent
        // explicitly instead of an omitted field (schema `offEffort`).
        let config = KimiConfig::from_str("[thinking]\nenabled = false\n").unwrap();
        assert_eq!(config.resolve_effort(Some("none")).as_deref(), Some("none"));
        assert_eq!(config.resolve_effort(None), None);

        let on = KimiConfig::from_str("[thinking]\nenabled = true\neffort = \"low\"\n").unwrap();
        assert_eq!(on.resolve_effort(Some("none")).as_deref(), Some("low"));
    }

    #[test]
    fn permission_rule_reasons_reach_the_denial() {
        let config = KimiConfig::from_str(
            r#"
[[permission.rules]]
decision = "deny"
pattern = "Write(*.env)"
reason = "secrets must never be written by the agent"
scope = "project"
"#,
        )
        .unwrap();
        let snapshot = config.build_policy_snapshot(None);
        assert_eq!(
            snapshot
                .rule_reasons
                .get("Write(*.env)")
                .map(String::as_str),
            Some("secrets must never be written by the agent")
        );
        // The engine echoes it in the verdict.
        let verdict = crate::permission::PermissionEngine::new(snapshot)
            .evaluate("Write", &serde_json::json!({ "path": "prod.env" }));
        assert!(
            verdict
                .reason
                .as_deref()
                .unwrap_or_default()
                .contains("secrets must never be written by the agent"),
            "{:?}",
            verdict.reason
        );
    }

    #[test]
    fn experimental_flags_and_default_mode_parse() {
        // `[experimental]` is a free boolean/string map: clients probe it to
        // gate UI features, so the engine must carry it verbatim.
        let config = KimiConfig::from_str(
            r#"
default_permission_mode = "auto"

[experimental]
"secondary-model" = true
flavor = "canary"
"#,
        )
        .unwrap();
        assert_eq!(
            config.experimental.get("secondary-model"),
            Some(&ExperimentalValue::Bool(true))
        );
        assert_eq!(
            config.experimental.get("flavor"),
            Some(&ExperimentalValue::String("canary".into()))
        );
        // `default_permission_mode` is the mode when `[permission].mode` is
        // unset; `[permission].mode` still wins over it.
        assert_eq!(
            config.build_policy_snapshot(None).mode,
            crate::permission::PermissionMode::Auto
        );
        let explicit = KimiConfig::from_str(
            r#"
default_permission_mode = "auto"

[permission]
mode = "manual"
"#,
        )
        .unwrap();
        assert_eq!(
            explicit.build_policy_snapshot(None).mode,
            crate::permission::PermissionMode::Manual
        );
    }

    #[test]
    fn extra_skill_dirs_are_scanned() {
        let dir = std::env::temp_dir().join(format!("kimi-skills-{}", std::process::id()));
        let skill = dir.join("my-extra-skill");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: my-extra-skill\ndescription: From an extra dir\n---\n\nBody.\n",
        )
        .unwrap();

        let config = KimiConfig::from_str(&format!(
            "extra_skill_dirs = [\"{}\"]\n",
            dir.to_string_lossy().replace('\\', "/")
        ))
        .unwrap();
        let extra = config.extra_skill_dirs_paths();
        assert_eq!(extra.len(), 1);

        let found = crate::skills::scan_all_skills_with_extra(None, &extra)
            .into_iter()
            .any(|skill| skill.name == "my-extra-skill");
        assert!(found, "extra_skill_dirs must feed the skill listing");

        // And the prompt's skills section lists it, so the model can call it.
        let section =
            crate::prompt::skills_renderer::generate_skills_section_with_extra(None, &extra);
        assert!(section.contains("my-extra-skill"), "{section}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn merge_all_available_skills_resolves_with_documented_default() {
        // Unset keeps the documented default (`true`), so a file that never
        // mentions the key behaves exactly as before.
        let absent = KimiConfig::from_str(SAMPLE_CONFIG).unwrap();
        assert!(absent.resolve_merge_all_available_skills());

        let off = KimiConfig::from_str("merge_all_available_skills = false\n").unwrap();
        assert!(!off.resolve_merge_all_available_skills());

        // The camelCase alias the schema and the web client write is accepted.
        let camel = KimiConfig::from_str("mergeAllAvailableSkills = false\n").unwrap();
        assert!(!camel.resolve_merge_all_available_skills());
    }

    #[test]
    fn merge_flag_reaches_the_prompt_skills_section() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();

        std::fs::create_dir_all(dir.join(".agents").join("skills").join("a")).unwrap();
        std::fs::write(
            dir.join(".agents")
                .join("skills")
                .join("a")
                .join("SKILL.md"),
            "---\nname: merged-a\ndescription: A\n---\n",
        )
        .unwrap();
        std::fs::create_dir_all(dir.join(".kimi-code").join("skills").join("b")).unwrap();
        std::fs::write(
            dir.join(".kimi-code")
                .join("skills")
                .join("b")
                .join("SKILL.md"),
            "---\nname: merged-b\ndescription: B\n---\n",
        )
        .unwrap();

        let on = crate::prompt::SystemPromptBuilder::build_default_with_skill_config(
            dir,
            Vec::new(),
            true,
        );
        assert!(on.contains("merged-a"), "{on}");
        assert!(on.contains("merged-b"), "{on}");

        let off = crate::prompt::SystemPromptBuilder::build_default_with_skill_config(
            dir,
            Vec::new(),
            false,
        );
        assert!(off.contains("merged-a"), "{off}");
        assert!(
            !off.contains("merged-b"),
            "merge_all_available_skills=false must not scan the second project dir"
        );
    }

    #[test]
    fn test_resolve_image_limits() {
        let keys = ["KIMI_IMAGE_READ_BYTE_BUDGET", "KIMI_IMAGE_MAX_EDGE_PX"];
        let saved: Vec<Option<String>> = keys.iter().map(|key| std::env::var(key).ok()).collect();
        unsafe {
            for key in keys {
                std::env::remove_var(key);
            }
        }

        let config = KimiConfig::from_str(
            r#"
[image]
read_byte_budget = 131072
maxEdgePx = 800
"#,
        )
        .unwrap();
        assert_eq!(config.resolve_image_read_byte_budget(), Some(131072));
        assert_eq!(config.resolve_image_max_edge_px(), Some(800));

        // Env wins; zero and invalid values fall back to the file.
        unsafe { std::env::set_var("KIMI_IMAGE_READ_BYTE_BUDGET", "65536") };
        assert_eq!(config.resolve_image_read_byte_budget(), Some(65536));
        unsafe { std::env::set_var("KIMI_IMAGE_READ_BYTE_BUDGET", "0") };
        assert_eq!(config.resolve_image_read_byte_budget(), Some(131072));
        unsafe { std::env::set_var("KIMI_IMAGE_READ_BYTE_BUDGET", "nope") };
        assert_eq!(config.resolve_image_read_byte_budget(), Some(131072));
        unsafe { std::env::remove_var("KIMI_IMAGE_READ_BYTE_BUDGET") };
        unsafe { std::env::set_var("KIMI_IMAGE_MAX_EDGE_PX", "400") };
        assert_eq!(config.resolve_image_max_edge_px(), Some(400));
        unsafe { std::env::remove_var("KIMI_IMAGE_MAX_EDGE_PX") };

        // An absent section keeps the engine defaults (None).
        let absent = KimiConfig::from_str(SAMPLE_CONFIG).unwrap();
        assert_eq!(absent.resolve_image_read_byte_budget(), None);
        assert_eq!(absent.resolve_image_max_edge_px(), None);

        unsafe {
            for (key, value) in keys.iter().zip(saved) {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    #[test]
    fn test_extract_native_llm_capabilities() {
        let config = KimiConfig::from_str(
            r#"
default_model = "kimi-k2"

[providers.kimi]
type = "openai"
api_key = "sk-kimi-key"
base_url = "https://api.moonshot.cn/v1"

[models.kimi-k2]
provider = "kimi"
model = "kimi-k2-0711"
capabilities = ["thinking", "image_in"]
"#,
        )
        .unwrap();
        let llm = config.extract_native_llm(None).unwrap();
        assert_eq!(
            llm.capabilities.as_deref(),
            Some(&["thinking".to_string(), "image_in".to_string()][..])
        );

        // No declared capabilities stays unknown (None) — the lenient default.
        let bare = KimiConfig::from_str(SAMPLE_CONFIG).unwrap();
        assert_eq!(bare.extract_native_llm(None).unwrap().capabilities, None);
    }

    #[test]
    fn test_resolve_thinking_keep() {
        let key = "KIMI_MODEL_THINKING_KEEP";
        let saved = std::env::var(key).ok();
        unsafe { std::env::remove_var(key) };

        let explicit = KimiConfig::from_str(
            r#"
[thinking]
keep = "all"
"#,
        )
        .unwrap();
        assert_eq!(explicit.resolve_thinking_keep().as_deref(), Some("all"));

        // Off values disable the passthrough; unset stays opt-in (no keep).
        let off = KimiConfig::from_str(
            r#"
[thinking]
keep = "off"
"#,
        )
        .unwrap();
        assert_eq!(off.resolve_thinking_keep(), None);
        assert_eq!(
            KimiConfig::from_str(SAMPLE_CONFIG)
                .unwrap()
                .resolve_thinking_keep(),
            None
        );

        // `enabled = false` gates the passthrough off.
        let disabled = KimiConfig::from_str(
            r#"
[thinking]
enabled = false
keep = "all"
"#,
        )
        .unwrap();
        assert_eq!(disabled.resolve_thinking_keep(), None);

        // Every off value disables the passthrough, case- and
        // whitespace-insensitively. The same six spellings are duplicated in
        // `resolveThinkingKeep` (node-sdk/src/native/native-llm-resolver.ts),
        // so this table is the Rust half of a cross-language contract: a
        // spelling added on one side and not the other would silently change
        // what a user can turn off.
        for off_value in ["false", "0", "no", "off", "none", "null"] {
            for spelling in [off_value.to_string(), off_value.to_uppercase()] {
                let config =
                    KimiConfig::from_str(&format!("[thinking]\nkeep = \"{spelling}\"\n")).unwrap();
                assert_eq!(
                    config.resolve_thinking_keep(),
                    None,
                    "{spelling:?} must disable the passthrough"
                );
            }
        }
        // Padded values trim to the same off value.
        let padded = KimiConfig::from_str("[thinking]\nkeep = \"  OFF  \"\n").unwrap();
        assert_eq!(padded.resolve_thinking_keep(), None);
        // A value that merely contains an off word is not one, and a bare
        // "all" is the enabling spelling.
        let partial = KimiConfig::from_str("[thinking]\nkeep = \"none-of-the-above\"\n").unwrap();
        assert_eq!(
            partial.resolve_thinking_keep().as_deref(),
            Some("none-of-the-above")
        );
        let all = KimiConfig::from_str("[thinking]\nkeep = \"all\"\n").unwrap();
        assert_eq!(all.resolve_thinking_keep().as_deref(), Some("all"));

        // Env outranks the file, off values included.
        unsafe { std::env::set_var(key, "all") };
        assert_eq!(off.resolve_thinking_keep().as_deref(), Some("all"));
        unsafe { std::env::set_var(key, "none") };
        assert_eq!(explicit.resolve_thinking_keep(), None);

        // Every `[secondary_model]` entry rides the same passthrough.
        unsafe { std::env::remove_var(key) };
        let pool = KimiConfig::from_str(&format!(
            r#"{POOL_CONFIG}
[thinking]
keep = "all"

[secondary_model]
default_model = "fast"
"#
        ))
        .unwrap()
        .extract_secondary_model_pool(None)
        .unwrap()
        .unwrap();
        assert_eq!(pool.models[0].llm.thinking_keep.as_deref(), Some("all"));

        unsafe {
            match saved {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }

    /// A one-provider config with the `[models.alias]` body appended, so each
    /// test below states only the fields it is about.
    fn alias_config(body: &str) -> KimiConfig {
        KimiConfig::from_str(&format!(
            r#"
default_model = "alias"

[providers.kimi]
type = "openai"
api_key = "sk-provider-key"
base_url = "https://api.moonshot.cn/v1"

[models.alias]
provider = "kimi"
model = "kimi-k2-0711"
{body}
"#
        ))
        .unwrap()
    }

    #[test]
    fn model_name_wins_over_model_for_the_wire_name() {
        let named = alias_config("name = \"kimi-k2-0905\"\n");
        assert_eq!(
            named.extract_native_llm(None).unwrap().model,
            "kimi-k2-0905"
        );
        // Without `name` the entry's `model` is the wire name.
        assert_eq!(
            alias_config("").extract_native_llm(None).unwrap().model,
            "kimi-k2-0711"
        );
    }

    #[test]
    fn provider_id_is_an_alias_for_provider() {
        let config = KimiConfig::from_str(
            r#"
default_model = "alias"

[providers.kimi]
type = "openai"
api_key = "sk-provider-key"
base_url = "https://api.moonshot.cn/v1"

[models.alias]
provider_id = "kimi"
model = "kimi-k2-0711"
"#,
        )
        .unwrap();
        let native = config.extract_native_llm(None).unwrap();
        assert_eq!(native.api_key, "sk-provider-key");
        assert_eq!(native.base_url, "https://api.moonshot.cn/v1");
    }

    #[test]
    fn model_overrides_shadow_the_base_catalog_fields() {
        let config = alias_config(
            r#"max_output_size = 4096
max_input_size = 262144
capabilities = ["thinking"]
reasoning_key = "reasoning_content"
off_effort = "none"

[models.alias.overrides]
max_output_size = 8192
capabilities = ["thinking", "image_in"]
reasoning_key = "reasoning"
"#,
        );
        let native = config.extract_native_llm(None).unwrap();
        assert_eq!(native.max_output_size, Some(8192));
        assert_eq!(native.reasoning_key.as_deref(), Some("reasoning"));
        assert_eq!(
            native.capabilities.as_deref(),
            Some(&["thinking".to_string(), "image_in".to_string()][..])
        );
        // A field the override does not mention keeps the base value.
        assert_eq!(native.max_input_size, Some(262144));
        assert_eq!(native.off_effort.as_deref(), Some("none"));
    }

    #[test]
    fn a_declared_alias_resolves_to_its_entry() {
        let config = alias_config("aliases = [\"kimi-latest\"]\n");
        // The table key still resolves directly.
        assert_eq!(
            config.extract_native_llm(Some("alias")).unwrap().model,
            "kimi-k2-0711"
        );
        // A declared alias reaches the same entry.
        let via_alias = config.extract_native_llm(Some("kimi-latest")).unwrap();
        assert_eq!(via_alias.model, "kimi-k2-0711");
        assert_eq!(via_alias.api_key, "sk-provider-key");
        // An undeclared name still resolves to nothing.
        assert!(config.extract_native_llm(Some("nope")).is_none());
    }

    #[test]
    fn model_api_key_wins_over_the_providers() {
        let native = alias_config("api_key = \"sk-model-key\"\n")
            .extract_native_llm(None)
            .unwrap();
        assert_eq!(native.api_key, "sk-model-key");
        assert_eq!(native.auth_provider, None);
    }

    #[test]
    fn model_oauth_wins_over_the_providers_static_key() {
        let native = alias_config("oauth = { provider = \"kimi\" }\n")
            .extract_native_llm(None)
            .unwrap();
        assert_eq!(native.api_key, "");
        assert_eq!(native.auth_provider.as_deref(), Some("kimi"));
    }

    #[test]
    fn model_oauth_resolves_without_a_provider_credential() {
        let config = KimiConfig::from_str(
            r#"
default_model = "alias"

[providers.kimi]
type = "openai"
base_url = "https://api.moonshot.cn/v1"

[models.alias]
provider = "kimi"
model = "kimi-k2-0711"
oauth = { provider = "kimi" }
"#,
        )
        .unwrap();
        let native = config.extract_native_llm(None).unwrap();
        assert_eq!(native.api_key, "");
        assert_eq!(native.auth_provider.as_deref(), Some("kimi"));
    }

    #[test]
    fn secondary_pool_entries_carry_the_model_catalog_fields() {
        let config = KimiConfig::from_str(
            r#"
default_model = "kimi-k2"

[providers.kimi]
type = "openai"
api_key = "sk-kimi-key"
base_url = "https://api.moonshot.cn/v1"

[models.kimi-k2]
provider = "kimi"
model = "kimi-k2-0711"

[models.fast]
provider = "kimi"
model = "kimi-k2-fast"
name = "kimi-k2-fast-0905"
capabilities = ["thinking", "image_in"]
system_prompt = "Be terse."
max_input_size = 131072
adaptive_thinking = true
reasoning_key = "reasoning"
off_effort = "none"

[secondary_model]
default_model = "fast"
"#,
        )
        .unwrap();
        let pool = config.extract_secondary_model_pool(None).unwrap().unwrap();
        let fast = &pool.models[0].llm;
        assert_eq!(fast.model, "kimi-k2-fast-0905");
        assert_eq!(fast.max_input_size, Some(131072));
        assert_eq!(fast.adaptive_thinking, Some(true));
        assert_eq!(fast.reasoning_key.as_deref(), Some("reasoning"));
        assert_eq!(fast.off_effort.as_deref(), Some("none"));
        assert_eq!(fast.system_prompt.as_deref(), Some("Be terse."));
        assert_eq!(
            fast.capabilities.as_deref(),
            Some(&["thinking".to_string(), "image_in".to_string()][..])
        );
    }
}
