//! Managed Kimi Code model discovery, porting v2 `refreshProviderModels`
//! branches 1 (OAuth-managed provider) and 2.5 (hand-written provider on the
//! managed endpoint with an API key).
//!
//! The refresh re-reads `GET {base}/models` and rewrites the provider's
//! upstream-owned aliases (`<prefix>/<model id>`), preserving user-authored
//! aliases under the same provider. Open-platform and custom-registry
//! branches are not ported.

use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::config::KimiConfig;
use crate::config::write::{
    ModelAliasWrite, remove_model_aliases_matching, update_config, write_model_alias,
};
use crate::server::custom_registry::RegistrySource;
use crate::server::oauth::OAuthManager;

/// The managed provider name (`KIMI_CODE_PROVIDER_NAME`).
pub const KIMI_CODE_PROVIDER_NAME: &str = "managed:kimi-code";
/// The alias prefix managed models live under (`KIMI_CODE_PLATFORM_ID`).
pub const KIMI_CODE_PLATFORM_ID: &str = "kimi-code";

const MODELS_TIMEOUT: Duration = Duration::from_secs(15);

/// One `/models` entry, mapped to the fields the alias carries.
#[derive(Debug, Clone, PartialEq)]
struct DiscoveredModel {
    id: String,
    display_name: Option<String>,
    max_context_size: u32,
    capabilities: Option<Vec<String>>,
    support_efforts: Option<Vec<String>>,
    default_effort: Option<String>,
    protocol: Option<String>,
}

fn string_array(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    })
}

/// `parseThinkEfforts`: `support` gates the whole object.
fn parse_think_efforts(value: Option<&Value>) -> (Option<Vec<String>>, Option<String>) {
    let Some(record) = value.and_then(Value::as_object) else {
        return (None, None);
    };
    if record.get("support").and_then(Value::as_bool) != Some(true) {
        return (None, None);
    }
    let support_efforts = string_array(record.get("valid_efforts"));
    let default_effort = record
        .get("default_effort")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    (support_efforts, default_effort)
}

/// `toModelInfo` + `capabilitiesForModel` + `toManagedModelAlias`.
fn parse_model(item: &Value) -> Result<Option<DiscoveredModel>, String> {
    let Some(id) = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        return Ok(None);
    };
    let context_length = item.get("context_length").and_then(Value::as_u64);
    let Some(context_length) = context_length.filter(|length| *length > 0) else {
        return Err(format!(
            "Kimi Code model \"{id}\" must include a positive context_length."
        ));
    };
    let raw_capabilities = string_array(item.get("capabilities"));
    let supports_reasoning = item.get("supports_reasoning").and_then(Value::as_bool) == Some(true)
        || raw_capabilities.as_ref().is_some_and(|caps| {
            caps.iter()
                .any(|cap| cap == "thinking" || cap == "always_thinking")
        });
    let supports_image_in = item.get("supports_image_in").and_then(Value::as_bool) == Some(true)
        || raw_capabilities
            .as_ref()
            .is_some_and(|caps| caps.iter().any(|cap| cap == "image_in"));
    let supports_video_in = item.get("supports_video_in").and_then(Value::as_bool) == Some(true)
        || raw_capabilities
            .as_ref()
            .is_some_and(|caps| caps.iter().any(|cap| cap == "video_in"));
    let supports_tool_use = item
        .get("supports_tool_use")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            raw_capabilities
                .as_ref()
                .map(|caps| caps.iter().any(|cap| cap == "tool_use"))
                .unwrap_or(true)
        });
    let supports_thinking_type = item
        .get("supports_thinking_type")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "only" | "both" | "no"));
    let protocol = item
        .get("protocol")
        .and_then(Value::as_str)
        .and_then(|value| match value {
            "anthropic" => Some("anthropic".to_string()),
            "response" => Some("openai_responses".to_string()),
            _ => None,
        });

    let mut capabilities: Vec<String> = Vec::new();
    match supports_thinking_type {
        Some("only") => {
            capabilities.push("thinking".into());
            capabilities.push("always_thinking".into());
        }
        Some("both") => capabilities.push("thinking".into()),
        Some("no") => {}
        _ => {
            if supports_reasoning {
                capabilities.push("thinking".into());
            }
        }
    }
    if supports_image_in {
        capabilities.push("image_in".into());
    }
    if supports_video_in {
        capabilities.push("video_in".into());
    }
    if supports_tool_use {
        capabilities.push("tool_use".into());
    }
    // v2 `capabilitiesForModel` adds this from `supports_dynamic_tools`; it is
    // the model-side half of the on-demand tool-loading gate (the other half
    // is the `tool_select` experimental flag).
    if item.get("supports_dynamic_tools").and_then(Value::as_bool) == Some(true) {
        capabilities.push("dynamically_loaded_tools".into());
    }

    let (support_efforts, default_effort) = parse_think_efforts(item.get("think_efforts"));
    Ok(Some(DiscoveredModel {
        id: id.to_string(),
        display_name: item
            .get("display_name")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        max_context_size: context_length as u32,
        capabilities: if capabilities.is_empty() {
            None
        } else {
            Some(capabilities)
        },
        support_efforts,
        default_effort,
        protocol,
    }))
}

fn alias_from_model(
    provider_id: &str,
    alias_prefix: &str,
    model: &DiscoveredModel,
) -> ModelAliasWrite {
    let thinking_capable = model.capabilities.as_ref().is_some_and(|caps| {
        caps.iter()
            .any(|cap| cap == "thinking" || cap == "always_thinking")
    });
    let anthropic = model.protocol.as_deref() == Some("anthropic");
    ModelAliasWrite {
        alias_id: format!("{alias_prefix}{}", model.id),
        provider: provider_id.to_string(),
        model: model.id.clone(),
        max_context_size: model.max_context_size,
        display_name: model.display_name.clone(),
        capabilities: model.capabilities.clone(),
        max_output_size: None,
        max_input_size: None,
        support_efforts: model.support_efforts.clone(),
        default_effort: model.default_effort.clone(),
        adaptive_thinking: (anthropic && thinking_capable).then_some(true),
        protocol: model.protocol.clone(),
        beta_api: anthropic.then_some(true),
        reasoning_key: None,
        off_effort: None,
        base_url: None,
    }
}

/// The comparable shape of an existing alias (for the unchanged check).
fn alias_snapshot(alias: &crate::config::ModelAliasConfig) -> Value {
    json!({
        "model": alias.model,
        "max_context_size": alias.max_context_size,
        "display_name": alias.display_name,
        "capabilities": alias.capabilities.as_deref().map(|caps| {
            let mut sorted = caps.to_vec();
            sorted.sort();
            sorted
        }),
        "support_efforts": alias.support_efforts,
        "default_effort": alias.default_effort,
        "adaptive_thinking": alias.adaptive_thinking,
        "protocol": alias.protocol,
        "beta_api": alias.beta_api,
    })
}

fn desired_snapshot(model: &DiscoveredModel) -> Value {
    let alias = alias_from_model("", "", model);
    json!({
        "model": alias.model,
        "max_context_size": alias.max_context_size,
        "display_name": alias.display_name,
        "capabilities": alias.capabilities.as_deref().map(|caps| {
            let mut sorted = caps.to_vec();
            sorted.sort();
            sorted
        }),
        "support_efforts": alias.support_efforts,
        "default_effort": alias.default_effort,
        "adaptive_thinking": alias.adaptive_thinking,
        "protocol": alias.protocol,
        "beta_api": alias.beta_api,
    })
}

fn normalized_base_url(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    let mut path = url.path().trim_end_matches('/').to_string();
    if path.is_empty() {
        path = String::new();
    }
    Some(format!(
        "{}{path}",
        url.origin().ascii_serialization().to_ascii_lowercase()
    ))
}

async fn fetch_models(
    client: &reqwest::Client,
    base_url: &str,
    credential: &str,
) -> Result<Vec<DiscoveredModel>, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {credential}"))
        .header("Accept", "application/json")
        .timeout(MODELS_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("Failed to list Kimi Code models: {error}"))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        let detail = body.trim();
        let detail = if detail.is_empty() || detail.len() > 200 {
            String::new()
        } else {
            format!(" {detail}")
        };
        return Err(format!(
            "Failed to list Kimi Code models (HTTP {status}).{detail}"
        ));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("Unexpected models response for {base_url}: {error}"))?;
    let data = payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Unexpected models response for {base_url}."))?;
    let mut models = Vec::new();
    for item in data {
        if let Some(model) = parse_model(item)? {
            models.push(model);
        }
    }
    Ok(models)
}

/// One refresh target: the provider to refresh, its alias prefix and the
/// credential/base URL to fetch with.
struct Target {
    provider_id: String,
    provider_name: String,
    alias_prefix: String,
    base_url: String,
    credential: String,
}

/// Pick the providers this server can discover: the OAuth-managed provider
/// (branch 1) and `type = "kimi"` providers on the managed endpoint with an
/// API key (branch 2.5).
async fn resolve_targets(
    config: &KimiConfig,
    oauth: &OAuthManager,
    scope: &str,
    provider_id: Option<&str>,
) -> Vec<Result<Target, (String, String)>> {
    let managed_base = normalized_base_url(oauth.managed_base_url());
    let mut targets = Vec::new();
    for (id, provider) in &config.providers {
        if provider_id.is_some_and(|wanted| wanted != id) {
            continue;
        }
        let is_managed_oauth = id == KIMI_CODE_PROVIDER_NAME
            && provider.provider_type.as_deref() == Some("kimi")
            && provider.oauth.is_some();
        if scope == "oauth" && !is_managed_oauth {
            continue;
        }
        if is_managed_oauth {
            let base_url = provider
                .base_url
                .clone()
                .unwrap_or_else(|| oauth.managed_base_url().to_string());
            match oauth.managed_access_token().await {
                Ok(credential) => targets.push(Ok(Target {
                    provider_id: id.clone(),
                    provider_name: "Kimi Code".into(),
                    alias_prefix: format!("{KIMI_CODE_PLATFORM_ID}/"),
                    base_url,
                    credential,
                })),
                Err(reason) => targets.push(Err((id.clone(), reason))),
            }
            continue;
        }
        // Branch 2.5: a hand-written managed-endpoint provider with a key.
        if provider.provider_type.as_deref() != Some("kimi") || provider.oauth.is_some() {
            continue;
        }
        let Some(base_url) = provider.base_url.as_deref() else {
            continue;
        };
        if normalized_base_url(base_url) != managed_base {
            continue;
        }
        let Some(api_key) = provider
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
        else {
            continue;
        };
        let alias_prefix = if id == KIMI_CODE_PROVIDER_NAME {
            format!("{KIMI_CODE_PLATFORM_ID}/")
        } else {
            format!("{id}/")
        };
        targets.push(Ok(Target {
            provider_id: id.clone(),
            provider_name: id.clone(),
            alias_prefix,
            base_url: base_url.to_string(),
            credential: api_key.to_string(),
        }));
    }
    targets
}

/// `POST /providers/{id}:refresh` and `POST /providers:refresh`.
/// The refresh report the branches accumulate into (v2's
/// `{changed, unchanged, failed}` result shape).
#[derive(Default)]
struct RefreshReport {
    changed: Vec<Value>,
    unchanged: Vec<String>,
    failed: Vec<Value>,
}

pub async fn refresh(
    config_lock: &Mutex<Option<KimiConfig>>,
    config_path: Option<&Path>,
    oauth: &OAuthManager,
    scope: &str,
    provider_id: Option<&str>,
) -> Value {
    let client = match reqwest::Client::builder().build() {
        Ok(client) => client,
        Err(error) => {
            return json!({
                "changed": [],
                "unchanged": [],
                "failed": [{ "provider": provider_id.unwrap_or("all"), "reason": error.to_string() }],
            });
        }
    };

    let before = {
        let guard = config_lock.lock().await;
        guard.clone().unwrap_or_else(|| {
            config_path
                .map(|path| KimiConfig::from_file(path).unwrap_or_default())
                .unwrap_or_else(|| {
                    KimiConfig::discover()
                        .map(|(config, _)| config)
                        .unwrap_or_default()
                })
        })
    };

    if let Some(provider_id) = provider_id
        && !before.providers.contains_key(provider_id)
    {
        return json!({
            "changed": [],
            "unchanged": [],
            "failed": [{ "provider": provider_id, "reason": format!("provider {provider_id} does not exist") }],
        });
    }

    let mut report = RefreshReport::default();
    let mut pending: Vec<(Target, Vec<DiscoveredModel>)> = Vec::new();

    for target in resolve_targets(&before, oauth, scope, provider_id).await {
        let target = match target {
            Ok(target) => target,
            Err((provider, reason)) => {
                report
                    .failed
                    .push(json!({ "provider": provider, "reason": reason }));
                continue;
            }
        };
        match fetch_models(&client, &target.base_url, &target.credential).await {
            Ok(models) if models.is_empty() => {
                report.unchanged.push(target.provider_id);
            }
            Ok(models) => pending.push((target, models)),
            Err(reason) => report
                .failed
                .push(json!({ "provider": target.provider_id, "reason": reason })),
        }
    }

    for (target, models) in pending {
        let desired_keys: Vec<String> = models
            .iter()
            .map(|model| format!("{}{}", target.alias_prefix, model.id))
            .collect();
        let existing: Vec<(&String, &crate::config::ModelAliasConfig)> = before
            .models
            .iter()
            .filter(|(key, alias)| {
                key.starts_with(&target.alias_prefix)
                    && alias.provider.as_deref() == Some(target.provider_id.as_str())
            })
            .collect();
        let same = existing.len() == models.len()
            && existing.iter().all(|(key, alias)| {
                let Some(model) = models
                    .iter()
                    .find(|model| &format!("{}{}", target.alias_prefix, model.id) == *key)
                else {
                    return false;
                };
                alias_snapshot(alias) == desired_snapshot(model)
            });
        let default_lost = before.default_model.as_deref().is_some_and(|default| {
            existing.iter().any(|(key, _)| key.as_str() == default)
                && !desired_keys.iter().any(|key| key == default)
        });
        if same && !default_lost {
            report.unchanged.push(target.provider_id.clone());
            continue;
        }

        let added = models
            .iter()
            .filter(|model| {
                let key = format!("{}{}", target.alias_prefix, model.id);
                !existing
                    .iter()
                    .any(|(existing_key, _)| **existing_key == key)
            })
            .count() as u64;
        let removed = existing
            .iter()
            .filter(|(key, _)| !desired_keys.iter().any(|desired| desired == *key))
            .count() as u64;

        // Preserve the global default when it still points at a surviving
        // alias; otherwise fall back to the first fetched model (v2
        // `selectDefaultModel`).
        let keep_default = before
            .default_model
            .as_deref()
            .filter(|default| desired_keys.iter().any(|key| key == default))
            .map(str::to_string);
        let fallback_default = if default_lost {
            desired_keys.first().cloned()
        } else {
            None
        };

        let provider_id = target.provider_id.clone();
        let alias_prefix = target.alias_prefix.clone();
        let desired: Vec<ModelAliasWrite> = models
            .iter()
            .map(|model| alias_from_model(&provider_id, &alias_prefix, model))
            .collect();
        let updated = update_config(config_path, move |document| {
            for alias in &desired {
                write_model_alias(document, alias)?;
            }
            remove_model_aliases_matching(document, &provider_id, &alias_prefix, &desired_keys);
            if let Some(default) = keep_default.or(fallback_default) {
                crate::config::write::set_default_model(document, Some(&default));
            }
            Ok(())
        });
        match updated {
            Ok(config) => {
                *config_lock.lock().await = Some(config);
                report.changed.push(json!({
                    "provider_id": target.provider_id,
                    "provider_name": target.provider_name,
                    "added": added,
                    "removed": removed,
                }));
            }
            Err(reason) => report
                .failed
                .push(json!({ "provider": target.provider_id, "reason": reason })),
        }
    }

    // Branch 3 (v2 `refreshProviderModels`): custom-registry providers,
    // grouped by source URL. The oauth scope stops before it, exactly where
    // v2's gate sits.
    if scope != "oauth" {
        refresh_custom_registries(
            config_lock,
            config_path,
            &client,
            &before,
            provider_id,
            &mut report,
        )
        .await;
    }

    json!({
        "changed": report.changed,
        "unchanged": report.unchanged,
        "failed": report.failed,
    })
}

/// The distinct model ids an alias set carries (v2 `collectModelIdsForAliases`):
/// the change counts are reported in models, not alias keys.
fn model_ids_of(config: &KimiConfig, provider_id: &str) -> Vec<String> {
    let mut ids: Vec<String> = config
        .models
        .iter()
        .filter(|(_, alias)| alias.provider.as_deref() == Some(provider_id))
        .filter_map(|(_, alias)| alias.model.clone())
        .filter(|model| !model.is_empty())
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// v2 `fetchCustomRegistryFromSources`: try each credential configured for
/// the registry URL until one serves the document (key rotation), and report
/// which source answered.
async fn fetch_from_sources(
    client: &reqwest::Client,
    sources: &[RegistrySource],
) -> Result<
    (
        std::collections::BTreeMap<String, crate::server::custom_registry::RegistryProviderEntry>,
        RegistrySource,
    ),
    String,
> {
    let mut last_error = None;
    for source in sources {
        match crate::server::custom_registry::fetch_registry(client, source).await {
            Ok(entries) => return Ok((entries, source.clone())),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "no registry sources configured".to_string()))
}

/// Branch 3 of v2 `refreshProviderModels`: the providers carrying a
/// `source` blob, grouped by registry URL. The URL is the registry's stable
/// identity, so a group may carry several API keys (rotation) and the fetch
/// tries each until one succeeds. A scoped refresh touches only the target's
/// group and only that provider; an unscoped one also pulls in providers the
/// registry newly lists and drops the ones it no longer does.
async fn refresh_custom_registries(
    config_lock: &Mutex<Option<KimiConfig>>,
    config_path: Option<&Path>,
    client: &reqwest::Client,
    before: &KimiConfig,
    provider_id: Option<&str>,
    report: &mut RefreshReport,
) {
    let mut groups: std::collections::BTreeMap<String, (Vec<RegistrySource>, Vec<String>)> =
        std::collections::BTreeMap::new();
    for (id, provider) in &before.providers {
        if id == KIMI_CODE_PROVIDER_NAME {
            continue;
        }
        let Some(source) = RegistrySource::from_provider(provider) else {
            continue;
        };
        let entry = groups.entry(source.url.clone()).or_default();
        if !entry.0.contains(&source) {
            entry.0.push(source);
        }
        entry.1.push(id.clone());
    }

    for (_, (sources, provider_ids)) in groups {
        if let Some(target) = provider_id
            && !provider_ids.iter().any(|id| id == target)
        {
            continue;
        }
        // v2 `fetchCustomRegistryFromSources`: the first key that works wins.
        let (entries, source) = match fetch_from_sources(client, &sources).await {
            Ok(fetched) => fetched,
            Err(reason) => {
                let reported = provider_id
                    .map(|target| vec![target.to_string()])
                    .unwrap_or_else(|| provider_ids.clone());
                for id in reported {
                    report
                        .failed
                        .push(json!({ "provider": id, "reason": reason.clone() }));
                }
                continue;
            }
        };

        // The sync set: the group's providers, plus the registry's new
        // entries when the refresh is unscoped.
        let mut sync: Vec<String> = provider_ids.clone();
        if provider_id.is_none() {
            for entry in entries.values() {
                if !sync.contains(&entry.id) {
                    sync.push(entry.id.clone());
                }
            }
        }

        // Classify before writing: a group whose every provider already says
        // what the registry says is reported unchanged without touching the
        // config file.
        let mut any_change = false;
        for id in &sync {
            match entries.values().find(|entry| &entry.id == id) {
                Some(entry) => {
                    let Some(provider) = before.providers.get(id) else {
                        any_change = true;
                        continue;
                    };
                    if !crate::server::custom_registry::provider_config_matches(
                        provider, entry, &source,
                    ) {
                        any_change = true;
                        continue;
                    }
                    let desired: Vec<(String, ModelAliasWrite)> = entry
                        .models
                        .iter()
                        .map(|(model_key, model)| {
                            (
                                format!("{id}/{model_key}"),
                                crate::server::custom_registry::alias_write(id, model_key, model),
                            )
                        })
                        .collect();
                    let existing: Vec<(&String, &crate::config::ModelAliasConfig)> = before
                        .models
                        .iter()
                        .filter(|(_, alias)| alias.provider.as_deref() == Some(id.as_str()))
                        .collect();
                    let same_keys = existing.len() == desired.len()
                        && existing.iter().all(|(key, _)| {
                            desired.iter().any(|(desired_key, _)| desired_key == *key)
                        });
                    let same_fields = desired.iter().all(|(key, write)| {
                        before.models.get(key).is_some_and(|alias| {
                            crate::server::custom_registry::remote_fields_match(alias, write)
                        })
                    });
                    if !same_keys || !same_fields {
                        any_change = true;
                    }
                }
                None => {
                    if before.providers.contains_key(id) {
                        any_change = true;
                    }
                }
            }
        }
        if !any_change {
            report.unchanged.extend(sync);
            continue;
        }

        let updated = update_config(config_path, |document| {
            for id in &sync {
                match entries.values().find(|entry| &entry.id == id) {
                    Some(entry) => {
                        crate::server::custom_registry::apply_entry(document, entry, &source)?;
                    }
                    None => {
                        crate::server::custom_registry::remove_entry(document, id);
                    }
                }
            }
            Ok(())
        });
        match updated {
            Ok(config) => {
                *config_lock.lock().await = Some(config.clone());
                for id in &sync {
                    let before_ids = model_ids_of(before, id);
                    let after_ids = model_ids_of(&config, id);
                    let added = after_ids
                        .iter()
                        .filter(|model| !before_ids.contains(model))
                        .count() as u64;
                    let removed = before_ids
                        .iter()
                        .filter(|model| !after_ids.contains(model))
                        .count() as u64;
                    let name = entries
                        .values()
                        .find(|entry| &entry.id == id)
                        .map(|entry| entry.name.clone())
                        .unwrap_or_else(|| id.clone());
                    if added == 0 && removed == 0 && before.providers.contains_key(id) {
                        report.unchanged.push(id.clone());
                    } else {
                        report.changed.push(json!({
                            "provider_id": id,
                            "provider_name": name,
                            "added": added,
                            "removed": removed,
                        }));
                    }
                }
            }
            Err(reason) => {
                for id in &sync {
                    report
                        .failed
                        .push(json!({ "provider": id, "reason": reason.clone() }));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn parses_a_model_payload_like_v2() {
        let item = json!({
            "id": "k3",
            "context_length": 200000,
            "display_name": "K3",
            "capabilities": ["tool_use"],
            "supports_thinking_type": "both",
            "supports_image_in": true,
            "protocol": "anthropic",
            "think_efforts": { "support": true, "valid_efforts": ["low", "high"], "default_effort": "high" }
        });
        let model = parse_model(&item).unwrap().unwrap();
        assert_eq!(model.id, "k3");
        assert_eq!(model.max_context_size, 200_000);
        assert_eq!(model.display_name.as_deref(), Some("K3"));
        assert_eq!(
            model.capabilities.as_deref(),
            Some(
                &[
                    "thinking".to_string(),
                    "image_in".to_string(),
                    "tool_use".to_string()
                ][..]
            )
        );
        assert_eq!(
            model.support_efforts.as_deref(),
            Some(&["low".to_string(), "high".to_string()][..])
        );
        assert_eq!(model.default_effort.as_deref(), Some("high"));
        assert_eq!(model.protocol.as_deref(), Some("anthropic"));

        // The alias carries the anthropic routing overrides.
        let alias = alias_from_model("managed:kimi-code", "kimi-code/", &model);
        assert_eq!(alias.alias_id, "kimi-code/k3");
        assert_eq!(alias.provider, "managed:kimi-code");
        assert_eq!(alias.adaptive_thinking, Some(true));
        assert_eq!(alias.beta_api, Some(true));
    }

    #[test]
    fn rejects_missing_context_length_and_skips_entries_without_ids() {
        assert!(parse_model(&json!({ "id": "no-context" })).is_err());
        assert!(parse_model(&json!({ "id": "zero", "context_length": 0 })).is_err());
        assert!(
            parse_model(&json!({ "context_length": 100 }))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn think_efforts_require_support_true() {
        assert_eq!(
            parse_think_efforts(Some(&json!({ "valid_efforts": ["low"] }))),
            (None, None)
        );
        assert_eq!(
            parse_think_efforts(Some(&json!({ "support": false, "valid_efforts": ["low"] }))),
            (None, None)
        );
    }

    #[test]
    fn base_url_normalization_matches_the_managed_endpoint() {
        let expected = normalized_base_url("https://api.kimi.com/coding/v1").unwrap();
        assert_eq!(
            normalized_base_url("HTTPS://API.KIMI.COM/coding/v1/").unwrap(),
            expected
        );
        assert_ne!(
            normalized_base_url("https://api.kimi.com/coding/v2").unwrap(),
            expected
        );
        assert_ne!(
            normalized_base_url("https://proxy.example.test/v1").unwrap(),
            expected
        );
    }

    /// A registry server whose response is chosen per request by the Bearer
    /// key, so key rotation can be exercised: the stale key 401s and the
    /// fresh one serves the document. Each entry is `(key marker, status
    /// line, body)`; the last entry is the fallback for an unknown key.
    struct RegistryServer {
        url: String,
        requests: Arc<std::sync::Mutex<Vec<String>>>,
        override_response: Arc<std::sync::Mutex<Option<(String, String)>>>,
    }

    fn bearer_key(head: &str) -> String {
        head.lines()
            .find(|line| line.to_lowercase().starts_with("authorization:"))
            .map(|line| line["authorization:".len()..].trim())
            .map(|value| {
                value
                    .strip_prefix("Bearer ")
                    .or_else(|| value.strip_prefix("bearer "))
                    .unwrap_or(value)
                    .to_string()
            })
            .unwrap_or_default()
    }

    impl RegistryServer {
        async fn spawn(responses: Vec<(&'static str, &'static str, String)>) -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
            let shared = requests.clone();
            let override_response: Arc<std::sync::Mutex<Option<(String, String)>>> =
                Arc::new(std::sync::Mutex::new(None));
            let shared_override = override_response.clone();
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                while let Ok((mut sock, _)) = listener.accept().await {
                    let mut buf = [0u8; 8192];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        continue;
                    }
                    let head = String::from_utf8_lossy(&buf[..n]).to_string();
                    shared.lock().unwrap().push(head.clone());
                    let key = bearer_key(&head);
                    let (_, status, body) = shared_override
                        .lock()
                        .unwrap()
                        .clone()
                        .map(|(status, body)| ("", status, body))
                        .or_else(|| {
                            responses
                                .iter()
                                .find(|(marker, _, _)| key.contains(marker))
                                .map(|(marker, status, body)| {
                                    (*marker, (*status).to_string(), body.clone())
                                })
                        })
                        .unwrap_or_else(|| {
                            let (marker, status, body) = responses.last().unwrap();
                            (*marker, (*status).to_string(), body.clone())
                        });
                    let raw = format!(
                        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(raw.as_bytes()).await;
                    let _ = sock.flush().await;
                }
            });
            Self {
                url: format!("http://{addr}/api.json"),
                requests,
                override_response,
            }
        }

        /// Fail every later request regardless of key.
        fn set_response_failure(&self) {
            *self.override_response.lock().unwrap() =
                Some(("500 Internal Server Error".to_string(), String::new()));
        }

        fn keys(&self) -> Vec<String> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .map(|request| bearer_key(request))
                .collect()
        }
    }

    fn registry_config(url: &str, api_key: &str) -> String {
        format!(
            r#"
default_model = "acme/big"

[providers.acme]
type = "openai"
base_url = "https://registry.example.test/v1"
api_key = "{api_key}"

[providers.acme.source]
kind = "apiJson"
url = "{url}"
apiKey = "{api_key}"

[models."acme/big"]
provider = "acme"
model = "big-1"
max_context_size = 128000
capabilities = ["tool_use"]
"#
        )
    }

    #[tokio::test]
    async fn refreshes_custom_registry_providers_from_their_source() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        let upstream = RegistryServer::spawn(vec![(
            "sk-reg",
            "200 OK",
            json!({
                "acme": {
                    "id": "acme",
                    "name": "Acme",
                    "api": "https://registry.example.test/v1",
                    "type": "openai",
                    "models": {
                        "big": { "id": "big-1", "limit": { "context": 128000 } },
                        "small": { "id": "small-1", "limit": { "context": 8192 } },
                    },
                },
            })
            .to_string(),
        )])
        .await;
        std::fs::write(&config_path, registry_config(&upstream.url, "sk-reg")).unwrap();

        let lock: Mutex<Option<KimiConfig>> = Mutex::new(None);
        let result = refresh(&lock, Some(&config_path), &OAuthManager::new(), "all", None).await;
        let changed = result["changed"].as_array().unwrap();
        assert_eq!(changed.len(), 1, "{result}");
        assert_eq!(changed[0]["provider_id"], "acme");
        assert_eq!(changed[0]["provider_name"], "Acme");
        assert_eq!(changed[0]["added"], 1);
        assert_eq!(changed[0]["removed"], 0);
        assert!(
            result["unchanged"].as_array().unwrap().is_empty(),
            "{result}"
        );

        let text = std::fs::read_to_string(&config_path).unwrap();
        assert!(text.contains("[models.\"acme/small\"]"), "{text}");
        assert!(text.contains("model = \"small-1\""), "{text}");
        // The default still points at the surviving alias.
        assert!(text.contains("default_model = \"acme/big\""), "{text}");

        // A second refresh with the same document reports unchanged and does
        // not rewrite the file.
        let before = std::fs::read_to_string(&config_path).unwrap();
        let result = refresh(&lock, Some(&config_path), &OAuthManager::new(), "all", None).await;
        assert!(result["changed"].as_array().unwrap().is_empty(), "{result}");
        assert_eq!(result["unchanged"], json!(["acme"]));
        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), before);
    }

    #[tokio::test]
    async fn refreshes_a_registry_group_through_key_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        // Two providers share the registry URL with different keys: the
        // stale one 401s, the fresh one serves the document.
        let upstream = RegistryServer::spawn(vec![
            (
                "sk-fresh",
                "200 OK",
                json!({
                    "acme": {
                        "id": "acme",
                        "name": "Acme",
                        "api": "https://registry.example.test/v1",
                        "type": "openai",
                        "models": { "big": { "id": "big-1", "limit": { "context": 128000 } } },
                    },
                    "beta": {
                        "id": "beta",
                        "name": "Beta",
                        "api": "https://beta.example.test/v1",
                        "type": "openai",
                        "models": {
                            "one": { "id": "one-1", "limit": { "context": 4096 } },
                            "two": { "id": "two-2", "limit": { "context": 8192 } },
                        },
                    },
                })
                .to_string(),
            ),
            ("sk-stale", "401 Unauthorized", String::new()),
        ])
        .await;
        // Two providers share the registry URL with different keys.
        std::fs::write(
            &config_path,
            format!(
                r#"
default_model = "acme/big"

[providers.acme]
type = "openai"
base_url = "https://registry.example.test/v1"
api_key = "sk-stale"

[providers.acme.source]
kind = "apiJson"
url = "{url}"
apiKey = "sk-stale"

[providers.beta]
type = "openai"
base_url = "https://beta.example.test/v1"
api_key = "sk-fresh"

[providers.beta.source]
kind = "apiJson"
url = "{url}"
apiKey = "sk-fresh"

[models."acme/big"]
provider = "acme"
model = "big-1"
max_context_size = 128000
capabilities = ["tool_use"]

[models."beta/one"]
provider = "beta"
model = "one-1"
max_context_size = 4096
capabilities = ["tool_use"]
"#,
                url = upstream.url
            ),
        )
        .unwrap();

        let lock: Mutex<Option<KimiConfig>> = Mutex::new(None);
        let result = refresh(&lock, Some(&config_path), &OAuthManager::new(), "all", None).await;
        // Both providers of the group are synced from the one successful
        // fetch; the stale key was tried first.
        let changed = result["changed"].as_array().unwrap();
        assert_eq!(changed.len(), 1, "{result}");
        assert_eq!(changed[0]["provider_id"], "beta");
        assert_eq!(changed[0]["added"], 1);
        assert_eq!(result["unchanged"], json!(["acme"]));
        // The group's credential order follows the config's provider order,
        // so either key may be tried first; what matters is that the one that
        // answered was the fresh key and the sync used its document. The
        // retry itself is pinned by `fetch_from_sources` below.
        let keys = upstream.keys();
        assert!(keys.iter().all(|key| key.contains("sk-")), "{keys:?}");
        assert_eq!(
            keys.last().map(String::as_str),
            Some("sk-fresh"),
            "{keys:?}"
        );
    }

    #[tokio::test]
    async fn fetch_from_sources_retries_the_next_key_after_a_failure() {
        let upstream = RegistryServer::spawn(vec![
            ("sk-stale", "401 Unauthorized", String::new()),
            (
                "sk-fresh",
                "200 OK",
                json!({
                    "acme": {
                        "id": "acme",
                        "name": "Acme",
                        "api": "https://registry.example.test/v1",
                        "type": "openai",
                        "models": { "big": { "id": "big-1", "limit": { "context": 128000 } } },
                    },
                })
                .to_string(),
            ),
        ])
        .await;
        let client = reqwest::Client::builder().build().unwrap();
        let sources = vec![
            RegistrySource {
                url: upstream.url.clone(),
                api_key: "sk-stale".into(),
            },
            RegistrySource {
                url: upstream.url.clone(),
                api_key: "sk-fresh".into(),
            },
        ];

        let (entries, source) = fetch_from_sources(&client, &sources)
            .await
            .expect("the fresh key serves the document");
        assert_eq!(source.api_key, "sk-fresh");
        assert_eq!(entries.len(), 1);
        // The stale key was tried first and failed, then the fresh one won.
        assert_eq!(
            upstream.keys(),
            vec!["sk-stale".to_string(), "sk-fresh".to_string()]
        );

        // Every key failing reports the last error.
        upstream.set_response_failure();
        let error = fetch_from_sources(&client, &sources)
            .await
            .expect_err("no key serves the document");
        assert!(error.contains("500"), "{error}");
    }

    #[tokio::test]
    async fn a_scoped_refresh_touches_only_the_target_provider() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        let upstream = RegistryServer::spawn(vec![(
            "sk-reg",
            "200 OK",
            json!({
                "acme": {
                    "id": "acme",
                    "name": "Acme",
                    "api": "https://registry.example.test/v1",
                    "type": "openai",
                    "models": {
                        "big": { "id": "big-1", "limit": { "context": 128000 } },
                        "small": { "id": "small-1", "limit": { "context": 8192 } },
                    },
                },
            })
            .to_string(),
        )])
        .await;
        std::fs::write(&config_path, registry_config(&upstream.url, "sk-reg")).unwrap();

        let lock: Mutex<Option<KimiConfig>> = Mutex::new(None);
        let result = refresh(
            &lock,
            Some(&config_path),
            &OAuthManager::new(),
            "all",
            Some("acme"),
        )
        .await;
        assert_eq!(result["changed"][0]["provider_id"], "acme", "{result}");
        let text = std::fs::read_to_string(&config_path).unwrap();
        assert!(text.contains("[models.\"acme/small\"]"), "{text}");
    }

    #[tokio::test]
    async fn a_vanished_registry_provider_is_removed_on_refresh() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        let upstream =
            RegistryServer::spawn(vec![("sk-reg", "200 OK", json!({}).to_string())]).await;
        std::fs::write(&config_path, registry_config(&upstream.url, "sk-reg")).unwrap();

        let lock: Mutex<Option<KimiConfig>> = Mutex::new(None);
        let result = refresh(&lock, Some(&config_path), &OAuthManager::new(), "all", None).await;
        let changed = result["changed"].as_array().unwrap();
        assert_eq!(changed.len(), 1, "{result}");
        assert_eq!(changed[0]["provider_id"], "acme");
        assert_eq!(changed[0]["removed"], 1);

        let text = std::fs::read_to_string(&config_path).unwrap();
        assert!(!text.contains("[providers.acme]"), "{text}");
        assert!(!text.contains("acme/big"), "{text}");
        // The default pointed into the removed provider, so it goes too.
        assert!(!text.contains("default_model"), "{text}");
    }

    #[tokio::test]
    async fn an_oauth_scoped_refresh_leaves_registries_alone() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        let upstream = RegistryServer::spawn(vec![(
            "sk-reg",
            "200 OK",
            json!({
                "acme": {
                    "id": "acme",
                    "name": "Acme",
                    "api": "https://registry.example.test/v1",
                    "type": "openai",
                    "models": {
                        "big": { "id": "big-1", "limit": { "context": 128000 } },
                        "small": { "id": "small-1", "limit": { "context": 8192 } },
                    },
                },
            })
            .to_string(),
        )])
        .await;
        std::fs::write(&config_path, registry_config(&upstream.url, "sk-reg")).unwrap();

        let lock: Mutex<Option<KimiConfig>> = Mutex::new(None);
        let result = refresh(
            &lock,
            Some(&config_path),
            &OAuthManager::new(),
            "oauth",
            None,
        )
        .await;
        // v2's gate: the oauth scope stops before the registry branch.
        assert_eq!(
            result,
            json!({ "changed": [], "unchanged": [], "failed": [] })
        );
        assert!(upstream.keys().is_empty(), "no registry request was made");
        let text = std::fs::read_to_string(&config_path).unwrap();
        assert!(!text.contains("acme/small"), "{text}");
    }

    #[tokio::test]
    async fn a_failed_registry_fetch_reports_the_group_as_failed() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        let upstream =
            RegistryServer::spawn(vec![("sk-reg", "401 Unauthorized", String::new())]).await;
        std::fs::write(&config_path, registry_config(&upstream.url, "sk-reg")).unwrap();

        let lock: Mutex<Option<KimiConfig>> = Mutex::new(None);
        let result = refresh(&lock, Some(&config_path), &OAuthManager::new(), "all", None).await;
        let failed = result["failed"].as_array().unwrap();
        assert_eq!(failed.len(), 1, "{result}");
        assert_eq!(failed[0]["provider"], "acme");
        assert!(
            failed[0]["reason"].as_str().unwrap().contains("401"),
            "{result}"
        );
        // The config is untouched.
        let text = std::fs::read_to_string(&config_path).unwrap();
        assert!(text.contains("[providers.acme]"), "{text}");
    }
}
