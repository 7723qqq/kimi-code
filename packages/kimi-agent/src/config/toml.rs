/// TOML configuration loading and saving.
///
/// Mirrors the TS `packages/agent-core/src/config/toml.ts`.
/// Provides TOML serialization/deserialization for KimiConfig.

use crate::config::types::KimiConfig;

/// Field-name pairs where the TS spelling (camelCase) is the serialized
/// form and the snake_case spelling is accepted as a serde alias. When a
/// config file written by both generations of tooling carries both keys,
/// serde rejects the duplicate (`duplicate field`) and the whole config
/// fails to load. Before deserializing, drop the snake_case twin so
/// mixed-generation files load — the camelCase value wins (it is the
/// serialized form).
const ALIAS_DUPLICATE_PAIRS: &[(&str, &str)] = &[
    ("defaultModel", "default_model"),
    ("apiKey", "api_key"),
    ("baseUrl", "base_url"),
    ("maxTokens", "max_tokens"),
];

/// Recursively drop snake_case alias twins where the camelCase spelling is
/// also present (see [`ALIAS_DUPLICATE_PAIRS`]).
fn dedupe_alias_fields(value: &mut toml::Value) {
    match value {
        toml::Value::Table(table) => {
            for (camel, snake) in ALIAS_DUPLICATE_PAIRS {
                if table.contains_key(*camel) && table.contains_key(*snake) {
                    table.remove(*snake);
                }
            }
            for child in table.iter_mut().map(|(_, v)| v) {
                dedupe_alias_fields(child);
            }
        }
        toml::Value::Array(items) => {
            for item in items {
                dedupe_alias_fields(item);
            }
        }
        _ => {}
    }
}

/// Parse a KimiConfig from a TOML string.
pub fn parse_config(toml_str: &str) -> Result<KimiConfig, String> {
    let mut value: toml::Value =
        toml::from_str(toml_str).map_err(|e| format!("TOML parse error: {e}"))?;
    dedupe_alias_fields(&mut value);
    value
        .try_into()
        .map_err(|e: toml::de::Error| format!("TOML parse error: {e}"))
}

/// Serialize a KimiConfig to a TOML string.
pub fn serialize_config(config: &KimiConfig) -> Result<String, String> {
    toml::to_string(config).map_err(|e| format!("TOML serialize error: {e}"))
}

/// Parse a config from a TOML file path.
/// Note: Actual file I/O should be done on the JS side.
/// This function exists for testing and simple use cases.
#[cfg(not(target_arch = "wasm32"))]
pub fn load_config_from_file(path: &str) -> Result<KimiConfig, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read config file {path}: {e}"))?;
    parse_config(&content)
}

/// Get a provider config by name from the KimiConfig.
pub fn get_provider_config<'a>(
    config: &'a KimiConfig,
    provider_name: &str,
) -> Option<&'a crate::config::types::ProviderConfig> {
    config.providers.as_ref()?.get(provider_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_minimal_config() {
        let toml_str = r#"
[agent]
engine = "rust"
max_turns = 100
"#;
        let config = parse_config(toml_str).unwrap();
        assert_eq!(config.agent.as_ref().unwrap().engine, Some("rust".into()));
        assert_eq!(config.agent.as_ref().unwrap().max_turns, Some(100));
    }

    #[test]
    fn test_parse_mixed_spelling_default_model() {
        // Both the TS (`defaultModel`) and snake_case (`default_model`)
        // spellings present: the duplicate must not fail the load, and the
        // camelCase (serialized form) value wins.
        let toml_str = r#"
defaultModel = "alpha"
default_model = "beta"

[providers.openai]
type = "openai"
apiKey = "sk-a"
api_key = "sk-b"
baseUrl = "https://a.example"
base_url = "https://b.example"
maxTokens = 1
max_tokens = 2
"#;
        let config = parse_config(toml_str).unwrap();
        assert_eq!(config.default_model.as_deref(), Some("alpha"));
        let openai = &config.providers.as_ref().unwrap()["openai"];
        assert_eq!(openai.api_key.as_deref(), Some("sk-a"));
        assert_eq!(openai.base_url.as_deref(), Some("https://a.example"));
        assert_eq!(openai.max_tokens, Some(1));
    }

    #[test]
    fn test_parse_snake_case_spelling_only() {
        // The alias alone still works (Rust-written configs).
        let toml_str = r#"
default_model = "beta"
"#;
        let config = parse_config(toml_str).unwrap();
        assert_eq!(config.default_model.as_deref(), Some("beta"));
    }

    #[test]
    fn test_parse_full_config() {
        let toml_str = r#"
[agent]
engine = "rust"
max_turns = 100
max_steps = 10

[agent.permission]
mode = "yolo"

[providers.openai]
type = "openai"
apiKey = "sk-test-123"
defaultModel = "gpt-4"

[providers.anthropic]
type = "anthropic"
apiKey = "sk-ant-test"
defaultModel = "claude-3-opus"

[background]
max_running_tasks = 5

[subagent]
default_model = "gpt-4-mini"
max_turns = 20
"#;
        let config = parse_config(toml_str).unwrap();

        // Agent
        let agent = config.agent.as_ref().unwrap();
        assert_eq!(agent.engine, Some("rust".into()));
        assert_eq!(agent.permission.as_ref().unwrap().mode, Some("yolo".into()));

        // Providers
        let providers = config.providers.as_ref().unwrap();
        assert_eq!(providers.len(), 2);
        assert_eq!(providers.get("openai").unwrap().api_key, Some("sk-test-123".into()));
        assert_eq!(providers.get("anthropic").unwrap().model, Some("claude-3-opus".into()));

        // Background
        assert_eq!(config.background.as_ref().unwrap().max_running_tasks, Some(5));

        // Subagent
        assert_eq!(config.subagent.as_ref().unwrap().default_model, Some("gpt-4-mini".into()));
    }

    #[test]
    fn test_serialize_roundtrip() {
        let config = parse_config(r#"
[agent]
engine = "rust"
max_turns = 50
"#).unwrap();

        let serialized = serialize_config(&config).unwrap();
        let deserialized = parse_config(&serialized).unwrap();
        assert_eq!(deserialized.agent.unwrap().engine, Some("rust".into()));
    }

    #[test]
    fn test_parse_invalid_toml() {
        let result = parse_config("invalid toml [[[ content");
        assert!(result.is_err());
    }

    #[test]
    fn test_get_provider_config() {
        let toml_str = r#"
[providers.openai]
apiKey = "sk-test"
"#;
        let config = parse_config(toml_str).unwrap();
        let provider = get_provider_config(&config, "openai");
        assert!(provider.is_some());
        assert_eq!(provider.unwrap().api_key, Some("sk-test".into()));

        let missing = get_provider_config(&config, "nonexistent");
        assert!(missing.is_none());
    }
}