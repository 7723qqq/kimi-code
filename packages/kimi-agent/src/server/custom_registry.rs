//! Custom-registry import and refresh (v2 `fetchCustomRegistry` /
//! `applyCustomRegistryEntries` from `@moonshot-ai/kimi-code-oauth`, driven by
//! `modelsDevImportService.doImportCustomRegistry` and branch 3 of
//! `refreshProviderModels`).
//!
//! A custom registry is a models.dev-shaped `api.json` served from a private
//! URL. Importing one writes every listed provider into the config with a
//! `source` blob (`{ kind: "apiJson", url, apiKey }`) parked on the provider;
//! the URL is the registry's stable identity, so a re-import removes providers
//! that disappeared upstream and a refresh rediscovers the rest. The same URL
//! may carry several API keys (key rotation): the fetch tries each candidate
//! until one succeeds.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use toml_edit::DocumentMut;

use crate::config::ProviderConfig;
use crate::config::write::{
    ModelAliasWrite, ProviderWrite, remove_model_aliases_of, remove_provider, set_default_model,
    write_model_alias, write_provider,
};

/// v2 `CUSTOM_REGISTRY_DEFAULT_MAX_CONTEXT`: the context size an entry falls
/// back to when it declares neither a context nor an output limit.
pub const DEFAULT_MAX_CONTEXT: u32 = 131_072;
/// v2 `CUSTOM_REGISTRY_DEFAULT_CAPABILITIES`: the capabilities an entry falls
/// back to when it carries no rich hints.
pub const DEFAULT_CAPABILITIES: [&str; 1] = ["tool_use"];
/// v2 `fetchCustomRegistry`'s timeout.
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
/// v2 `MAX_HTTP_RESPONSE_BYTES`.
const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
/// v2 `truncateUpstreamMessage`'s limit.
const UPSTREAM_MESSAGE_LIMIT: usize = 300;

/// The wire types a registry entry may declare (v2
/// `ALLOWED_PROVIDER_TYPES`); anything else makes the entry invalid.
const ALLOWED_PROVIDER_TYPES: [&str; 4] = ["anthropic", "openai", "openai_responses", "kimi"];

/// v2 `CustomRegistrySource`: where a registry-managed provider came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrySource {
    pub url: String,
    pub api_key: String,
}

impl RegistrySource {
    /// The blob parked on the provider (`providers.*.source`).
    pub fn to_value(&self) -> Value {
        json!({ "kind": "apiJson", "url": self.url, "apiKey": self.api_key })
    }

    /// v2 `readCustomRegistrySource`: the source a provider record carries, or
    /// `None` when it is not registry-managed.
    pub fn from_provider(provider: &ProviderConfig) -> Option<Self> {
        let source = provider.source.as_ref()?;
        if source.get("kind").and_then(Value::as_str) != Some("apiJson") {
            return None;
        }
        let url = source
            .get("url")
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty())?;
        let api_key = source.get("apiKey").and_then(Value::as_str)?;
        Some(Self {
            url: url.to_string(),
            api_key: api_key.to_string(),
        })
    }
}

/// v2 `CustomRegistryModelEntry`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RegistryModelEntry {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub limit: Option<RegistryLimit>,
    #[serde(default)]
    pub tool_call: Option<bool>,
    #[serde(default)]
    pub reasoning: Option<bool>,
    #[serde(default)]
    pub modalities: Option<RegistryModalities>,
    #[serde(default)]
    pub support_efforts: Option<Vec<String>>,
    #[serde(default)]
    pub default_effort: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RegistryLimit {
    #[serde(default)]
    pub context: Option<i64>,
    #[serde(default)]
    pub output: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RegistryModalities {
    #[serde(default)]
    pub input: Option<Vec<String>>,
    #[serde(default)]
    pub output: Option<Vec<String>>,
}

/// v2 `CustomRegistryProviderEntry`.
#[derive(Debug, Clone, Deserialize)]
pub struct RegistryProviderEntry {
    pub id: String,
    pub name: String,
    pub api: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    #[serde(default)]
    pub env: Option<Vec<String>>,
    pub models: BTreeMap<String, RegistryModelEntry>,
}

/// v2 `toModelEntry`: one model of a registry document, or `None` when it
/// carries no usable id.
fn to_model_entry(value: &Value) -> Option<RegistryModelEntry> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())?;
    let mut entry = RegistryModelEntry {
        id: id.to_string(),
        ..Default::default()
    };
    if let Some(name) = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
    {
        entry.name = Some(name.to_string());
    }
    if let Some(limit) = value.get("limit").and_then(Value::as_object) {
        let positive = |key: &str| {
            limit
                .get(key)
                .and_then(Value::as_i64)
                .filter(|value| *value > 0)
        };
        let context = positive("context");
        let output = positive("output");
        if context.is_some() || output.is_some() {
            entry.limit = Some(RegistryLimit { context, output });
        }
    }
    if let Some(flag) = value.get("tool_call").and_then(Value::as_bool) {
        entry.tool_call = Some(flag);
    }
    if let Some(flag) = value.get("reasoning").and_then(Value::as_bool) {
        entry.reasoning = Some(flag);
    }
    entry.support_efforts = string_array(value.get("support_efforts"));
    if let Some(effort) = value
        .get("default_effort")
        .and_then(Value::as_str)
        .filter(|effort| !effort.is_empty())
    {
        entry.default_effort = Some(effort.to_string());
    }
    if let Some(modalities) = value.get("modalities").and_then(Value::as_object) {
        let input = string_array(modalities.get("input"));
        let output = string_array(modalities.get("output"));
        if input.is_some() || output.is_some() {
            entry.modalities = Some(RegistryModalities { input, output });
        }
    }
    Some(entry)
}

fn string_array(value: Option<&Value>) -> Option<Vec<String>> {
    let items = value?.as_array()?;
    if !items.iter().all(Value::is_string) {
        return None;
    }
    Some(
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
    )
}

/// v2 `toProviderEntry`: one provider of a registry document, or `None` when
/// a required field is missing or the type is unsupported.
fn to_provider_entry(value: &Value) -> Option<RegistryProviderEntry> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())?;
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())?;
    let api = value
        .get("api")
        .and_then(Value::as_str)
        .filter(|api| !api.is_empty())?;
    let provider_type = value.get("type").and_then(Value::as_str)?;
    if !ALLOWED_PROVIDER_TYPES.contains(&provider_type) {
        return None;
    }
    let models = value.get("models").and_then(Value::as_object)?;
    let parsed: BTreeMap<String, RegistryModelEntry> = models
        .iter()
        .filter_map(|(key, raw)| to_model_entry(raw).map(|entry| (key.clone(), entry)))
        .collect();
    Some(RegistryProviderEntry {
        id: id.to_string(),
        name: name.to_string(),
        api: api.to_string(),
        provider_type: provider_type.to_string(),
        env: string_array(value.get("env")),
        models: parsed,
    })
}

/// v2 `truncateUpstreamMessage`: an upstream error body is quoted, not
/// trusted, so it is capped before it reaches a response message.
fn truncate_upstream_message(message: &str) -> String {
    let truncated: String = message.chars().take(UPSTREAM_MESSAGE_LIMIT).collect();
    if truncated.chars().count() == message.chars().count() {
        message.to_string()
    } else {
        format!("{truncated}…")
    }
}

/// v2 `fetchCustomRegistry`: fetch and validate an api.json document. The
/// returned record is keyed by the document's top-level provider key (which
/// may differ from `entry.id`); invalid entries are skipped with a warning
/// rather than aborting the whole fetch.
pub async fn fetch_registry(
    client: &reqwest::Client,
    source: &RegistrySource,
) -> Result<BTreeMap<String, RegistryProviderEntry>, String> {
    let mut request = client
        .get(&source.url)
        .header("accept", "application/json")
        .timeout(FETCH_TIMEOUT);
    if !source.api_key.is_empty() {
        request = request.bearer_auth(&source.api_key);
    }
    let mut response = request.send().await.map_err(|error| format!("{error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        // v2 `readApiErrorMessage`: surface the upstream's own message when
        // the body carries one, so a 401 from the registry is actionable.
        let detail = response
            .text()
            .await
            .ok()
            .and_then(|body| serde_json::from_str::<Value>(&body).ok())
            .and_then(|payload| {
                payload
                    .get("message")
                    .or_else(|| payload.get("error"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .filter(|message| !message.is_empty())
            .map(|message| truncate_upstream_message(&message));
        return Err(match detail {
            Some(detail) => format!("HTTP {status}: {detail}"),
            None => format!("HTTP {status}"),
        });
    }
    // v2 `readResponseBodyWithLimit`: bound the payload before parsing it.
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| format!("{error}"))? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_RESPONSE_BYTES {
            return Err(format!(
                "registry payload exceeds {MAX_RESPONSE_BYTES} bytes"
            ));
        }
    }
    let payload: Value =
        serde_json::from_slice(&body).map_err(|error| format!("payload is not JSON: {error}"))?;
    let Some(object) = payload.as_object() else {
        return Err("expected a JSON object keyed by provider id".to_string());
    };
    let mut out = BTreeMap::new();
    for (key, raw) in object {
        match to_provider_entry(raw) {
            Some(entry) => {
                out.insert(key.clone(), entry);
            }
            None => tracing::warn!(
                key = %key,
                url = %source.url,
                "skipping invalid custom-registry entry: missing required fields or unsupported type"
            ),
        }
    }
    Ok(out)
}

/// v2 `capabilitiesFromCustomEntry`.
fn capabilities_from_entry(model: &RegistryModelEntry) -> Vec<String> {
    let mut caps: Vec<String> = Vec::new();
    let mut push = |cap: &str| {
        if !caps.iter().any(|existing| existing == cap) {
            caps.push(cap.to_string());
        }
    };
    if model.tool_call == Some(true) {
        push("tool_use");
    }
    // Declaring concrete effort levels implies thinking support even when the
    // legacy `reasoning` boolean is absent.
    if model.reasoning == Some(true)
        || model
            .support_efforts
            .as_ref()
            .is_some_and(|e| !e.is_empty())
    {
        push("thinking");
    }
    let inputs = model
        .modalities
        .as_ref()
        .and_then(|m| m.input.as_ref())
        .map(Vec::as_slice)
        .unwrap_or_default();
    let outputs = model
        .modalities
        .as_ref()
        .and_then(|m| m.output.as_ref())
        .map(Vec::as_slice)
        .unwrap_or_default();
    if inputs.contains(&"image".to_string()) {
        push("image_in");
    }
    if inputs.contains(&"video".to_string()) {
        push("video_in");
    }
    if outputs.contains(&"image".to_string()) {
        push("image_out");
    }
    if outputs.contains(&"audio".to_string()) {
        push("audio_out");
    }
    caps
}

/// v2 `hasRichCapabilityHints`.
fn has_rich_capability_hints(model: &RegistryModelEntry) -> bool {
    model.tool_call.is_some()
        || model.reasoning.is_some()
        || model.modalities.is_some()
        || model.support_efforts.is_some()
}

/// v2 `resolveMaxContextSize`.
fn resolve_max_context(model: &RegistryModelEntry) -> u32 {
    let limit = model.limit.as_ref();
    if let Some(context) = limit.and_then(|l| l.context).filter(|context| *context > 0) {
        return context as u32;
    }
    if let Some(output) = limit.and_then(|l| l.output).filter(|output| *output > 0) {
        return output as u32;
    }
    DEFAULT_MAX_CONTEXT
}

/// v2 `resolveCapabilities`.
fn resolve_capabilities(model: &RegistryModelEntry) -> Vec<String> {
    if has_rich_capability_hints(model) {
        capabilities_from_entry(model)
    } else {
        DEFAULT_CAPABILITIES
            .iter()
            .map(|cap| (*cap).to_string())
            .collect()
    }
}

/// v2 `applyCustomRegistryProvider` (`@moonshot-ai/kimi-code-oauth`
/// `custom-registry.ts:410`)'s alias write: one upstream model as the
/// `{provider}/{model key}` alias.
pub fn alias_write(
    provider_id: &str,
    model_key: &str,
    model: &RegistryModelEntry,
) -> ModelAliasWrite {
    ModelAliasWrite {
        alias_id: format!("{provider_id}/{model_key}"),
        provider: provider_id.to_string(),
        model: model.id.clone(),
        max_context_size: resolve_max_context(model),
        display_name: Some(
            model
                .name
                .clone()
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| model.id.clone()),
        ),
        capabilities: Some(resolve_capabilities(model)),
        max_output_size: model
            .limit
            .as_ref()
            .and_then(|limit| limit.output)
            .filter(|output| *output > 0)
            .map(|output| output as u32),
        max_input_size: None,
        support_efforts: model.support_efforts.clone(),
        default_effort: model.default_effort.clone(),
        adaptive_thinking: None,
        protocol: None,
        beta_api: None,
        reasoning_key: None,
        off_effort: None,
        base_url: None,
    }
}

/// v2 `applyCustomRegistryProvider`'s provider write: the entry plus the
/// source blob the refresh rediscoveries from.
pub fn provider_write(entry: &RegistryProviderEntry, source: &RegistrySource) -> ProviderWrite {
    ProviderWrite {
        provider_type: entry.provider_type.clone(),
        api_key: (!source.api_key.is_empty()).then(|| source.api_key.clone()),
        api_key_env: None,
        base_url: Some(entry.api.clone()),
        default_model: None,
        source: Some(source.to_value()),
    }
}

/// The remote-owned alias fields (v2 `CUSTOM_REGISTRY_MODEL_FIELDS`): a
/// refresh rewrites these and preserves everything else the user added.
const REMOTE_OWNED_FIELDS: [&str; 7] = [
    "provider",
    "model",
    "max_context_size",
    "capabilities",
    "display_name",
    "support_efforts",
    "default_effort",
];

/// v2 `mergeRefreshedModelAlias`: write the upstream alias while preserving
/// the user's hand-added fields, unioning capabilities, and keeping the
/// `overrides` table.
fn write_merged_alias(document: &mut DocumentMut, alias: &ModelAliasWrite) -> Result<(), String> {
    let existing = document
        .get("models")
        .and_then(|models| models.as_table())
        .and_then(|models| models.get(&alias.alias_id))
        .and_then(|item| item.as_table());
    let extras: Vec<(String, toml_edit::Value)> = existing
        .into_iter()
        .flat_map(|table| table.iter())
        .filter(|(key, _)| !REMOTE_OWNED_FIELDS.contains(key) && *key != "overrides")
        .filter_map(|(key, item)| {
            item.as_value()
                .map(|value| (key.to_string(), value.clone()))
        })
        .collect();
    let existing_capabilities: Vec<String> = existing
        .and_then(|table| table.get("capabilities"))
        .and_then(|item| item.as_value())
        .and_then(|value| value.as_array())
        .map(|array| {
            array
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let overrides = existing
        .and_then(|table| table.get("overrides"))
        .and_then(|item| item.as_table())
        .cloned();

    write_model_alias(document, alias)?;

    let mut capabilities: Vec<String> = existing_capabilities;
    for cap in alias.capabilities.iter().flatten() {
        if !capabilities.contains(cap) {
            capabilities.push(cap.clone());
        }
    }
    let table = document
        .get_mut("models")
        .and_then(|models| models.as_table_mut())
        .and_then(|models| models.get_mut(&alias.alias_id))
        .and_then(|item| item.as_table_mut())
        .ok_or_else(|| format!("`models.{}` vanished while merging", alias.alias_id))?;
    if !capabilities.is_empty() {
        let mut array = toml_edit::Array::new();
        for cap in &capabilities {
            array.push(cap.clone());
        }
        table.insert("capabilities", toml_edit::Item::Value(array.into()));
    }
    for (key, value) in extras {
        table.insert(&key, toml_edit::Item::Value(value));
    }
    if let Some(overrides) = overrides {
        table.insert("overrides", toml_edit::Item::Table(overrides));
    }
    Ok(())
}

/// v2 `applyCustomRegistryEntries`: apply one registry import in memory.
/// Providers previously imported from the same URL that the document no
/// longer lists are removed (with their aliases); every listed entry is
/// removed-then-applied so a re-import is a clean rewrite.
pub fn apply_entries(
    document: &mut DocumentMut,
    entries: &BTreeMap<String, RegistryProviderEntry>,
    source: &RegistrySource,
) -> Result<(), String> {
    let surviving: Vec<&str> = entries.values().map(|entry| entry.id.as_str()).collect();
    let vanished: Vec<String> = document
        .get("providers")
        .and_then(|providers| providers.as_table())
        .into_iter()
        .flat_map(|providers| providers.iter())
        .filter(|(id, _)| !surviving.contains(id))
        .filter(|(_, item)| {
            item.as_table()
                .and_then(|table| table.get("source"))
                .and_then(|blob| blob.as_table())
                .is_some_and(|blob| {
                    blob.get("kind").and_then(|kind| kind.as_str()) == Some("apiJson")
                        && blob.get("url").and_then(|url| url.as_str()) == Some(source.url.as_str())
                })
        })
        .map(|(id, _)| id.to_string())
        .collect();
    for provider_id in vanished {
        remove_entry(document, &provider_id);
    }

    for entry in entries.values() {
        remove_provider(document, &entry.id);
        remove_model_aliases_of(document, &entry.id);
        clear_default_when_owned(document, &entry.id);
        write_provider(document, &entry.id, &provider_write(entry, source))?;
        for (model_key, model) in &entry.models {
            write_merged_alias(document, &alias_write(&entry.id, model_key, model))?;
        }
    }
    Ok(())
}

/// v2 `removeCustomRegistryProvider`'s default cleanup: the global default
/// goes when it pointed at one of the removed provider's aliases (registry
/// aliases all live under the `{provider}/{model}` prefix).
fn clear_default_when_owned(document: &mut DocumentMut, provider_id: &str) {
    let prefix = format!("{provider_id}/");
    let owned = document
        .get("default_model")
        .and_then(|item| item.as_str())
        .is_some_and(|default| default.starts_with(&prefix));
    if owned {
        set_default_model(document, None);
    }
}

/// v2 `applyCustomRegistryProvider`'s alias cleanup: drop every alias of the
/// provider that upstream no longer lists — any key shape, unlike the
/// prefix-scoped helper the managed-endpoint branch uses.
fn remove_vanished_aliases(document: &mut DocumentMut, provider_id: &str, keep: &[String]) {
    let Some(models) = document
        .get_mut("models")
        .and_then(|models| models.as_table_mut())
    else {
        return;
    };
    let doomed: Vec<String> = models
        .iter()
        .filter(|(key, item)| {
            !keep.iter().any(|kept| kept == key)
                && item.get("provider").and_then(|provider| provider.as_str()) == Some(provider_id)
        })
        .map(|(key, _)| key.to_string())
        .collect();
    for key in doomed {
        models.remove(&key);
    }
}

/// v2 `removeCustomRegistryProvider`: drop the provider, every alias that
/// referenced it, and the global default when it pointed at one of them.
pub fn remove_entry(document: &mut DocumentMut, provider_id: &str) {
    remove_provider(document, provider_id);
    remove_model_aliases_of(document, provider_id);
    clear_default_when_owned(document, provider_id);
}

/// v2 `applyCustomRegistryProvider` (the refresh path): write the provider
/// and merge its aliases without removing the provider first, so the user's
/// hand-added fields survive; aliases upstream no longer lists are dropped.
pub fn apply_entry(
    document: &mut DocumentMut,
    entry: &RegistryProviderEntry,
    source: &RegistrySource,
) -> Result<(), String> {
    write_provider(document, &entry.id, &provider_write(entry, source))?;
    let upstream_keys: Vec<String> = entry
        .models
        .keys()
        .map(|model_key| format!("{}/{}", entry.id, model_key))
        .collect();
    remove_vanished_aliases(document, &entry.id, &upstream_keys);
    for (model_key, model) in &entry.models {
        write_merged_alias(document, &alias_write(&entry.id, model_key, model))?;
    }
    Ok(())
}

/// The remote-owned alias comparison (v2 `providerModelsEqual`): the fields a
/// refresh owns must match; the user's hand-added fields and the capability
/// union do not make an alias look changed.
pub fn remote_fields_match(
    alias: &crate::config::ModelAliasConfig,
    write: &ModelAliasWrite,
) -> bool {
    alias.model.as_deref() == Some(write.model.as_str())
        && alias.max_context_size == Some(write.max_context_size)
        && alias.display_name == write.display_name
        && alias.support_efforts == write.support_efforts
        && alias.default_effort == write.default_effort
        && alias.max_output_size == write.max_output_size
        && write.capabilities.as_ref().is_none_or(|desired| {
            alias
                .capabilities
                .as_ref()
                .is_some_and(|have| desired.iter().all(|cap| have.contains(cap)))
        })
}

/// The provider-record comparison (v2 `providerConfigEqual`): the wire type,
/// endpoint, credential, and source blob all still say what the registry
/// says.
pub fn provider_config_matches(
    provider: &ProviderConfig,
    entry: &RegistryProviderEntry,
    source: &RegistrySource,
) -> bool {
    // An empty key is stored as no key at all (`provider_write`), so the
    // comparison uses the effective credential.
    let expected_key = (!source.api_key.is_empty()).then_some(source.api_key.as_str());
    provider.provider_type.as_deref() == Some(entry.provider_type.as_str())
        && provider.base_url.as_deref() == Some(entry.api.as_str())
        && provider.api_key.as_deref() == expected_key
        && RegistrySource::from_provider(provider).as_ref() == Some(source)
}

/// v2 `credentialEnvHints`: the env var each imported provider's credential
/// can be read from, for the import reply.
pub fn credential_env_hints(entries: &BTreeMap<String, RegistryProviderEntry>) -> Value {
    let mut hints = serde_json::Map::new();
    for entry in entries.values() {
        if let Some(env) = entry.env.as_ref().and_then(|env| env.first()) {
            hints.insert(entry.id.clone(), json!(env));
        }
    }
    Value::Object(hints)
}

/// The total alias count an import writes (v2's `modelsImported`).
pub fn model_count(entries: &BTreeMap<String, RegistryProviderEntry>) -> usize {
    entries.values().map(|entry| entry.models.len()).sum()
}

/// Seed the global default from the first entry's first model when nothing
/// was configured before the import (v2 `setDefaultWhenUnset`, whose
/// `hadDefault` reads the pre-apply value — a default the apply itself
/// cleared does not count as unset).
pub fn seed_default_when_unset(
    document: &mut DocumentMut,
    entries: &BTreeMap<String, RegistryProviderEntry>,
    had_default: bool,
) {
    if had_default {
        return;
    }
    let Some(first) = entries.values().next() else {
        return;
    };
    let Some(model_key) = first.models.keys().next() else {
        return;
    };
    set_default_model(document, Some(&format!("{}/{}", first.id, model_key)));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(json: Value) -> RegistryProviderEntry {
        to_provider_entry(&json).expect("a valid entry")
    }

    #[test]
    fn the_entry_validation_matches_v2() {
        // A complete entry parses; its models keep the document keys.
        let parsed = entry(json!({
            "id": "acme",
            "name": "Acme",
            "api": "https://registry.example.test/v1",
            "type": "openai",
            "env": ["ACME_API_KEY"],
            "models": {
                "big": { "id": "big-1", "name": "Big", "limit": { "context": 128000 } },
                "broken": { "name": "no id" },
            },
        }));
        assert_eq!(parsed.id, "acme");
        assert_eq!(parsed.models.len(), 1, "the id-less model is skipped");
        assert_eq!(parsed.models["big"].id, "big-1");

        // A missing required field or an unsupported type rejects the entry.
        assert!(
            to_provider_entry(
                &json!({ "id": "x", "name": "X", "api": "https://example.test", "type": "openai" })
            )
            .is_none()
        );
        assert!(to_provider_entry(&json!({ "id": "x", "name": "X", "api": "https://example.test", "type": "bedrock", "models": {} })).is_none());
        assert!(
            to_provider_entry(
                &json!({ "name": "X", "api": "https://example.test", "type": "kimi", "models": {} })
            )
            .is_none()
        );
    }

    #[test]
    fn the_capabilities_and_context_resolve_like_v2() {
        // Rich hints derive the capabilities.
        let rich = RegistryModelEntry {
            id: "m".into(),
            tool_call: Some(true),
            reasoning: Some(true),
            modalities: Some(RegistryModalities {
                input: Some(vec!["text".into(), "image".into()]),
                output: Some(vec!["text".into(), "image".into()]),
            }),
            ..Default::default()
        };
        assert_eq!(
            capabilities_from_entry(&rich),
            vec!["tool_use", "thinking", "image_in", "image_out"]
        );
        // Effort levels alone imply thinking.
        let efforts = RegistryModelEntry {
            id: "m".into(),
            support_efforts: Some(vec!["low".into()]),
            ..Default::default()
        };
        assert_eq!(capabilities_from_entry(&efforts), vec!["thinking"]);

        // No rich hints fall back to the default capability set and context.
        let plain = RegistryModelEntry {
            id: "m".into(),
            ..Default::default()
        };
        assert_eq!(resolve_capabilities(&plain), vec!["tool_use"]);
        assert_eq!(resolve_max_context(&plain), DEFAULT_MAX_CONTEXT);
        // The output limit backs the context when no context is declared.
        let output_only = RegistryModelEntry {
            id: "m".into(),
            limit: Some(RegistryLimit {
                context: None,
                output: Some(8192),
            }),
            ..Default::default()
        };
        assert_eq!(resolve_max_context(&output_only), 8192);
    }

    #[test]
    fn applying_entries_removes_vanished_providers_and_rewrites_the_rest() {
        let mut document: DocumentMut = r#"
default_model = "gone/old"

[providers.gone]
type = "openai"
base_url = "https://registry.example.test/v1"

[providers.gone.source]
kind = "apiJson"
url = "https://registry.example.test/api.json"
apiKey = "sk-old"

[models."gone/old"]
provider = "gone"
model = "old"
max_context_size = 1000

[providers.keep]
type = "openai"

[models."keep/hand"]
provider = "keep"
model = "hand"
max_context_size = 1000
"#
        .parse()
        .unwrap();

        let mut entries = BTreeMap::new();
        entries.insert(
            "acme".to_string(),
            entry(json!({
                "id": "acme",
                "name": "Acme",
                "api": "https://registry.example.test/v1",
                "type": "openai",
                "models": { "big": { "id": "big-1", "limit": { "context": 128000 } } },
            })),
        );
        let source = RegistrySource {
            url: "https://registry.example.test/api.json".into(),
            api_key: "sk-new".into(),
        };
        apply_entries(&mut document, &entries, &source).unwrap();
        let text = document.to_string();

        // The vanished same-URL provider and its aliases are gone; the
        // unrelated provider and its hand-written alias survive.
        assert!(!text.contains("[providers.gone]"), "{text}");
        assert!(!text.contains("gone/old"), "{text}");
        assert!(text.contains("[providers.keep]"), "{text}");
        assert!(text.contains("keep/hand"), "{text}");
        // The new entry is written with its source blob and alias.
        assert!(text.contains("[providers.acme]"), "{text}");
        assert!(text.contains("kind = \"apiJson\""), "{text}");
        assert!(text.contains("apiKey = \"sk-new\""), "{text}");
        assert!(text.contains("[models.\"acme/big\"]"), "{text}");
        assert!(text.contains("model = \"big-1\""), "{text}");
        assert!(text.contains("max_context_size = 128000"), "{text}");
    }

    #[test]
    fn a_refresh_merge_preserves_user_fields_and_unions_capabilities() {
        // The refresh path applies entries without removing the provider
        // first (v2 `applyCustomRegistryProvider`), so the merge is what runs:
        // hand-added fields and the overrides table survive, capabilities
        // union. The import path removes first, so it rewrites cleanly.
        let mut document: DocumentMut = r#"
[models."acme/big"]
provider = "acme"
model = "big-1"
max_context_size = 128000
capabilities = ["image_in"]
system_prompt = "keep me"

[models."acme/big".overrides]
max_context_size = 64000
"#
        .parse()
        .unwrap();

        let model = RegistryModelEntry {
            id: "big-1".into(),
            tool_call: Some(true),
            limit: Some(RegistryLimit {
                context: Some(128000),
                output: None,
            }),
            ..Default::default()
        };
        write_merged_alias(&mut document, &alias_write("acme", "big", &model)).unwrap();
        let text = document.to_string();

        assert!(text.contains("system_prompt = \"keep me\""), "{text}");
        assert!(text.contains("[models.\"acme/big\".overrides]"), "{text}");
        assert!(text.contains("image_in"), "{text}");
        assert!(text.contains("tool_use"), "{text}");
        assert!(text.contains("model = \"big-1\""), "{text}");
    }

    #[test]
    fn the_source_round_trips_through_the_provider_record() {
        let source = RegistrySource {
            url: "https://registry.example.test/api.json".into(),
            api_key: "sk-1".into(),
        };
        let provider = ProviderConfig {
            source: Some(source.to_value()),
            ..Default::default()
        };
        assert_eq!(RegistrySource::from_provider(&provider), Some(source));
        // A provider without a source blob is not registry-managed.
        assert_eq!(
            RegistrySource::from_provider(&ProviderConfig::default()),
            None
        );
    }

    #[test]
    fn the_credential_hints_map_provider_ids_to_their_env_key() {
        let mut entries = BTreeMap::new();
        entries.insert(
            "acme".to_string(),
            entry(json!({
                "id": "acme",
                "name": "Acme",
                "api": "https://registry.example.test/v1",
                "type": "openai",
                "env": ["ACME_API_KEY"],
                "models": { "big": { "id": "big-1", "limit": { "context": 1000 } } },
            })),
        );
        assert_eq!(
            credential_env_hints(&entries),
            json!({ "acme": "ACME_API_KEY" })
        );
        assert_eq!(model_count(&entries), 1);
    }
}
