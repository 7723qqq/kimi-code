//! The models.dev catalog proxy (v2 `app/kosongConfig/modelsDevUpstream.ts` +
//! `modelsDev.ts` + `modelsDevImportService.ts`).
//!
//! v2 serves the provider catalog from `https://models.dev/api.json`: a
//! 10-minute TTL cache with in-flight dedup, a stale-cache then built-in
//! snapshot fallback chain, and an import action that writes the chosen
//! entry into the config's `[providers.*]` / `[models.*]` sections. The
//! fork's catalog routes previously served a hardcoded list; this module is
//! the proxy half, and the hardcoded list stays as the built-in snapshot
//! the fallback chain ends in (the fork's equivalent of v2's
//! `BUILT_IN_MODELS_DEV_JSON`).
//!
//! The mapping is a port of v2's `modelsDev.ts`: the wire type resolves
//! from the entry's explicit `type`, then the npm/id inference, then the
//! openai default (bedrock/cohere are proprietary-SDK rejects); the base
//! URL resolves from the caller's override, then the catalog's `api`, then
//! the needs-base-url state; models filter to usable chat models and map
//! their modalities and reasoning options onto capabilities.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::rpc::types::BoxFuture;

/// v2 `MODELS_DEV_URL`.
pub const MODELS_DEV_URL: &str = "https://models.dev/api.json";
/// v2 `CACHE_TTL_MS`.
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
/// v2 `UPSTREAM_FETCH_TIMEOUT_MS`.
const UPSTREAM_FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// v2 passes the outbound user agent; the engine has no host to ask.
const USER_AGENT: &str = "kimi-agent";

/// The wire types v2 knows (`KNOWN_WIRE_TYPES`); anything else is a reject.
const KNOWN_WIRE_TYPES: [&str; 6] = [
    "anthropic",
    "openai",
    "kimi",
    "google-genai",
    "openai_responses",
    "vertexai",
];

/// v2 `PROVIDER_ID_PATTERN` (`^[\p{L}\p{N}][\p{L}\p{N}\-_ ]*$`): a letter or
/// digit first, then letters, digits, dash, underscore or space.
pub fn is_provider_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(first) if first.is_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ' '))
}

// ── catalog types (v2 `modelsDev.ts`) ─────────────────────────────────────

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ModelEntry {
    pub id: Option<String>,
    pub name: Option<String>,
    pub family: Option<String>,
    pub limit: Option<ModelLimit>,
    pub tool_call: Option<bool>,
    pub reasoning: Option<bool>,
    pub reasoning_options: Option<Vec<ReasoningOption>>,
    pub status: Option<String>,
    pub provider: Option<ModelProviderOverride>,
    pub dynamically_loaded_tools: Option<bool>,
    pub interleaved: Option<Value>,
    pub modalities: Option<Modalities>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ModelLimit {
    pub context: Option<i64>,
    pub input: Option<i64>,
    pub output: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ReasoningOption {
    pub r#type: Option<String>,
    pub values: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ModelProviderOverride {
    pub npm: Option<String>,
    pub api: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Modalities {
    pub input: Option<Vec<String>>,
    pub output: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProviderEntry {
    pub id: Option<String>,
    pub name: Option<String>,
    pub api: Option<String>,
    pub env: Option<Vec<String>>,
    pub npm: Option<String>,
    pub r#type: Option<String>,
    pub models: Option<BTreeMap<String, ModelEntry>>,
}

/// v2 `ModelsDevCatalog`.
pub type Catalog = BTreeMap<String, ProviderEntry>;

// ── import resolution (v2 `resolveModelsDevImport`) ───────────────────────

/// v2 `ModelsDevImportResolution`.
#[derive(Debug, Clone, PartialEq)]
pub enum ImportResolution {
    Ok {
        wire: String,
        guessed: bool,
        base_url: Option<String>,
    },
    NeedsBaseUrl {
        wire: String,
        guessed: bool,
    },
    Invalid {
        reason: &'static str,
    },
}

fn is_wire_type(value: &str) -> bool {
    KNOWN_WIRE_TYPES.contains(&value)
}

fn has_embedding_marker(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let lower = value.to_lowercase();
    lower.contains("embedding")
        || lower
            .split(['-', '_', '/'])
            .any(|segment| segment == "embed")
}

/// v2 `isUsableChatModel`: the output must carry text, the status must not
/// be deprecated/alpha, and nothing may look like an embedding model.
fn is_usable_chat_model(model: &ModelEntry) -> bool {
    if let Some(outputs) = model.modalities.as_ref().and_then(|m| m.output.as_ref())
        && !outputs.iter().any(|modality| modality == "text")
    {
        return false;
    }
    if matches!(model.status.as_deref(), Some("deprecated") | Some("alpha")) {
        return false;
    }
    !has_embedding_marker(model.family.as_deref())
        && !has_embedding_marker(model.id.as_deref())
        && !has_embedding_marker(model.name.as_deref())
}

fn infer_declared_wire(entry: &ProviderEntry) -> Option<&'static str> {
    if let Some(explicit) = entry.r#type.as_deref()
        && is_wire_type(explicit)
    {
        return KNOWN_WIRE_TYPES.iter().find(|w| **w == explicit).copied();
    }
    let npm = entry.npm.as_deref().unwrap_or_default().to_lowercase();
    let id = entry.id.as_deref().unwrap_or_default().to_lowercase();
    if npm.contains("anthropic") || id.contains("anthropic") || id.contains("claude") {
        return Some("anthropic");
    }
    if id.contains("vertex") {
        return Some("vertexai");
    }
    if npm.contains("google") || id.contains("google") || id.contains("gemini") {
        return Some("google-genai");
    }
    if npm.contains("openai") || id.contains("openai") {
        return Some("openai");
    }
    None
}

/// v2 `resolveModelsDevWire`: the explicit type when it is a known wire
/// type, the inference, then the openai default — with bedrock/cohere
/// rejected as proprietary SDKs.
fn resolve_wire(entry: &ProviderEntry) -> Option<&'static str> {
    if let Some(explicit) = entry.r#type.as_deref() {
        if is_wire_type(explicit) {
            return KNOWN_WIRE_TYPES.iter().find(|w| **w == explicit).copied();
        }
        if !explicit.is_empty() {
            return None;
        }
    }
    if let Some(declared) = infer_declared_wire(entry) {
        return Some(declared);
    }
    let npm = entry.npm.as_deref().unwrap_or_default().to_lowercase();
    if npm.contains("amazon-bedrock") || npm.contains("cohere") {
        return None;
    }
    Some("openai")
}

/// v2 `adaptBaseUrlForWire`: the anthropic route strips a trailing `/v1`.
fn adapt_base_url(base_url: &str, wire: &str) -> String {
    if wire != "anthropic" {
        return base_url.to_string();
    }
    let trimmed = base_url.trim_end_matches('/');
    match trimmed.strip_suffix("/v1") {
        Some(stripped) => stripped.to_string(),
        None => trimmed.to_string(),
    }
}

/// v2 `modelsDevBaseUrl`: the catalog's `api`, unless it carries a
/// placeholder.
fn models_dev_base_url(entry: &ProviderEntry, wire: &str) -> Option<String> {
    let api = entry.api.as_deref()?;
    if api.is_empty() || api.contains("${") {
        return None;
    }
    Some(adapt_base_url(api, wire))
}

/// v2 `modelsDevEndpointRequired`: whether the entry cannot be used without
/// an explicit endpoint.
fn endpoint_required(entry: &ProviderEntry, wire: &str) -> bool {
    if entry.api.as_deref().is_some_and(|api| !api.is_empty()) {
        return true;
    }
    let npm = entry.npm.as_deref().unwrap_or_default().to_lowercase();
    match wire {
        "openai" | "openai_responses" => npm != "@ai-sdk/openai",
        "anthropic" => npm != "@ai-sdk/anthropic",
        _ => false,
    }
}

/// v2 `resolveModelsDevImport`.
pub fn resolve_import(entry: &ProviderEntry, user_base_url: Option<&str>) -> ImportResolution {
    let Some(wire) = resolve_wire(entry) else {
        return ImportResolution::Invalid {
            reason: if entry.r#type.as_deref().is_some_and(|t| !t.is_empty()) {
                "unknown-explicit-type"
            } else {
                "proprietary-sdk"
            },
        };
    };
    let guessed = infer_declared_wire(entry).is_none();
    if let Some(user_base_url) = user_base_url {
        let trimmed = user_base_url.trim();
        if trimmed.is_empty() {
            return ImportResolution::Invalid {
                reason: "empty-base-url",
            };
        }
        if trimmed.contains("${") {
            return ImportResolution::Invalid {
                reason: "placeholder-base-url",
            };
        }
        return ImportResolution::Ok {
            wire: wire.to_string(),
            guessed,
            base_url: Some(adapt_base_url(trimmed, wire)),
        };
    }
    if let Some(url) = models_dev_base_url(entry, wire) {
        return ImportResolution::Ok {
            wire: wire.to_string(),
            guessed,
            base_url: Some(url),
        };
    }
    if endpoint_required(entry, wire) {
        return ImportResolution::NeedsBaseUrl {
            wire: wire.to_string(),
            guessed,
        };
    }
    ImportResolution::Ok {
        wire: wire.to_string(),
        guessed,
        base_url: None,
    }
}

// ── model mapping (v2 `modelsDevProviderModels`) ──────────────────────────

/// v2 `ModelsDevModel` — one importable model of a catalog entry.
#[derive(Debug, Clone, PartialEq)]
pub struct DevModel {
    pub id: String,
    pub name: Option<String>,
    pub max_output_size: Option<i64>,
    /// The capped input size (v2 `capability.max_input_tokens`): the
    /// context window clamped to the declared input limit.
    pub max_input_size: Option<i64>,
    pub reasoning_key: Option<String>,
    pub support_efforts: Option<Vec<String>>,
    pub off_effort: Option<String>,
    pub always_thinking: Option<bool>,
    pub protocol: Option<String>,
    pub base_url: Option<String>,
    pub max_context_size: i64,
    pub image_in: bool,
    pub video_in: bool,
    pub audio_in: bool,
    pub thinking: bool,
    pub tool_use: bool,
    pub dynamically_loaded_tools: bool,
}

struct ThinkingOptions {
    efforts: Option<Vec<String>>,
    off_effort: Option<String>,
    has_toggle: bool,
    always_thinking: Option<bool>,
}

/// v2 `modelsDevThinkingOptions`.
fn thinking_options(options: Option<&Vec<ReasoningOption>>) -> ThinkingOptions {
    let Some(options) = options else {
        return ThinkingOptions {
            efforts: None,
            off_effort: None,
            has_toggle: false,
            always_thinking: None,
        };
    };
    let mut efforts: Option<Vec<String>> = None;
    let mut off_effort: Option<String> = None;
    let mut has_toggle = false;
    for option in options {
        match option.r#type.as_deref() {
            Some("toggle") => has_toggle = true,
            Some("effort") => {
                let Some(values) = option.values.as_ref() else {
                    continue;
                };
                let has_null_tier = values.iter().any(|v| v.is_null());
                let levels: Vec<String> = values
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .filter(|level| !level.is_empty())
                    .collect();
                if let Some(off) = levels.iter().find(|v| v.eq_ignore_ascii_case("none")) {
                    off_effort = Some(off.clone());
                } else if has_null_tier {
                    off_effort = Some("none".to_string());
                }
                let selectable: Vec<String> = levels
                    .into_iter()
                    .filter(|level| !level.eq_ignore_ascii_case("none"))
                    .collect();
                if !selectable.is_empty() {
                    efforts = Some(selectable);
                }
            }
            _ => {}
        }
    }
    let always_thinking =
        (efforts.is_some() && off_effort.is_none() && !has_toggle).then_some(true);
    ThinkingOptions {
        efforts,
        off_effort,
        has_toggle,
        always_thinking,
    }
}

/// v2 `modelsDevReasoningKey`: the interleaved field, when it names one.
fn reasoning_key(interleaved: Option<&Value>) -> Option<String> {
    let field = interleaved?.get("field")?.as_str()?.trim();
    (!field.is_empty()).then(|| field.to_string())
}

/// v2 `modelsDevModelToCapability`.
fn model_to_capability(model: &ModelEntry) -> Option<DevModel> {
    let id = model.id.as_deref().filter(|id| !id.is_empty())?;
    let context = model.limit.as_ref().and_then(|l| l.context)?;
    if context <= 0 {
        return None;
    }
    if !is_usable_chat_model(model) {
        return None;
    }
    let inputs = model
        .modalities
        .as_ref()
        .and_then(|m| m.input.as_ref())
        .cloned()
        .unwrap_or_default();
    let thinking = thinking_options(model.reasoning_options.as_ref());
    let max_input_tokens = model
        .limit
        .as_ref()
        .and_then(|l| l.input)
        .filter(|input| *input > 0)
        .map(|input| input.min(context));
    let efforts = thinking.efforts.clone();
    Some(DevModel {
        id: id.to_string(),
        name: model
            .name
            .as_deref()
            .filter(|name| !name.is_empty())
            .map(str::to_string),
        max_output_size: model
            .limit
            .as_ref()
            .and_then(|l| l.output)
            .filter(|o| *o > 0),
        max_input_size: max_input_tokens,
        reasoning_key: reasoning_key(model.interleaved.as_ref()),
        support_efforts: efforts,
        off_effort: thinking.off_effort.clone(),
        always_thinking: thinking.always_thinking,
        protocol: None,
        base_url: None,
        max_context_size: context,
        image_in: inputs.iter().any(|modality| modality == "image"),
        video_in: inputs.iter().any(|modality| modality == "video"),
        audio_in: inputs.iter().any(|modality| modality == "audio"),
        thinking: model.reasoning.unwrap_or(false)
            || thinking.always_thinking.is_some()
            || thinking.efforts.is_some()
            || thinking.has_toggle,
        tool_use: model.tool_call.unwrap_or(true),
        dynamically_loaded_tools: model.dynamically_loaded_tools == Some(true),
    })
    .map(|mut model| {
        model.max_context_size = model.max_context_size.min(context);
        model
    })
}

fn infer_override_wire(npm: &str) -> Option<&'static str> {
    let normalized = npm.to_lowercase();
    if normalized.contains("anthropic") {
        return Some("anthropic");
    }
    if normalized.contains("vertex") {
        return Some("vertexai");
    }
    if normalized.contains("google") {
        return Some("google-genai");
    }
    if normalized.contains("openai") {
        return Some("openai");
    }
    None
}

/// v2 `applyModelProviderOverride`.
fn apply_provider_override(
    model: Option<DevModel>,
    raw: &ModelEntry,
    entry: &ProviderEntry,
    provider_wire: Option<&str>,
) -> Option<DevModel> {
    let model = model?;
    let Some(override_spec) = raw.provider.as_ref() else {
        return Some(model);
    };
    let override_npm = override_spec.npm.as_deref().map(str::to_lowercase);
    if let Some(npm) = override_npm.as_deref()
        && (npm.contains("amazon-bedrock") || npm.contains("cohere"))
    {
        return None;
    }
    let override_wire = override_npm
        .as_deref()
        .and_then(infer_override_wire)
        .or(provider_wire);
    let Some(override_wire) = override_wire else {
        return Some(model);
    };
    let raw_api = override_spec.api.as_deref();
    let api = raw_api.or(entry.api.as_deref());
    let usable_api = api.filter(|api| !api.is_empty() && !api.contains("${"));
    if Some(override_wire) == provider_wire {
        if raw_api.is_some_and(|api| api.contains("${")) {
            return None;
        }
        if let Some(api) = usable_api
            && api != entry.api.as_deref().unwrap_or_default()
        {
            return Some(DevModel {
                base_url: Some(adapt_base_url(api, override_wire)),
                ..model
            });
        }
        return Some(model);
    }
    if override_wire == "anthropic"
        && let Some(api) = usable_api
    {
        return Some(DevModel {
            protocol: Some("anthropic".to_string()),
            base_url: Some(adapt_base_url(api, "anthropic")),
            ..model
        });
    }
    None
}

/// v2 `modelsDevProviderModels`.
pub fn provider_models(entry: &ProviderEntry) -> Vec<DevModel> {
    let provider_wire = resolve_wire(entry);
    entry
        .models
        .as_ref()
        .map(|models| models.values().collect::<Vec<_>>())
        .unwrap_or_default()
        .iter()
        .filter_map(|raw| {
            apply_provider_override(model_to_capability(raw), raw, entry, provider_wire)
        })
        .map(|mut model| {
            // v2 `wireHasProtocolThinkingDisable`: the anthropic and kimi
            // wires encode "thinking off" on the wire, so an always-thinking
            // flag would fight the effort selector — it is dropped there.
            let protocol = model
                .protocol
                .clone()
                .or_else(|| provider_wire.map(str::to_string));
            if model.always_thinking == Some(true)
                && matches!(protocol.as_deref(), Some("anthropic") | Some("kimi"))
            {
                model.always_thinking = None;
            }
            model
        })
        .collect()
}

// ── item mapping (v2 `toModelsDevProviderItem`) ───────────────────────────

fn capability_strings(model: &DevModel) -> Option<Vec<String>> {
    let mut caps = Vec::new();
    if model.image_in {
        caps.push("image_in".to_string());
    }
    if model.video_in {
        caps.push("video_in".to_string());
    }
    if model.audio_in {
        caps.push("audio_in".to_string());
    }
    if model.thinking {
        caps.push("thinking".to_string());
    }
    if model.tool_use {
        caps.push("tool_use".to_string());
    }
    if model.dynamically_loaded_tools {
        caps.push("dynamically_loaded_tools".to_string());
    }
    (!caps.is_empty()).then_some(caps)
}

/// v2 `modelsDevModelToRecord`'s capability mapping: the item vocabulary,
/// with `thinking` renamed to `always_thinking` on an always-thinking model
/// (the fork's config engine reads both spellings — `always_thinking` is
/// what makes the thinking default stick).
fn record_capabilities(model: &DevModel) -> Option<Vec<String>> {
    let caps = capability_strings(model)?;
    if model.always_thinking == Some(true) {
        Some(
            caps.into_iter()
                .map(|cap| {
                    if cap == "thinking" {
                        "always_thinking".to_string()
                    } else {
                        cap
                    }
                })
                .collect(),
        )
    } else {
        Some(caps)
    }
}

/// v2 `modelsDevModelToRecord`: the imported model as a `[models.*]` record
/// under the `{provider}/{model.id}` alias.
pub fn model_write(provider_id: &str, model: &DevModel) -> crate::config::write::ModelAliasWrite {
    crate::config::write::ModelAliasWrite {
        alias_id: format!("{provider_id}/{}", model.id),
        provider: provider_id.to_string(),
        model: model.id.clone(),
        max_context_size: model.max_context_size as u32,
        display_name: model.name.clone(),
        capabilities: record_capabilities(model),
        max_output_size: model.max_output_size.map(|size| size as u32),
        max_input_size: model.max_input_size.map(|size| size as u32),
        support_efforts: model.support_efforts.clone(),
        default_effort: None,
        adaptive_thinking: None,
        protocol: model.protocol.clone(),
        beta_api: None,
        reasoning_key: model.reasoning_key.clone(),
        off_effort: model.off_effort.clone(),
        base_url: model.base_url.clone(),
    }
}

fn model_item(model: &DevModel) -> Value {
    let mut item = json!({
        "id": model.id,
        "max_context_size": model.max_context_size,
        "reasoning": model.thinking,
    });
    let obj = item.as_object_mut().expect("json object");
    if let Some(name) = &model.name {
        obj.insert("name".to_string(), json!(name));
    }
    if let Some(caps) = capability_strings(model) {
        obj.insert("capabilities".to_string(), json!(caps));
    }
    item
}

/// v2 `toModelsDevProviderItem`: the catalog entry in the shape the REST
/// surface and the web client read.
pub fn provider_item(id: &str, entry: &ProviderEntry) -> Value {
    let resolution = resolve_import(entry, None);
    let models = provider_models(entry);
    let mut item = json!({
        "id": id,
        "name": entry.name.as_deref().filter(|n| !n.is_empty()).unwrap_or(id),
        "env_key": entry.env.as_ref().and_then(|env| env.first()).cloned(),
        "models": models.iter().map(model_item).collect::<Vec<_>>(),
    });
    let obj = item.as_object_mut().expect("json object");
    match resolution {
        ImportResolution::Ok {
            wire,
            guessed,
            base_url,
        } => {
            obj.insert("wire_type".to_string(), json!(wire));
            obj.insert("base_url".to_string(), json!(base_url));
            obj.insert("guessed".to_string(), json!(guessed));
            obj.insert("needs_base_url".to_string(), json!(false));
            obj.insert("rejected".to_string(), json!(false));
            obj.insert("reject_reason".to_string(), Value::Null);
        }
        ImportResolution::NeedsBaseUrl { wire, guessed } => {
            obj.insert("wire_type".to_string(), json!(wire));
            obj.insert("base_url".to_string(), Value::Null);
            obj.insert("guessed".to_string(), json!(guessed));
            obj.insert("needs_base_url".to_string(), json!(true));
            obj.insert("rejected".to_string(), json!(false));
            obj.insert("reject_reason".to_string(), Value::Null);
        }
        ImportResolution::Invalid { reason } => {
            obj.insert("wire_type".to_string(), Value::Null);
            obj.insert("base_url".to_string(), Value::Null);
            obj.insert("guessed".to_string(), json!(false));
            obj.insert("needs_base_url".to_string(), json!(false));
            obj.insert("rejected".to_string(), json!(true));
            obj.insert("reject_reason".to_string(), json!(reason));
        }
    }
    item
}

/// Every catalog entry mapped to its item, in catalog order.
pub fn provider_items(catalog: &Catalog) -> Value {
    json!({
        "items": catalog
            .iter()
            .map(|(id, entry)| provider_item(id, entry))
            .collect::<Vec<_>>()
    })
}

// ── the cache (v2 `getModelsDevCatalog`) ──────────────────────────────────

struct Cached {
    catalog: Value,
    fetched_at: Instant,
}

type Fetcher = Arc<dyn Fn() -> BoxFuture<'static, Result<Value, String>> + Send + Sync>;

/// The in-flight fetch cell: one fetch per stale window, shared by every
/// waiter (v2's `inFlight`).
type InFlight = Arc<tokio::sync::OnceCell<Result<Value, String>>>;

/// The catalog cache: TTL, in-flight dedup, and the stale-cache fallback a
/// failed fetch lands in (v2 `fetchAndCache`). The built-in snapshot is the
/// caller's concern — this type only ever holds fetched or stale catalogs.
#[derive(Default)]
pub struct CatalogCache {
    cached: Mutex<Option<Cached>>,
    in_flight: Mutex<Option<InFlight>>,
    fetcher: Mutex<Option<Fetcher>>,
}

impl CatalogCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the fetch (tests).
    pub fn with_fetcher(self, fetcher: Fetcher) -> Self {
        *self.fetcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(fetcher);
        self
    }

    /// Seed the cache with an entry fetched `age` ago (tests): the TTL
    /// check is the only clock the cache has.
    #[cfg(test)]
    pub fn seed(self, catalog: Value, age: Duration) -> Self {
        *self.cached.lock().unwrap_or_else(|e| e.into_inner()) = Some(Cached {
            catalog,
            fetched_at: Instant::now() - age,
        });
        self
    }

    /// The catalog, fetching when the cache is stale (v2
    /// `getModelsDevCatalog`). A failed fetch falls back to the stale cache;
    /// with no cache at all the error reaches the caller, whose built-in
    /// snapshot ends the chain.
    pub async fn catalog(&self) -> Result<Value, String> {
        {
            let cache = self.cached.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(cached) = cache.as_ref()
                && cached.fetched_at.elapsed() < CACHE_TTL
            {
                return Ok(cached.catalog.clone());
            }
        }
        let cell = {
            let mut in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
            in_flight
                .get_or_insert_with(|| Arc::new(tokio::sync::OnceCell::new()))
                .clone()
        };
        let result = cell.get_or_init(|| self.fetch_and_cache()).await;
        if result.is_err() {
            // A failed fetch leaves no cache behind: drop the cell so the
            // next request retries instead of re-reading a stored error.
            let mut in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(current) = in_flight.as_ref()
                && Arc::ptr_eq(current, &cell)
            {
                *in_flight = None;
            }
        }
        result.clone()
    }

    async fn fetch_and_cache(&self) -> Result<Value, String> {
        let fetcher = self
            .fetcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let result = match fetcher {
            Some(fetcher) => fetcher().await,
            None => fetch_upstream().await,
        };
        match result {
            Ok(catalog) => {
                let mut cache = self.cached.lock().unwrap_or_else(|e| e.into_inner());
                *cache = Some(Cached {
                    catalog: catalog.clone(),
                    fetched_at: Instant::now(),
                });
                Ok(catalog)
            }
            Err(error) => {
                // v2: a failed fetch serves the stale cache when there is one.
                let cache = self.cached.lock().unwrap_or_else(|e| e.into_inner());
                match cache.as_ref() {
                    Some(cached) => Ok(cached.catalog.clone()),
                    None => Err(error),
                }
            }
        }
    }
}

/// The upstream fetch (v2 `fetchAndCache`'s happy path): the JSON object at
/// [`MODELS_DEV_URL`], or the status / shape failure.
async fn fetch_upstream() -> Result<Value, String> {
    let response = crate::llm::http::SHARED_HTTP_CLIENT
        .get(MODELS_DEV_URL)
        .header("accept", "application/json")
        .header("user-agent", USER_AGENT)
        .timeout(UPSTREAM_FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("models.dev fetch failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("models.dev returned status {}", response.status()));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("models.dev payload is not JSON: {error}"))?;
    if !payload.is_object() {
        return Err("models.dev payload is not an object".to_string());
    }
    Ok(payload)
}

/// Parse a fetched catalog payload into entries (v2's `ModelsDevCatalog`).
pub fn parse_catalog(payload: &Value) -> Result<Catalog, String> {
    serde_json::from_value(payload.clone()).map_err(|error| format!("catalog shape: {error}"))
}

// ── the built-in snapshot (v2 `builtInModelsDev.ts`) ──────────────────────

/// The built-in snapshot (v2 `BUILT_IN_MODELS_DEV_JSON`): a models.dev-shaped
/// catalog the fallback chain ends in when the upstream fetch fails with no
/// cache to serve. The fork's catalog routes served a hand-written item list
/// before the proxy landed; it now rides the same mapping path as a fetched
/// catalog, so an entry cannot exist in one and be missing in the other.
pub fn builtin_catalog() -> Value {
    json!({
        "moonshot": {
            "id": "moonshot",
            "name": "Moonshot AI (Kimi)",
            "type": "kimi",
            "api": "https://api.moonshot.cn/v1",
            "env": ["MOONSHOT_API_KEY"],
            "models": {
                "kimi-latest": {
                    "id": "kimi-latest",
                    "name": "Kimi Latest",
                    "limit": { "context": 262144 },
                    "tool_call": true,
                    "reasoning": true,
                    "modalities": { "input": ["text", "image"], "output": ["text"] }
                }
            }
        },
        "anthropic": {
            "id": "anthropic",
            "name": "Anthropic",
            "type": "anthropic",
            "api": "https://api.anthropic.com",
            "env": ["ANTHROPIC_API_KEY"],
            "models": {
                "claude-3-7-sonnet-20250219": {
                    "id": "claude-3-7-sonnet-20250219",
                    "name": "Claude 3.7 Sonnet",
                    "limit": { "context": 200000 },
                    "tool_call": true,
                    "reasoning": true,
                    "modalities": { "input": ["text", "image"], "output": ["text"] }
                }
            }
        },
        "openai": {
            "id": "openai",
            "name": "OpenAI",
            "npm": "@ai-sdk/openai",
            "api": "https://api.openai.com/v1",
            "env": ["OPENAI_API_KEY"],
            "models": {
                "gpt-4o": {
                    "id": "gpt-4o",
                    "name": "GPT-4o",
                    "limit": { "context": 128000 },
                    "tool_call": true,
                    "modalities": { "input": ["text", "image"], "output": ["text"] }
                }
            }
        },
        "google": {
            "id": "google",
            "name": "Google Gemini",
            "type": "google-genai",
            "api": "https://generativelanguage.googleapis.com/v1beta",
            "env": ["GEMINI_API_KEY"],
            "models": {
                "gemini-2.5-pro": {
                    "id": "gemini-2.5-pro",
                    "name": "Gemini 2.5 Pro",
                    "limit": { "context": 1000000 },
                    "tool_call": true,
                    "reasoning": true,
                    "modalities": { "input": ["text", "image"], "output": ["text"] }
                }
            }
        }
    })
}

/// The built-in snapshot mapped to items — the fallback the catalog routes
/// serve when the fetch fails (v2's `fetchAndCache` built-in branch).
pub fn builtin_items() -> Value {
    match parse_catalog(&builtin_catalog()) {
        Ok(catalog) => provider_items(&catalog),
        Err(_) => json!({ "items": [] }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(json: Value) -> ProviderEntry {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn the_wire_resolves_from_type_then_inference_then_default() {
        // Explicit known type wins — but a bare anthropic entry carries no
        // api and no npm, so v2's endpoint_required still asks for a base
        // url.
        let explicit = entry(json!({ "type": "anthropic" }));
        assert_eq!(
            resolve_import(&explicit, None),
            ImportResolution::NeedsBaseUrl {
                wire: "anthropic".into(),
                guessed: false,
            }
        );
        let explicit_with_api =
            entry(json!({ "type": "anthropic", "api": "https://example.test" }));
        assert_eq!(
            resolve_import(&explicit_with_api, None),
            ImportResolution::Ok {
                wire: "anthropic".into(),
                guessed: false,
                base_url: Some("https://example.test".into()),
            }
        );
        // An unknown explicit type is a reject, not a fallback.
        let unknown = entry(json!({ "type": "bedrock" }));
        assert_eq!(
            resolve_import(&unknown, None),
            ImportResolution::Invalid {
                reason: "unknown-explicit-type"
            }
        );
        // npm/id inference — the inference itself counts as declared, so
        // guessed stays false (v2: guessed = inferDeclaredWireType ===
        // undefined).
        let inferred = entry(json!({ "npm": "@ai-sdk/anthropic" }));
        assert_eq!(
            resolve_import(&inferred, None),
            ImportResolution::Ok {
                wire: "anthropic".into(),
                guessed: false,
                base_url: None,
            }
        );
        // bedrock is a proprietary-SDK reject even without an explicit type.
        let bedrock = entry(json!({ "npm": "@aws-sdk/amazon-bedrock" }));
        assert_eq!(
            resolve_import(&bedrock, None),
            ImportResolution::Invalid {
                reason: "proprietary-sdk"
            }
        );
        // The openai default — but an entry with no npm and no api still
        // needs an endpoint (v2: npm !== '@ai-sdk/openai').
        let plain = entry(json!({}));
        assert_eq!(
            resolve_import(&plain, None),
            ImportResolution::NeedsBaseUrl {
                wire: "openai".into(),
                guessed: true,
            }
        );
    }

    #[test]
    fn the_base_url_resolves_from_override_then_catalog_then_needs() {
        let with_api = entry(json!({ "api": "https://example.test/v1" }));
        assert_eq!(
            resolve_import(&with_api, None),
            ImportResolution::Ok {
                wire: "openai".into(),
                guessed: true,
                base_url: Some("https://example.test/v1".into()),
            }
        );
        // The user override wins and adapts to the wire.
        assert_eq!(
            resolve_import(
                &entry(json!({ "type": "anthropic" })),
                Some("https://example.test/v1")
            ),
            ImportResolution::Ok {
                wire: "anthropic".into(),
                guessed: false,
                base_url: Some("https://example.test".into()),
            }
        );
        // A placeholder override is a reject.
        assert_eq!(
            resolve_import(&entry(json!({})), Some(r"https://${HOST}/v1")),
            ImportResolution::Invalid {
                reason: "placeholder-base-url"
            }
        );
        // No api and a non-default npm needs an endpoint.
        let needs = entry(json!({ "npm": "@acme/gateway" }));
        assert_eq!(
            resolve_import(&needs, None),
            ImportResolution::NeedsBaseUrl {
                wire: "openai".into(),
                guessed: true,
            }
        );
        // The default npm does not — and its name still counts as an
        // inference, so guessed stays false (v2's inferDeclaredWireType
        // matches npm.includes('openai')).
        let default_npm = entry(json!({ "npm": "@ai-sdk/openai" }));
        assert_eq!(
            resolve_import(&default_npm, None),
            ImportResolution::Ok {
                wire: "openai".into(),
                guessed: false,
                base_url: None,
            }
        );
    }

    #[test]
    fn models_filter_to_usable_chat_models_and_map_capabilities() {
        let provider = entry(json!({
            "models": {
                "good": {
                    "id": "good",
                    "name": "Good",
                    "limit": { "context": 128000, "output": 4096 },
                    "modalities": { "input": ["text", "image"], "output": ["text"] },
                    "reasoning_options": [{ "type": "effort", "values": ["low", "high", null] }],
                    "interleaved": { "field": "reasoning_content" },
                },
                "embedding": { "id": "text-embed", "family": "embedding", "limit": { "context": 8192 } },
                "deprecated": { "id": "old", "status": "deprecated", "limit": { "context": 8192 } },
                "no_context": { "id": "ctxless" },
                "no_text_output": { "id": "imgonly", "limit": { "context": 8192 }, "modalities": { "output": ["image"] } },
            },
        }));
        let models = provider_models(&provider);
        assert_eq!(models.len(), 1, "only the usable chat model survives");
        let model = &models[0];
        assert_eq!(model.id, "good");
        assert_eq!(model.max_context_size, 128000);
        assert_eq!(model.max_output_size, Some(4096));
        assert!(model.image_in && !model.video_in && !model.audio_in);
        assert!(model.thinking);
        assert_eq!(
            model.support_efforts.as_deref(),
            Some(&["low".to_string(), "high".to_string()][..])
        );
        assert_eq!(model.off_effort.as_deref(), Some("none"));
        assert_eq!(model.reasoning_key.as_deref(), Some("reasoning_content"));
        assert!(model.tool_use, "tool_call defaults to true");
    }

    #[test]
    fn the_item_shape_carries_the_resolution() {
        let provider = entry(json!({
            "name": "Example",
            "env": ["EXAMPLE_API_KEY"],
            "api": "https://example.test/v1",
            "models": { "m": { "id": "m", "limit": { "context": 1000 } } },
        }));
        let item = provider_item("example", &provider);
        assert_eq!(item["id"], "example");
        assert_eq!(item["name"], "Example");
        assert_eq!(item["env_key"], "EXAMPLE_API_KEY");
        assert_eq!(item["wire_type"], "openai");
        assert_eq!(item["base_url"], "https://example.test/v1");
        assert_eq!(item["guessed"], true);
        assert_eq!(item["needs_base_url"], false);
        assert_eq!(item["rejected"], false);
        assert_eq!(item["models"][0]["id"], "m");
        assert_eq!(item["models"][0]["max_context_size"], 1000);

        // A rejected entry carries its reason and no wire type.
        let rejected = entry(json!({ "type": "bedrock" }));
        let item = provider_item("bedrock", &rejected);
        assert_eq!(item["rejected"], true);
        assert_eq!(item["reject_reason"], "unknown-explicit-type");
        assert!(item.get("wire_type").is_none() || item["wire_type"].is_null());
    }

    #[test]
    fn the_record_maps_the_capped_input_size_and_always_thinking() {
        let provider = entry(json!({
            "models": {
                "thinker": {
                    "id": "thinker",
                    "limit": { "context": 128000, "input": 64000, "output": 4096 },
                    "reasoning_options": [{ "type": "effort", "values": ["low", "high"] }],
                },
            },
        }));
        let models = provider_models(&provider);
        assert_eq!(models.len(), 1);
        let model = &models[0];
        assert_eq!(model.max_input_size, Some(64000), "the input cap rides");
        assert_eq!(model.max_output_size, Some(4096));
        assert_eq!(model.always_thinking, Some(true));

        // The record renames `thinking` to `always_thinking` (v2
        // `modelsDevModelToRecord`) and carries the capped sizes.
        let write = model_write("acme", model);
        assert_eq!(write.alias_id, "acme/thinker");
        assert_eq!(write.max_input_size, Some(64000));
        assert_eq!(write.max_output_size, Some(4096));
        assert_eq!(
            write.capabilities.as_deref(),
            Some(&["always_thinking".to_string(), "tool_use".to_string()][..])
        );
        // The REST item keeps the raw vocabulary.
        let item = provider_item("acme", &provider);
        assert_eq!(
            item["models"][0]["capabilities"],
            json!(["thinking", "tool_use"])
        );
    }

    #[test]
    fn always_thinking_drops_on_the_anthropic_and_kimi_wires() {
        // v2 `wireHasProtocolThinkingDisable`: those wires encode "thinking
        // off" on the wire, so the flag would fight the effort selector.
        let effort = json!({ "type": "effort", "values": ["low"] });
        let anthropic = entry(json!({
            "type": "anthropic",
            "api": "https://example.test",
            "models": { "m": { "id": "m", "limit": { "context": 1000 }, "reasoning_options": [effort] } },
        }));
        assert_eq!(provider_models(&anthropic)[0].always_thinking, None);
        let kimi = entry(json!({
            "type": "kimi",
            "api": "https://example.test",
            "models": { "m": { "id": "m", "limit": { "context": 1000 }, "reasoning_options": [effort.clone()] } },
        }));
        assert_eq!(provider_models(&kimi)[0].always_thinking, None);
        let openai = entry(json!({
            "api": "https://example.test",
            "models": { "m": { "id": "m", "limit": { "context": 1000 }, "reasoning_options": [effort] } },
        }));
        assert_eq!(provider_models(&openai)[0].always_thinking, Some(true));
    }

    #[test]
    fn the_builtin_snapshot_maps_through_the_same_projection() {
        let items = builtin_items();
        let items = items["items"].as_array().unwrap();
        assert_eq!(items.len(), 4);

        let moonshot = items.iter().find(|item| item["id"] == "moonshot").unwrap();
        assert_eq!(moonshot["wire_type"], "kimi");
        assert_eq!(moonshot["base_url"], "https://api.moonshot.cn/v1");
        assert_eq!(moonshot["guessed"], false);
        assert_eq!(moonshot["needs_base_url"], false);
        assert_eq!(moonshot["env_key"], "MOONSHOT_API_KEY");
        assert_eq!(moonshot["models"][0]["id"], "kimi-latest");
        assert_eq!(moonshot["models"][0]["max_context_size"], 262144);
        assert_eq!(moonshot["models"][0]["reasoning"], true);

        // The openai entry infers its wire from the default npm, so it is
        // neither guessed nor endpoint-less.
        let openai = items.iter().find(|item| item["id"] == "openai").unwrap();
        assert_eq!(openai["wire_type"], "openai");
        assert_eq!(openai["guessed"], false);
        assert_eq!(openai["needs_base_url"], false);
        assert_eq!(openai["base_url"], "https://api.openai.com/v1");

        // The anthropic entry keeps its endpoint un-versioned.
        let anthropic = items.iter().find(|item| item["id"] == "anthropic").unwrap();
        assert_eq!(anthropic["base_url"], "https://api.anthropic.com");
    }

    #[test]
    fn the_provider_id_pattern_matches_v2() {
        assert!(is_provider_id("openai"));
        assert!(is_provider_id("my-provider_1 x"));
        assert!(!is_provider_id("-leading-dash"));
        assert!(!is_provider_id("_leading"));
        assert!(!is_provider_id(""));
        assert!(!is_provider_id("has/slash"));
    }

    #[tokio::test]
    async fn a_fresh_cache_answers_without_fetching() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cache = CatalogCache::new()
            .with_fetcher(Arc::new({
                let calls = calls.clone();
                move || {
                    let calls = calls.clone();
                    Box::pin(async move {
                        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        Ok(json!({ "openai": { "name": "OpenAI" } }))
                    }) as BoxFuture<'static, Result<Value, String>>
                }
            }))
            .seed(json!({ "openai": { "name": "Cached" } }), Duration::ZERO);

        let catalog = cache.catalog().await.unwrap();
        assert_eq!(catalog["openai"]["name"], "Cached");
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "a fresh cache never reaches the fetcher"
        );
    }

    #[tokio::test]
    async fn a_stale_cache_answers_a_failed_fetch() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cache = CatalogCache::new()
            .with_fetcher(Arc::new({
                let calls = calls.clone();
                move || {
                    let calls = calls.clone();
                    Box::pin(async move {
                        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        Err("upstream down".to_string())
                    }) as BoxFuture<'static, Result<Value, String>>
                }
            }))
            .seed(
                json!({ "openai": { "name": "Stale" } }),
                CACHE_TTL + Duration::from_secs(1),
            );

        let catalog = cache.catalog().await.unwrap();
        assert_eq!(
            catalog["openai"]["name"], "Stale",
            "the failed fetch falls back to the stale cache"
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_successful_fetch_populates_the_cache() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cache = CatalogCache::new().with_fetcher(Arc::new({
            let calls = calls.clone();
            move || {
                let calls = calls.clone();
                Box::pin(async move {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(json!({ "openai": { "name": "Fresh" } }))
                }) as BoxFuture<'static, Result<Value, String>>
            }
        }));

        let first = cache.catalog().await.unwrap();
        assert_eq!(first["openai"]["name"], "Fresh");
        // The second call inside the TTL is served from the cache the first
        // populated.
        let second = cache.catalog().await.unwrap();
        assert_eq!(second["openai"]["name"], "Fresh");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_failed_first_fetch_reaches_the_caller() {
        let cache = CatalogCache::new().with_fetcher(Arc::new(|| {
            Box::pin(async { Err("upstream down".to_string()) })
                as BoxFuture<'static, Result<Value, String>>
        }));
        let error = cache.catalog().await.unwrap_err();
        assert_eq!(error, "upstream down");
    }
}
