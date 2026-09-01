//! Pure Rust configuration and credential manager for `kimi-agent` (P27 批 1).
//!
//! Loads and validates `config.toml` without depending on Node/Bun or any JS runtimes.
//! Discovers configuration from standard locations (`./config.toml`, `~/.kimi-code/config.toml`).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::permission::{HookDef, PermissionMode, PolicySnapshot};

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
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GitHubConfig {
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
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
    #[serde(default)]
    pub github: GitHubConfig,
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

    /// Automatically discover `config.toml` location:
    /// 1. `./config.toml` (current directory)
    /// 2. `~/.kimi-code/config.toml`
    /// 3. `~/.kimi/config.toml`
    pub fn discover() -> Result<(Self, PathBuf), String> {
        let cwd_config = PathBuf::from("config.toml");
        if cwd_config.is_file() {
            let config = Self::from_file(&cwd_config)?;
            return Ok((config, cwd_config));
        }

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

        Err("No config.toml discovered in ./config.toml or ~/.kimi-code/config.toml".into())
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
}
