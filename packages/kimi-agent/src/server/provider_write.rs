//! Provider create / replace / delete / get, porting kap-server's
//! `routes/modelCatalog.ts` write half.
//!
//! Writes mutate `config.toml` through [`crate::config::write`] (toml_edit,
//! format-preserving) and refresh the server's cached config, so the next
//! `/models` / `/providers` read reflects the change. `default_provider` and
//! `default_model` are only migrated on a rename; plain create `default_model`
//! seeding happens once, when no default is set.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::config::KimiConfig;
use crate::config::write::{
    ModelAliasWrite, ProviderWrite, remove_model_aliases_of, remove_provider, set_default_model,
    set_default_provider, update_config, write_model_alias, write_provider,
};
use crate::server::envelope::error_codes;
use crate::server::model_catalog::{self, non_empty};

/// One protocol error: HTTP status, kap-server code, message.
pub type WriteError = (u16, u32, String);

/// `providerWireTypeSchema`.
const WIRE_TYPES: [&str; 6] = [
    "kimi",
    "openai",
    "openai_responses",
    "anthropic",
    "google-genai",
    "vertexai",
];

fn validation(message: impl Into<String>) -> WriteError {
    (400, error_codes::VALIDATION_FAILED, message.into())
}

fn not_found(provider_id: &str) -> WriteError {
    (
        404,
        error_codes::PROVIDER_NOT_FOUND,
        format!("provider {provider_id} does not exist"),
    )
}

fn oauth_managed(provider_id: &str) -> WriteError {
    (
        400,
        error_codes::PROVIDER_OAUTH_MANAGED,
        format!("provider {provider_id} is managed by OAuth login; use POST /oauth/logout instead"),
    )
}

fn already_exists(provider_id: &str) -> WriteError {
    (
        409,
        error_codes::PROVIDER_ALREADY_EXISTS,
        format!("provider {provider_id} already exists"),
    )
}

fn persistence(error: String) -> WriteError {
    (500, error_codes::INTERNAL_ERROR, error)
}

/// One `models[]` entry (`createProviderModelSchema`).
#[derive(Debug, Clone, Deserialize)]
pub struct ProviderModelForm {
    pub model: String,
    #[serde(rename = "max_context_size")]
    pub max_context_size: u32,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub capabilities: Option<Vec<String>>,
    #[serde(rename = "max_output_size", default)]
    pub max_output_size: Option<u32>,
    #[serde(rename = "support_efforts", default)]
    pub support_efforts: Option<Vec<String>>,
    #[serde(rename = "adaptive_thinking", default)]
    pub adaptive_thinking: Option<bool>,
}

/// `POST /providers` body (`createProviderRequestSchema`).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateProviderForm {
    pub id: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub default_model: Option<String>,
    pub models: Vec<ProviderModelForm>,
}

/// `PUT /providers/{id}` body (`replaceProviderRequestSchema`).
#[derive(Debug, Clone, Deserialize)]
pub struct ReplaceProviderForm {
    #[serde(default)]
    pub new_id: Option<String>,
    #[serde(rename = "type")]
    pub provider_type: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub default_model: Option<String>,
    pub models: Vec<ProviderModelForm>,
}

fn validate_provider_id(provider_id: &str) -> Result<(), WriteError> {
    let valid = !provider_id.is_empty()
        && provider_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_');
    if valid {
        Ok(())
    } else {
        Err(validation(
            "id must start with a letter or digit and may only contain letters, digits, \"-\", \"_\" and spaces",
        ))
    }
}

fn validate_form(
    provider_type: &str,
    models: &[ProviderModelForm],
    default_model: Option<&str>,
    base_url: Option<&str>,
) -> Result<(), WriteError> {
    if !WIRE_TYPES.contains(&provider_type) {
        return Err(validation(format!(
            "type must be one of: {}",
            WIRE_TYPES.join(", ")
        )));
    }
    if let Some(base_url) = base_url
        && base_url.contains("${")
    {
        return Err(validation(
            "base_url must not contain an environment variable placeholder",
        ));
    }
    if models.is_empty() {
        return Err(validation("models must contain at least one entry"));
    }
    let mut seen = HashSet::new();
    for entry in models {
        if entry.model.trim().is_empty() {
            return Err(validation("model must be a non-empty string"));
        }
        if entry.max_context_size == 0 {
            return Err(validation(format!(
                "max_context_size must be at least 1 for model {}",
                entry.model
            )));
        }
        if !seen.insert(entry.model.as_str()) {
            return Err(validation(format!("duplicate model: {}", entry.model)));
        }
    }
    if let Some(default_model) = default_model
        && !models.iter().any(|entry| entry.model == default_model)
    {
        return Err(validation("default_model must be one of models[].model"));
    }
    Ok(())
}

fn alias_write(provider_id: &str, entry: &ProviderModelForm) -> ModelAliasWrite {
    ModelAliasWrite {
        alias_id: format!("{provider_id}/{}", entry.model),
        provider: provider_id.to_string(),
        model: entry.model.clone(),
        max_context_size: entry.max_context_size,
        display_name: entry.display_name.clone(),
        capabilities: entry.capabilities.clone(),
        max_output_size: entry.max_output_size,
        support_efforts: entry.support_efforts.clone(),
        default_effort: None,
        adaptive_thinking: entry.adaptive_thinking,
        protocol: None,
        beta_api: None,
    }
}

/// The config the next write builds on: the file being written when the
/// server pinned one, otherwise the discovered file.
fn effective_config(config_path: Option<&std::path::Path>) -> KimiConfig {
    match config_path {
        Some(path) => KimiConfig::from_file(path).unwrap_or_default(),
        None => KimiConfig::discover()
            .map(|(config, _)| config)
            .unwrap_or_default(),
    }
}

/// `POST /providers`: create the provider, write its model aliases, and seed
/// the global `default_model` when none is set yet.
pub async fn create(
    config_lock: &Mutex<Option<KimiConfig>>,
    config_path: Option<&std::path::Path>,
    has_cached_token: &(dyn Fn(&str) -> bool + Sync),
    form: CreateProviderForm,
) -> Result<Value, WriteError> {
    validate_provider_id(&form.id)?;
    validate_form(
        &form.provider_type,
        &form.models,
        form.default_model.as_deref(),
        form.base_url.as_deref(),
    )?;

    let mut guard = config_lock.lock().await;
    let before = guard.clone().unwrap_or_else(|| effective_config(config_path));
    if before.providers.contains_key(&form.id) {
        return Err(already_exists(&form.id));
    }

    let default_model = form
        .default_model
        .as_ref()
        .map(|model| format!("{}/{}", form.id, model));
    let seed_default = non_empty(before.default_model.as_deref()).is_none();
    let seed_alias = default_model
        .clone()
        .or_else(|| form.models.first().map(|entry| format!("{}/{}", form.id, entry.model)));

    let updated = update_config(config_path, |document| {
        write_provider(
            document,
            &form.id,
            &ProviderWrite {
                provider_type: form.provider_type.clone(),
                api_key: form.api_key.clone(),
                base_url: form.base_url.clone(),
                default_model: default_model.clone(),
            },
        )?;
        for entry in &form.models {
            write_model_alias(document, &alias_write(&form.id, entry))?;
        }
        if seed_default && let Some(alias) = &seed_alias {
            set_default_model(document, Some(alias));
        }
        Ok(())
    })
    .map_err(persistence)?;
    *guard = Some(updated.clone());
    Ok(model_catalog::provider_item(&updated, &form.id, has_cached_token).unwrap_or(Value::Null))
}

/// `PUT /providers/{id}`: replace the provider and rebuild its aliases,
/// optionally renaming it (migrating `default_provider` / `default_model`).
pub async fn replace(
    config_lock: &Mutex<Option<KimiConfig>>,
    config_path: Option<&std::path::Path>,
    has_cached_token: &(dyn Fn(&str) -> bool + Sync),
    provider_id: &str,
    form: ReplaceProviderForm,
) -> Result<Value, WriteError> {
    validate_provider_id(provider_id)?;
    let new_id = form
        .new_id
        .clone()
        .unwrap_or_else(|| provider_id.to_string());
    validate_provider_id(&new_id)?;
    validate_form(
        &form.provider_type,
        &form.models,
        form.default_model.as_deref(),
        form.base_url.as_deref(),
    )?;

    let mut guard = config_lock.lock().await;
    let before = guard.clone().unwrap_or_else(|| effective_config(config_path));
    let Some(target) = before.providers.get(provider_id) else {
        return Err(not_found(provider_id));
    };
    if target.oauth.is_some() {
        return Err(oauth_managed(provider_id));
    }
    let renamed = new_id != provider_id;
    if renamed && before.providers.contains_key(&new_id) {
        return Err(already_exists(&new_id));
    }

    // Aliases the new provider would take over must already belong to it.
    let new_aliases: Vec<String> = form
        .models
        .iter()
        .map(|entry| format!("{new_id}/{}", entry.model))
        .collect();
    let colliding: Vec<&str> = before
        .models
        .iter()
        .filter(|(alias_id, record)| {
            new_aliases.contains(alias_id) && record.provider.as_deref() != Some(provider_id)
        })
        .map(|(alias_id, _)| alias_id.as_str())
        .collect();
    if !colliding.is_empty() {
        return Err(validation(format!(
            "model alias key already owned by another provider: {}",
            colliding.join(", ")
        )));
    }

    // Rename migration for the global pointers (only when they point here).
    let default_provider_hit =
        renamed && non_empty(before.default_provider.as_deref()) == Some(provider_id);
    let renamed_default_model = if renamed {
        non_empty(before.default_model.as_deref())
            .and_then(|alias_id| before.models.get(alias_id))
            .filter(|record| record.provider.as_deref() == Some(provider_id))
            .and_then(|record| record.model.clone())
            .map(|model| format!("{new_id}/{model}"))
            .filter(|alias| new_aliases.contains(alias))
    } else {
        None
    };

    let api_key = form.api_key.clone().or_else(|| target.api_key.clone());
    let default_model = form
        .default_model
        .as_ref()
        .map(|model| format!("{new_id}/{model}"));

    let updated = update_config(config_path, |document| {
        if renamed {
            remove_provider(document, provider_id);
        }
        remove_model_aliases_of(document, provider_id);
        write_provider(
            document,
            &new_id,
            &ProviderWrite {
                provider_type: form.provider_type.clone(),
                api_key: api_key.clone(),
                base_url: form.base_url.clone(),
                default_model: default_model.clone(),
            },
        )?;
        for entry in &form.models {
            write_model_alias(document, &alias_write(&new_id, entry))?;
        }
        if default_provider_hit {
            set_default_provider(document, &new_id);
        }
        if let Some(alias) = &renamed_default_model {
            set_default_model(document, Some(alias));
        }
        Ok(())
    })
    .map_err(persistence)?;
    *guard = Some(updated.clone());
    Ok(json!({
        "provider": model_catalog::provider_item(&updated, &new_id, has_cached_token)
            .unwrap_or(Value::Null)
    }))
}

/// `DELETE /providers/{id}`: drop the provider and its aliases; the global
/// default pointers are the user's settings and stay untouched.
pub async fn delete(
    config_lock: &Mutex<Option<KimiConfig>>,
    config_path: Option<&std::path::Path>,
    provider_id: &str,
) -> Result<Value, WriteError> {
    let mut guard = config_lock.lock().await;
    let before = guard.clone().unwrap_or_else(|| effective_config(config_path));
    let Some(target) = before.providers.get(provider_id) else {
        return Err(not_found(provider_id));
    };
    if target.oauth.is_some() {
        return Err(oauth_managed(provider_id));
    }
    let updated = update_config(config_path, |document| {
        remove_provider(document, provider_id);
        remove_model_aliases_of(document, provider_id);
        Ok(())
    })
    .map_err(persistence)?;
    *guard = Some(updated);
    Ok(json!({ "deleted": true }))
}

/// `GET /providers/{id}`: unlike the list route, the stored `api_key` is
/// revealed so clients can prefill an edit form.
pub async fn get(
    config_lock: &Mutex<Option<KimiConfig>>,
    config_path: Option<&std::path::Path>,
    has_cached_token: &(dyn Fn(&str) -> bool + Sync),
    provider_id: &str,
) -> Result<Value, WriteError> {
    let config = config_lock
        .lock()
        .await
        .clone()
        .unwrap_or_else(|| effective_config(config_path));
    let Some(mut item) = model_catalog::provider_item(&config, provider_id, has_cached_token)
    else {
        return Err(not_found(provider_id));
    };
    if let Some(api_key) = config
        .providers
        .get(provider_id)
        .and_then(|provider| non_empty(provider.api_key.as_deref()))
    {
        item["api_key"] = json!(api_key);
    }
    Ok(item)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(model: &str, max_context_size: u32) -> ProviderModelForm {
        ProviderModelForm {
            model: model.into(),
            max_context_size,
            display_name: None,
            capabilities: None,
            max_output_size: None,
            support_efforts: None,
            adaptive_thinking: None,
        }
    }

    fn create_form() -> CreateProviderForm {
        CreateProviderForm {
            id: "kimi-code".into(),
            provider_type: "openai".into(),
            api_key: Some("sk-test".into()),
            base_url: Some("https://example.test/v1".into()),
            default_model: Some("k3".into()),
            models: vec![model("k3", 200_000), model("fast", 128_000)],
        }
    }

    #[test]
    fn validation_rejects_malformed_forms() {
        let mut bad_id = create_form();
        bad_id.id = "has space!".into();
        assert_eq!(
            validate_provider_id(&bad_id.id).unwrap_err().1,
            error_codes::VALIDATION_FAILED
        );

        let mut bad_type = create_form();
        bad_type.provider_type = "exotic".into();
        assert!(validate_form("exotic", &bad_type.models, None, None).is_err());

        assert!(validate_form("openai", &[], None, None).is_err());
        assert!(validate_form("openai", &[model("a", 0)], None, None).is_err());
        assert!(
            validate_form("openai", &[model("a", 1000), model("a", 1000)], None, None).is_err()
        );
        assert!(
            validate_form("openai", &[model("a", 1000)], Some("missing"), None).is_err(),
            "default_model must be one of models"
        );
        assert!(
            validate_form("openai", &[model("a", 1000)], None, Some("https://${HOST}/v1")).is_err()
        );
        assert!(validate_form("openai", &[model("a", 1000)], Some("a"), None).is_ok());
    }
}
