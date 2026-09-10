//! Config-driven model / provider catalog and the auth readiness summary
//! (v2 `kosong/model/catalogService.ts` + `app/authLegacy/authLegacyService.ts`).
//!
//! The standalone server has no JS host, so the REST surface projects the
//! same `config.toml` the engine loads into the shapes `packages/protocol`
//! declares. Declared values only: provider-profile defaults (capabilities,
//! efforts) are not derived here, and `status: "error"` waits for the
//! provider-refresh cache.

use serde::Serialize;
use serde_json::{Value, json};

use crate::config::KimiConfig;

/// The managed Kimi Code OAuth provider (`KIMI_CODE_PROVIDER_NAME`).
pub const MANAGED_PROVIDER_NAME: &str = "managed:kimi-code";

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// The protocol a provider type speaks, mirroring v2 `resolveModelProtocol`'s
/// known set. A missing type defaults to `openai`, like the catalog's own
/// `type ?? 'openai'`.
fn protocol_for(provider_type: Option<&str>) -> Option<&'static str> {
    match provider_type.unwrap_or("openai").to_ascii_lowercase().as_str() {
        "kimi" | "openai" | "openai_responses" => Some("openai"),
        "anthropic" => Some("anthropic"),
        "google-genai" | "vertexai" => Some("google-genai"),
        _ => None,
    }
}

#[derive(Serialize)]
struct ModelItem<'a> {
    provider: &'a str,
    model: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<&'a str>,
    max_context_size: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    capabilities: Option<&'a Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    support_efforts: Option<&'a Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_effort: Option<&'a str>,
}

/// Every `[models.*]` alias mapped to `ModelCatalogItem` (v2
/// `IModelCatalog.listModels`).
pub fn models(config: &KimiConfig) -> Value {
    let items: Vec<ModelItem<'_>> = config
        .models
        .iter()
        .map(|(id, alias)| ModelItem {
            provider: alias
                .provider
                .as_deref()
                .or(config.default_provider.as_deref())
                .unwrap_or(""),
            model: id,
            display_name: alias
                .display_name
                .as_deref()
                .or(alias.model.as_deref())
                .or(Some(id)),
            max_context_size: alias.max_context_size.unwrap_or(0),
            capabilities: alias.capabilities.as_ref(),
            support_efforts: alias.support_efforts.as_ref(),
            default_effort: alias.default_effort.as_deref(),
        })
        .collect();
    json!({ "items": items })
}

#[derive(Serialize)]
struct ProviderItem<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    provider_type: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_url: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_model: Option<String>,
    has_api_key: bool,
    status: &'static str,
    models: Vec<&'a str>,
}

/// Every `[providers.*]` entry mapped to `ProviderCatalogItem` (v2
/// `IModelCatalog.listProviders`), with the credential state deciding
/// `connected` vs `unconfigured`.
pub fn providers(config: &KimiConfig, has_cached_token: &dyn Fn(&str) -> bool) -> Value {
    let items: Vec<ProviderItem<'_>> = config
        .providers
        .iter()
        .map(|(provider_id, provider)| {
            let has_api_key = non_empty(provider.api_key.as_deref()).is_some();
            let has_oauth_token =
                provider.oauth.is_some() && has_cached_token(provider_id.as_str());
            let default_model = provider.default_model.clone().or_else(|| {
                let global = non_empty(config.default_model.as_deref())?;
                let record = config.models.get(global)?;
                let owner = record
                    .provider
                    .as_deref()
                    .or(config.default_provider.as_deref());
                (owner == Some(provider_id.as_str())).then(|| global.to_string())
            });
            ProviderItem {
                id: provider_id,
                provider_type: provider.provider_type.as_deref().unwrap_or("openai"),
                base_url: provider.base_url.as_deref(),
                default_model,
                has_api_key,
                status: if has_api_key || has_oauth_token {
                    "connected"
                } else {
                    "unconfigured"
                },
                models: config
                    .models
                    .iter()
                    .filter(|(_, alias)| alias.provider.as_deref() == Some(provider_id.as_str()))
                    .map(|(model_id, _)| model_id.as_str())
                    .collect(),
            }
        })
        .collect();
    json!({ "items": items })
}

#[derive(Serialize)]
struct ManagedProvider {
    name: &'static str,
    status: &'static str,
}

#[derive(Serialize)]
struct AuthSummary {
    models_ready: bool,
    providers_count: usize,
    managed_provider: Option<ManagedProvider>,
}

/// `GET /api/v1/auth` (v2 `IAuthLegacyService.get`): structural model
/// readiness, the configured provider count, and the managed provider's
/// sign-in state.
pub fn auth_summary(config: &KimiConfig, has_cached_token: &dyn Fn(&str) -> bool) -> Value {
    let managed_provider = config
        .providers
        .contains_key(MANAGED_PROVIDER_NAME)
        .then(|| ManagedProvider {
            name: MANAGED_PROVIDER_NAME,
            status: if has_cached_token(MANAGED_PROVIDER_NAME) {
                "authenticated"
            } else {
                "unauthenticated"
            },
        });
    let summary = AuthSummary {
        models_ready: models_ready(config),
        providers_count: config.providers.len(),
        managed_provider,
    };
    serde_json::to_value(summary).unwrap_or_else(|_| json!({}))
}

/// v2 `resolveModelForReady`: the default alias exists, its provider (or the
/// flat model-id prefix) resolves to a configured provider, the wire model
/// name and a positive context size are declared, and the provider type maps
/// to a known protocol.
fn models_ready(config: &KimiConfig) -> bool {
    let Some(default_model) = non_empty(config.default_model.as_deref()) else {
        return false;
    };
    let Some(record) = config.models.get(default_model) else {
        return false;
    };
    let provider_id =
        non_empty(record.provider.as_deref()).or(non_empty(config.default_provider.as_deref()));
    if let Some(provider_id) = provider_id
        && !config.providers.contains_key(provider_id)
    {
        return false;
    }
    let wire_name = non_empty(record.model.as_deref());
    let provider_name = provider_id.or_else(|| {
        let wire = wire_name?;
        let (prefix, _) = wire.split_once('/')?;
        non_empty(Some(prefix))
    });
    let Some(provider_name) = provider_name else {
        return false;
    };
    if wire_name.is_none() || record.max_context_size.unwrap_or(0) == 0 {
        return false;
    }
    protocol_for(
        config
            .providers
            .get(provider_name)
            .and_then(|provider| provider.provider_type.as_deref()),
    )
    .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    const CATALOG_CONFIG: &str = r#"
default_model = "kimi-code/k3"
default_provider = "kimi-code"

[providers."kimi-code"]
type = "openai"
base_url = "https://example.test/v1"
default_model = "kimi-code/k3"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://example.test/managed"
oauth = { provider = "managed:kimi-code" }

[models."kimi-code/k3"]
provider = "kimi-code"
model = "k3"
max_context_size = 200000
display_name = "K3"
capabilities = ["tools", "thinking"]
support_efforts = ["low", "high"]
default_effort = "high"

[models."kimi-code/fast"]
provider = "kimi-code"
model = "k3-fast"
max_context_size = 200000
"#;

    fn config() -> KimiConfig {
        KimiConfig::from_str(CATALOG_CONFIG).unwrap()
    }

    #[test]
    fn models_project_the_config_aliases() {
        let response = models(&config());
        let items = response["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        let k3 = items
            .iter()
            .find(|item| item["model"] == "kimi-code/k3")
            .unwrap();
        assert_eq!(k3["provider"], "kimi-code");
        assert_eq!(k3["display_name"], "K3");
        assert_eq!(k3["max_context_size"], 200000);
        assert_eq!(k3["capabilities"], json!(["tools", "thinking"]));
        assert_eq!(k3["default_effort"], "high");

        // The second alias has no display_name and declares no capabilities;
        // both fall back to the wire model name / stay omitted.
        let fast = items
            .iter()
            .find(|item| item["model"] == "kimi-code/fast")
            .unwrap();
        assert_eq!(fast["display_name"], "k3-fast");
        assert!(fast.get("capabilities").is_none());
    }

    #[test]
    fn providers_carry_credential_state_and_models() {
        let response = providers(&config(), &|provider| provider == MANAGED_PROVIDER_NAME);
        let items = response["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);

        let kimi_code = items.iter().find(|item| item["id"] == "kimi-code").unwrap();
        assert_eq!(kimi_code["type"], "openai");
        assert_eq!(kimi_code["has_api_key"], false);
        assert_eq!(kimi_code["status"], "unconfigured");
        assert_eq!(kimi_code["default_model"], "kimi-code/k3");
        assert_eq!(kimi_code["models"], json!(["kimi-code/k3", "kimi-code/fast"]));

        // The managed provider is OAuth-authenticated through its cached token.
        let managed = items
            .iter()
            .find(|item| item["id"] == MANAGED_PROVIDER_NAME)
            .unwrap();
        assert_eq!(managed["status"], "connected");
        assert_eq!(managed["models"], json!([]));
    }

    #[test]
    fn auth_summary_reports_readiness_and_sign_in() {
        let signed_in = auth_summary(&config(), &|_| true);
        assert_eq!(signed_in["models_ready"], true);
        assert_eq!(signed_in["providers_count"], 2);
        assert_eq!(signed_in["managed_provider"]["name"], MANAGED_PROVIDER_NAME);
        assert_eq!(signed_in["managed_provider"]["status"], "authenticated");

        let signed_out = auth_summary(&config(), &|_| false);
        assert_eq!(
            signed_out["managed_provider"]["status"],
            "unauthenticated"
        );
    }

    #[test]
    fn auth_summary_flags_a_dangling_default_model() {
        let dangling = KimiConfig::from_str(
            r#"
default_model = "missing"

[providers.kimi]
api_key = "sk-test"
"#,
        )
        .unwrap();
        assert_eq!(auth_summary(&dangling, &|_| false)["models_ready"], false);
        assert_eq!(auth_summary(&dangling, &|_| false)["managed_provider"], json!(null));

        // A model whose provider is missing is not ready either.
        let provider_missing = KimiConfig::from_str(
            r#"
default_model = "k3"

[models.k3]
provider = "gone"
model = "k3"
max_context_size = 1000
"#,
        )
        .unwrap();
        assert_eq!(
            auth_summary(&provider_missing, &|_| false)["models_ready"],
            false
        );
    }
}
