//! Format-preserving `config.toml` writes (toml_edit).
//!
//! The REST provider routes mutate the same document the user edits, so
//! comments, key order and sections this crate does not parse must survive.
//! Writes go to [`config_write_path`] (the discovered file, or the default
//! location when none exists yet) and are atomic: temp file + rename.
//!
//! New tables are re-parsed from their own serialized text before insertion:
//! a programmatically built table carries no decor, and toml_edit renders the
//! newline that separates a header from the previous entry from the parsed
//! structure.

use std::path::PathBuf;

use toml_edit::{DocumentMut, Item, Table, Value};

use super::KimiConfig;

/// The file writes target: the discovered config file, or the location a new
/// file is created at, honoring the same env overrides as [`KimiConfig::discover`].
pub fn config_write_path() -> Result<PathBuf, String> {
    if let Ok((_, path)) = KimiConfig::discover() {
        return Ok(path);
    }
    if let Some(explicit) = std::env::var_os("KIMI_CONFIG_PATH") {
        return Ok(PathBuf::from(explicit));
    }
    if let Some(code_home) = std::env::var_os("KIMI_CODE_HOME") {
        return Ok(PathBuf::from(code_home).join("config.toml"));
    }
    if let Some(home) = super::dirs_home() {
        return Ok(home.join(".kimi-code").join("config.toml"));
    }
    Err("cannot resolve a config.toml location: set KIMI_CODE_HOME or KIMI_CONFIG_PATH".into())
}

/// Read the target document (empty when the file does not exist), apply the
/// mutation, write it back atomically and return the re-parsed config. An
/// explicit `path` (the file the server loaded) wins over discovery.
pub fn update_config<F>(path: Option<&std::path::Path>, mutate: F) -> Result<KimiConfig, String>
where
    F: FnOnce(&mut DocumentMut) -> Result<(), String>,
{
    let path = match path {
        Some(path) => path.to_path_buf(),
        None => config_write_path()?,
    };
    let existing = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let mut document: DocumentMut = existing
        .parse()
        .map_err(|error| format!("invalid TOML in {}: {error}", path.display()))?;
    mutate(&mut document)?;
    let text = document.to_string();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    let tmp = path.with_extension(format!("tmp.{}", fastrand::u32(..)));
    std::fs::write(&tmp, text.as_bytes())
        .map_err(|error| format!("cannot write {}: {error}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|error| format!("cannot replace {}: {error}", path.display()))?;
    text.parse::<KimiConfig>()
}

/// One `[providers.<id>]` entry to write.
#[derive(Debug, Clone, Default)]
pub struct ProviderWrite {
    pub provider_type: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
}

/// One `[models.<alias>]` entry to write.
#[derive(Debug, Clone)]
pub struct ModelAliasWrite {
    pub alias_id: String,
    pub provider: String,
    pub model: String,
    pub max_context_size: u32,
    pub display_name: Option<String>,
    pub capabilities: Option<Vec<String>>,
    pub max_output_size: Option<u32>,
    pub support_efforts: Option<Vec<String>>,
    pub default_effort: Option<String>,
    pub adaptive_thinking: Option<bool>,
    pub protocol: Option<String>,
    pub beta_api: Option<bool>,
}

fn table_at<'a>(document: &'a mut DocumentMut, key: &str) -> Result<&'a mut Table, String> {
    if document.as_table_mut().get(key).is_none() {
        // Implicit: only the children render headers, and their (parsed)
        // decor carries the separating newlines.
        let mut table = Table::new();
        table.set_implicit(true);
        document.as_table_mut().insert(key, Item::Table(table));
    }
    document[key]
        .as_table_mut()
        .ok_or_else(|| format!("`{key}` is not a TOML table"))
}

/// Serialize `table` under `path`, re-parse it and return the parsed item so
/// the insertion carries the decor toml_edit only assigns when parsing.
fn reparse_table(path: &[&str], table: Table) -> Result<Item, String> {
    let mut scratch = DocumentMut::new();
    let mut cursor: &mut Table = scratch.as_table_mut();
    for segment in &path[..path.len() - 1] {
        if cursor.get(segment).is_none() {
            let mut parent = Table::new();
            parent.set_implicit(true);
            cursor.insert(segment, Item::Table(parent));
        }
        cursor = cursor
            .get_mut(segment)
            .and_then(Item::as_table_mut)
            .ok_or_else(|| format!("`{segment}` is not a TOML table"))?;
    }
    let leaf = path.last().copied().unwrap_or_default();
    cursor.insert(leaf, Item::Table(table));

    let text = format!("\n{scratch}");
    let parsed: DocumentMut = text
        .parse()
        .map_err(|error: toml_edit::TomlError| error.to_string())?;
    let mut item: &Item = parsed.as_item();
    for segment in path {
        item = item
            .as_table()
            .and_then(|table| table.get(segment))
            .ok_or_else(|| format!("`{segment}` vanished while re-parsing"))?;
    }
    Ok(item.clone())
}

fn string_array(values: &[String]) -> Item {
    let mut array = toml_edit::Array::new();
    for value in values {
        array.push(value.clone());
    }
    Item::Value(Value::Array(array))
}

/// Write (or replace) one `[providers.<id>]` entry.
pub fn write_provider(
    document: &mut DocumentMut,
    id: &str,
    provider: &ProviderWrite,
) -> Result<(), String> {
    let mut table = Table::new();
    table.insert(
        "type",
        Item::Value(Value::from(provider.provider_type.clone())),
    );
    if let Some(api_key) = &provider.api_key {
        table.insert("api_key", Item::Value(Value::from(api_key.clone())));
    }
    if let Some(base_url) = &provider.base_url {
        table.insert("base_url", Item::Value(Value::from(base_url.clone())));
    }
    if let Some(default_model) = &provider.default_model {
        table.insert(
            "default_model",
            Item::Value(Value::from(default_model.clone())),
        );
    }
    let item = reparse_table(&["providers", id], table)?;
    table_at(document, "providers")?.insert(id, item);
    Ok(())
}

/// Drop `[providers.<id>]` when present.
pub fn remove_provider(document: &mut DocumentMut, id: &str) {
    if let Some(providers) = document
        .as_table_mut()
        .get_mut("providers")
        .and_then(Item::as_table_mut)
    {
        providers.remove(id);
    }
}

/// Write (or replace) one `[models.<alias>]` entry.
pub fn write_model_alias(
    document: &mut DocumentMut,
    alias: &ModelAliasWrite,
) -> Result<(), String> {
    let mut table = Table::new();
    table.insert("provider", Item::Value(Value::from(alias.provider.clone())));
    table.insert("model", Item::Value(Value::from(alias.model.clone())));
    table.insert(
        "max_context_size",
        Item::Value(Value::from(i64::from(alias.max_context_size))),
    );
    if let Some(display_name) = &alias.display_name {
        table.insert(
            "display_name",
            Item::Value(Value::from(display_name.clone())),
        );
    }
    if let Some(capabilities) = &alias.capabilities {
        table.insert("capabilities", string_array(capabilities));
    }
    if let Some(max_output_size) = alias.max_output_size {
        table.insert(
            "max_output_size",
            Item::Value(Value::from(i64::from(max_output_size))),
        );
    }
    if let Some(support_efforts) = &alias.support_efforts {
        table.insert("support_efforts", string_array(support_efforts));
    }
    if let Some(default_effort) = &alias.default_effort {
        table.insert(
            "default_effort",
            Item::Value(Value::from(default_effort.clone())),
        );
    }
    if let Some(adaptive_thinking) = alias.adaptive_thinking {
        table.insert(
            "adaptive_thinking",
            Item::Value(Value::from(adaptive_thinking)),
        );
    }
    if let Some(protocol) = &alias.protocol {
        table.insert("protocol", Item::Value(Value::from(protocol.clone())));
    }
    if let Some(beta_api) = alias.beta_api {
        table.insert("beta_api", Item::Value(Value::from(beta_api)));
    }
    let item = reparse_table(&["models", alias.alias_id.as_str()], table)?;
    table_at(document, "models")?.insert(alias.alias_id.as_str(), item);
    Ok(())
}

/// Drop every `[models.<alias>]` whose `provider` is `provider_id`.
pub fn remove_model_aliases_of(document: &mut DocumentMut, provider_id: &str) {
    remove_model_aliases_matching(document, provider_id, "", &[]);
}

/// Drop every alias of `provider_id` whose key starts with `key_prefix` and is
/// not listed in `keep` (the refresh keeps vanished upstream models out while
/// leaving user-authored aliases alone).
pub fn remove_model_aliases_matching(
    document: &mut DocumentMut,
    provider_id: &str,
    key_prefix: &str,
    keep: &[String],
) {
    let Some(models) = document
        .as_table_mut()
        .get_mut("models")
        .and_then(Item::as_table_mut)
    else {
        return;
    };
    let doomed: Vec<String> = models
        .iter()
        .filter(|(key, item)| {
            key.starts_with(key_prefix)
                && !keep.iter().any(|kept| kept == key)
                && item
                    .get("provider")
                    .and_then(Item::as_str)
                    .is_some_and(|provider| provider == provider_id)
        })
        .map(|(key, _)| key.to_string())
        .collect();
    for key in doomed {
        models.remove(&key);
    }
}

/// Set or clear the top-level `default_model` pointer.
pub fn set_default_model(document: &mut DocumentMut, alias: Option<&str>) {
    match alias {
        Some(alias) => {
            let table = document.as_table_mut();
            // Replace in place: a fresh `insert` would drop the key's decor
            // (the comment line above it), and the value's suffix carries the
            // newline that separates it from whatever follows.
            let mut value = Value::from(alias);
            let suffix = table
                .get("default_model")
                .and_then(Item::as_value)
                .and_then(|existing| existing.decor().suffix().cloned());
            value
                .decor_mut()
                .set_suffix(suffix.unwrap_or_else(|| "\n".into()));
            match table.get_mut("default_model") {
                Some(existing) => *existing = Item::Value(value),
                None => {
                    table.insert("default_model", Item::Value(value));
                }
            }
        }
        None => {
            document.as_table_mut().remove("default_model");
        }
    }
}

/// Set the top-level `default_provider` pointer (provider rename migration).
pub fn set_default_provider(document: &mut DocumentMut, provider_id: &str) {
    let table = document.as_table_mut();
    let mut value = Value::from(provider_id);
    let suffix = table
        .get("default_provider")
        .and_then(Item::as_value)
        .and_then(|existing| existing.decor().suffix().cloned());
    value
        .decor_mut()
        .set_suffix(suffix.unwrap_or_else(|| "\n".into()));
    match table.get_mut("default_provider") {
        Some(existing) => *existing = Item::Value(value),
        None => {
            table.insert("default_provider", Item::Value(value));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alias(alias_id: &str, model: &str) -> ModelAliasWrite {
        ModelAliasWrite {
            alias_id: alias_id.into(),
            provider: "managed:kimi-code".into(),
            model: model.into(),
            max_context_size: 200_000,
            display_name: Some("K3".into()),
            capabilities: Some(vec!["tools".into(), "thinking".into()]),
            max_output_size: None,
            support_efforts: Some(vec!["low".into()]),
            default_effort: None,
            adaptive_thinking: None,
            protocol: None,
            beta_api: None,
        }
    }

    #[test]
    fn writes_quote_special_keys_and_preserve_unknown_sections() {
        let mut document: DocumentMut = r#"
# keep this comment
default_model = "k3"

[secondary_model]
force = false

[providers.openai]
type = "openai"
"#
        .parse()
        .unwrap();

        write_provider(
            &mut document,
            "managed:kimi-code",
            &ProviderWrite {
                provider_type: "kimi".into(),
                api_key: Some("sk-test".into()),
                base_url: Some("https://example.test/v1".into()),
                default_model: Some("managed:kimi-code/k3".into()),
            },
        )
        .unwrap();
        write_model_alias(&mut document, &alias("managed:kimi-code/k3", "k3")).unwrap();
        set_default_model(&mut document, Some("managed:kimi-code/k3"));

        let text = document.to_string();
        // Special keys are quoted; the untouched sections survive.
        assert!(text.contains("[providers.\"managed:kimi-code\"]"), "{text}");
        assert!(text.contains("[models.\"managed:kimi-code/k3\"]"), "{text}");
        assert!(text.contains("# keep this comment"), "{text}");
        assert!(text.contains("[secondary_model]"), "{text}");
        assert!(text.contains("[providers.openai]"), "{text}");

        // The re-parsed config sees the new entries.
        let config: KimiConfig = text.parse().unwrap();
        let provider = config.providers.get("managed:kimi-code").unwrap();
        assert_eq!(provider.provider_type.as_deref(), Some("kimi"));
        let model = config.models.get("managed:kimi-code/k3").unwrap();
        assert_eq!(model.max_context_size, Some(200_000));
        assert_eq!(
            model.capabilities,
            Some(vec!["tools".to_string(), "thinking".to_string()])
        );
        assert_eq!(
            config.default_model.as_deref(),
            Some("managed:kimi-code/k3")
        );
    }

    #[test]
    fn written_documents_reparse_with_all_entries() {
        let mut document: DocumentMut =
            "default_model = \"\"\n\n[providers.openai]\ntype = \"openai\"\napi_key = \"sk-old\"\n"
                .parse()
                .unwrap();
        write_provider(
            &mut document,
            "kimi-code",
            &ProviderWrite {
                provider_type: "openai".into(),
                api_key: Some("sk-new".into()),
                base_url: Some("https://example.test/v1".into()),
                default_model: Some("kimi-code/k3".into()),
            },
        )
        .unwrap();
        write_model_alias(&mut document, &alias("kimi-code/k3", "k3")).unwrap();
        set_default_model(&mut document, Some("kimi-code/k3"));

        let text = document.to_string();
        // The rendered document is valid TOML (tables carry their newlines).
        let reparsed: DocumentMut = text
            .parse()
            .unwrap_or_else(|error| panic!("{error}\n---\n{text}"));
        assert_eq!(reparsed["default_model"].as_str(), Some("kimi-code/k3"));
        assert_eq!(
            reparsed["providers"]["kimi-code"]["type"].as_str(),
            Some("openai")
        );
        assert!(reparsed["providers"].get("openai").is_some(), "{text}");
        assert_eq!(
            reparsed["models"]["kimi-code/k3"]["model"].as_str(),
            Some("k3")
        );
        let config: KimiConfig = text.parse().unwrap();
        assert!(config.providers.contains_key("kimi-code"));
        assert!(config.providers.contains_key("openai"));
    }

    #[test]
    fn removes_providers_and_their_aliases() {
        let mut document: DocumentMut = r#"
[providers.kimi]
type = "openai"

[providers.other]
type = "anthropic"

[models."kimi/k3"]
provider = "kimi"
model = "k3"
max_context_size = 1000

[models."other/claude"]
provider = "other"
model = "claude"
max_context_size = 2000
"#
        .parse()
        .unwrap();

        remove_provider(&mut document, "kimi");
        remove_model_aliases_of(&mut document, "kimi");

        let text = document.to_string();
        // The removed provider's table and aliases are gone; the other survives.
        assert!(!text.contains("[providers.kimi]"), "{text}");
        assert!(!text.contains("kimi/k3"), "{text}");
        assert!(text.contains("[providers.other]"), "{text}");
        assert!(text.contains("other/claude"), "{text}");
    }

    #[test]
    fn clearing_the_default_model_removes_the_pointer() {
        let mut document: DocumentMut = "default_model = \"k3\"\n".parse().unwrap();
        set_default_model(&mut document, None);
        assert!(!document.to_string().contains("default_model"));
    }
}
