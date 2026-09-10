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
use crate::config::write::{ModelAliasWrite, remove_model_aliases_matching, update_config, write_model_alias};
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
    let Some(id) = item.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) else {
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
        || raw_capabilities
            .as_ref()
            .is_some_and(|caps| caps.iter().any(|cap| cap == "thinking" || cap == "always_thinking"));
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

fn alias_from_model(provider_id: &str, alias_prefix: &str, model: &DiscoveredModel) -> ModelAliasWrite {
    let thinking_capable = model.capabilities.as_ref().is_some_and(|caps| {
        caps.iter().any(|cap| cap == "thinking" || cap == "always_thinking")
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
        support_efforts: model.support_efforts.clone(),
        default_effort: model.default_effort.clone(),
        adaptive_thinking: (anthropic && thinking_capable).then_some(true),
        protocol: model.protocol.clone(),
        beta_api: anthropic.then_some(true),
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
        let is_managed_oauth =
            id == KIMI_CODE_PROVIDER_NAME && provider.provider_type.as_deref() == Some("kimi") && provider.oauth.is_some();
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
        let Some(api_key) = provider.api_key.as_deref().map(str::trim).filter(|key| !key.is_empty())
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

    let mut changed: Vec<Value> = Vec::new();
    let mut unchanged: Vec<String> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    let mut pending: Vec<(Target, Vec<DiscoveredModel>)> = Vec::new();

    for target in resolve_targets(&before, oauth, scope, provider_id).await {
        let target = match target {
            Ok(target) => target,
            Err((provider, reason)) => {
                failed.push(json!({ "provider": provider, "reason": reason }));
                continue;
            }
        };
        match fetch_models(&client, &target.base_url, &target.credential).await {
            Ok(models) if models.is_empty() => {
                unchanged.push(target.provider_id);
            }
            Ok(models) => pending.push((target, models)),
            Err(reason) => failed.push(json!({ "provider": target.provider_id, "reason": reason })),
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
                let Some(model) = models.iter().find(|model| &format!("{}{}", target.alias_prefix, model.id) == *key)
                else {
                    return false;
                };
                alias_snapshot(alias) == desired_snapshot(model)
            });
        let default_lost = before
            .default_model
            .as_deref()
            .is_some_and(|default| {
                existing.iter().any(|(key, _)| key.as_str() == default)
                    && !desired_keys.iter().any(|key| key == default)
            });
        if same && !default_lost {
            unchanged.push(target.provider_id.clone());
            continue;
        }

        let added = models
            .iter()
            .filter(|model| {
                let key = format!("{}{}", target.alias_prefix, model.id);
                !existing.iter().any(|(existing_key, _)| **existing_key == key)
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
                changed.push(json!({
                    "provider_id": target.provider_id,
                    "provider_name": target.provider_name,
                    "added": added,
                    "removed": removed,
                }));
            }
            Err(reason) => failed.push(json!({ "provider": target.provider_id, "reason": reason })),
        }
    }

    json!({ "changed": changed, "unchanged": unchanged, "failed": failed })
}

#[cfg(test)]
mod tests {
    use super::*;

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
            Some(&["thinking".to_string(), "image_in".to_string(), "tool_use".to_string()][..])
        );
        assert_eq!(model.support_efforts.as_deref(), Some(&["low".to_string(), "high".to_string()][..]));
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
        assert!(parse_model(&json!({ "context_length": 100 })).unwrap().is_none());
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
}
