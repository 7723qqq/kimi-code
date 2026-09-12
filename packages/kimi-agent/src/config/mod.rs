//! Pure Rust configuration and credential manager for `kimi-agent` (P27 批 1).
//!
//! Loads and validates `config.toml` without depending on Node/Bun or any JS runtimes.
//! Discovers configuration from standard locations (`./config.toml`, `~/.kimi-code/config.toml`).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::permission::{HookDef, PermissionMode, PolicySnapshot};
use crate::rpc::types::{NativeLlmConfig, SecondaryModelEntry, SecondaryModelPool};

pub mod write;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderConfig {
    #[serde(rename = "default_model", default)]
    pub default_model: Option<String>,
    #[serde(rename = "type", default)]
    pub provider_type: Option<String>,
    #[serde(rename = "api_key", default)]
    pub api_key: Option<String>,
    #[serde(rename = "base_url", default)]
    pub base_url: Option<String>,
    #[serde(rename = "max_tokens", default)]
    pub max_tokens: Option<u32>,
    /// OAuth binding (v2 `providers.*.oauth`): its presence marks the
    /// provider OAuth-authenticated even without a static key.
    #[serde(default)]
    pub oauth: Option<serde_json::Value>,
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
    #[serde(default)]
    pub model: Option<String>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedNativeLlm {
    pub protocol: String,
    pub base_url: String,
    pub api_key: String,
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
    pub fn from_file(path: &Path) -> Result<Self, String> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read config at {}: {e}", path.display()))?;
        content.parse()
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

        let (provider_name, wire_model) = if let Some(alias) = self.models.get(model_key) {
            let p = alias.provider.as_deref().unwrap_or(model_key);
            let m = alias.model.as_deref().unwrap_or(model_key);
            (p, m)
        } else if let Some((p_name, _)) = self.providers.iter().find(|(name, _)| *name == model_key)
        {
            (p_name.as_str(), model_key)
        } else {
            let fallback = self.agent.native_llm_provider.as_deref()?;
            (fallback, model_key)
        };

        let provider = self.providers.get(provider_name)?;
        let alias = self.models.get(model_key);
        // A declared alias endpoint wins: gateway providers serve one alias
        // over a different path than the provider default
        // (schema `models.*.baseUrl`).
        let raw_base_url = alias
            .and_then(|alias| alias.base_url.as_deref())
            .or(provider.base_url.as_deref())?;
        let api_key = provider.api_key.clone().unwrap_or_default();
        // A static key wins; an OAuth-bound provider (`[providers.*].oauth`)
        // authenticates through the host token channel instead, so the static
        // key is optional for it. A provider with neither cannot serve a
        // request, so the model does not resolve.
        let auth_provider = if !api_key.is_empty() {
            None
        } else if provider.oauth.is_some() {
            Some(provider_name.to_string())
        } else {
            return None;
        };

        let p_type = provider
            .provider_type
            .as_deref()
            .unwrap_or("openai")
            .to_lowercase();
        // The alias declares its wire protocol (schema `models.*.protocol`:
        // "anthropic" | "openai_responses"); the provider type is the
        // fallback, and everything else is Chat Completions.
        let protocol = match alias.and_then(|alias| alias.protocol.as_deref()) {
            Some("anthropic") => "anthropic",
            Some("openai_responses") => "openai_responses",
            _ if p_type == "anthropic" => "anthropic",
            _ => "openai",
        };

        let base_url = normalize_base_url(raw_base_url, protocol);
        let capabilities = alias
            .and_then(|alias| alias.capabilities.clone())
            .filter(|caps| !caps.is_empty());

        Some(ResolvedNativeLlm {
            protocol: protocol.into(),
            base_url,
            api_key,
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
    /// instead of silently disabling the user's configuration.
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

        Ok(Some(SecondaryModelPool {
            force,
            default_model: default_model.to_string(),
            caller_model_alias: target_model
                .map(str::to_string)
                .or_else(|| self.default_model.clone()),
            models,
        }))
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
        }
    }
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

fn normalize_base_url(url: &str, protocol: &str) -> String {
    let trimmed = url.trim_end_matches('/');
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
        model: resolved.model,
        max_tokens: resolved.max_tokens,
        custom_headers: Default::default(),
        reasoning_effort: None,
        thinking_budget: None,
        auth_provider: None,
        thinking_keep: thinking_keep.map(str::to_string),
        beta_api: resolved.beta_api,
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

[models.fast]
provider = "kimi"
model = "kimi-k2-fast"

[models.thinky]
provider = "anthropic"
model = "claude-sonnet"
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
}
