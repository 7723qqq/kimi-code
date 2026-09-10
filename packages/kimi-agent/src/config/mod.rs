//! Pure Rust configuration and credential manager for `kimi-agent` (P27 批 1).
//!
//! Loads and validates `config.toml` without depending on Node/Bun or any JS runtimes.
//! Discovers configuration from standard locations (`./config.toml`, `~/.kimi-code/config.toml`).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::permission::{HookDef, PermissionMode, PolicySnapshot};
use crate::rpc::types::{NativeLlmConfig, SecondaryModelEntry, SecondaryModelPool};

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
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelAliasConfig {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(rename = "system_prompt", default)]
    pub system_prompt: Option<String>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PermissionRuleConfig {
    #[serde(default)]
    pub decision: Option<String>,
    #[serde(default)]
    pub pattern: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KimiConfig {
    #[serde(rename = "default_model", default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub providers: HashMap<String, ProviderConfig>,
    #[serde(default)]
    pub models: HashMap<String, ModelAliasConfig>,
    #[serde(default)]
    pub agent: AgentConfig,
    #[serde(default)]
    pub permission: Option<PermissionConfig>,
    #[serde(rename = "mcp_servers", default)]
    pub mcp_servers: HashMap<String, McpServerConfig>,
    /// Global MCP defaults (v2 `[mcp]` section).
    #[serde(default)]
    pub mcp: McpTimeoutConfig,
    #[serde(default)]
    pub github: GitHubConfig,
    /// Subagent model pool (v2 `[secondary_model]` section); see
    /// [`KimiConfig::extract_secondary_model_pool`].
    #[serde(rename = "secondary_model", default)]
    pub secondary_model: Option<SecondaryModelConfig>,
    /// User-configured external hooks (v2 `[hooks]` section). The engine
    /// executes the `PreToolUse` ones before native tool calls (G-6 #6).
    #[serde(default)]
    pub hooks: Vec<HookDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedNativeLlm {
    pub protocol: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub max_tokens: Option<u32>,
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
        let raw_base_url = provider.base_url.as_deref()?;
        let api_key = provider.api_key.as_deref()?;

        let p_type = provider
            .provider_type
            .as_deref()
            .unwrap_or("openai")
            .to_lowercase();
        let protocol = if p_type == "anthropic" {
            "anthropic"
        } else {
            "openai"
        };

        let base_url = normalize_base_url(raw_base_url, protocol);

        Some(ResolvedNativeLlm {
            protocol: protocol.into(),
            base_url,
            api_key: api_key.into(),
            model: wire_model.into(),
            max_tokens: provider.max_tokens,
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
        let default_model = section.default_model.as_deref().or(section.model.as_deref());

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
                    llm: native_llm_config(resolved, section.default_effort.as_deref()),
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

    /// Build a [`PolicySnapshot`] from the configuration.
    pub fn build_policy_snapshot(&self, git_cwd: Option<PathBuf>) -> PolicySnapshot {
        let mode = if self.agent.yolo == Some(true) {
            PermissionMode::Yolo
        } else if let Some(ref p) = self.permission {
            match p.mode.as_deref() {
                Some("yolo") => PermissionMode::Yolo,
                Some("auto") => PermissionMode::Auto,
                _ => PermissionMode::Manual,
            }
        } else {
            PermissionMode::Manual
        };

        let mut deny_rules = Vec::new();
        let mut ask_rules = Vec::new();
        let mut allow_rules = Vec::new();

        if let Some(ref p) = self.permission
            && let Some(ref rules) = p.rules
        {
            for r in rules {
                let pattern = match r.pattern.as_deref() {
                    Some(p) => p.to_string(),
                    None => continue,
                };
                match r.decision.as_deref() {
                    Some("deny") => deny_rules.push(pattern),
                    Some("ask") => ask_rules.push(pattern),
                    Some("allow") => allow_rules.push(pattern),
                    _ => {}
                }
            }
        }

        PolicySnapshot {
            mode,
            deny_rules,
            ask_rules,
            allow_rules,
            session_approvals: Vec::new(),
            git_cwd: git_cwd.map(|p| p.to_string_lossy().to_string()),
            // The standalone loader has no global `[tools]` section; the
            // host-driven paths (napi / standalone server) pass the resolved
            // switch in through their own snapshot.
            tools_filter: None,
            pre_tool_hooks: self.hooks.clone(),
        }
    }
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
fn native_llm_config(resolved: ResolvedNativeLlm, effort: Option<&str>) -> NativeLlmConfig {
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
        thinking_keep: None,
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

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
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

        let fast = pool.models.iter().find(|entry| entry.alias == "fast").unwrap();
        assert_eq!(fast.hint, "Cheap and quick.");
        assert_eq!(fast.llm.model, "kimi-k2-fast");
        assert_eq!(fast.llm.reasoning_effort.as_deref(), Some("high"));

        let thinky = pool.models.iter().find(|entry| entry.alias == "thinky").unwrap();
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
        let error = unknown_default.extract_secondary_model_pool(None).unwrap_err();
        assert!(error.contains("is not a [secondary_model.models] key"), "{error}");

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
        let error = force_with_table.extract_secondary_model_pool(None).unwrap_err();
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
        assert!(error.contains("required when [secondary_model].force is set"), "{error}");

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
}
