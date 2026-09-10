//! The `[secondary_model]` subagent model pool (v2
//! `session/subagent/configSection.ts`).
//!
//! The host resolves the pool from `config.toml` (aliases, hints, force, the
//! default alias) and — because only the host knows provider credentials —
//! hands the engine one ready-built LLM per alias. The engine owns the
//! user-visible semantics from there: which models the `Agent` / `AgentSwarm`
//! tools advertise, how an explicit `model` argument resolves, and the error
//! texts a bad choice produces.

use std::collections::HashMap;
use std::sync::Arc;

use crate::rpc::types::{SecondaryModelEntry, SecondaryModelPool};
use crate::turn_loop::types::LLM;

/// The reserved alias that always binds the caller's own model.
pub const PRIMARY_MODEL_CHOICE: &str = "primary";

/// Where a subagent's bound model came from (v2 `SubagentModelSource`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentModelSource {
    /// `force = true` pinned the model; the `model` parameter is rejected.
    Forced,
    /// The caller passed `primary` and inherits its own model and effort.
    PrimaryOverride,
    /// No pool applies; the caller's model is inherited.
    Inherited,
    /// The requested alias, or the pool's default model.
    SecondaryPool,
}

/// One resolved subagent binding: the LLM to run with plus provenance.
#[derive(Clone)]
pub struct SubagentBinding {
    pub llm: Arc<dyn LLM>,
    pub source: SubagentModelSource,
}

/// The pool plus its live LLMs. The caller passes the session's own LLM at
/// resolve time, because `primary` (and the inherited fallback) bind it and
/// the session LLM is built after the pool.
pub struct SecondaryModelRuntime {
    config: SecondaryModelPool,
    llms: HashMap<String, Arc<dyn LLM>>,
}

impl SecondaryModelRuntime {
    pub fn new(config: SecondaryModelPool, llms: HashMap<String, Arc<dyn LLM>>) -> Self {
        Self { config, llms }
    }

    /// Whether the tool schema advertises the `model` parameter. `force`
    /// removes the choice, so the parameter is hidden (v2
    /// `exposesSubagentModelChoice`).
    pub fn exposes_choice(&self) -> bool {
        !self.config.force
    }

    /// The pool listing appended to the `Agent` / `AgentSwarm` descriptions,
    /// with `[default]` and `[main model]` markers plus the reserved
    /// `primary` entry (v2 `buildSubagentModelDescriptions`).
    pub fn description(&self) -> String {
        let mut lines = vec!["Available models (pass via model):".to_string()];
        let default_model = self.config.default_model.as_str();
        let caller = self.config.caller_model_alias.as_deref();
        let format_entry = |entry: &SecondaryModelEntry| {
            let mut markers: Vec<&str> = Vec::new();
            if entry.alias == default_model {
                markers.push("[default]");
            }
            if caller == Some(entry.alias.as_str()) {
                markers.push("[main model]");
            }
            let marker = if markers.is_empty() {
                String::new()
            } else {
                format!(" {}", markers.join(" "))
            };
            let label = format!("{}{marker}", entry.alias);
            if entry.hint.is_empty() {
                format!("- {label}")
            } else {
                format!("- {label}: {}", entry.hint)
            }
        };
        // v2 lists the default alias first, then the rest in configured order.
        if let Some(entry) = self
            .config
            .models
            .iter()
            .find(|entry| entry.alias == default_model)
        {
            lines.push(format_entry(entry));
        }
        for entry in self
            .config
            .models
            .iter()
            .filter(|entry| entry.alias != default_model)
        {
            lines.push(format_entry(entry));
        }
        let caller_suffix = match caller.filter(|alias| self.llms.contains_key(*alias)) {
            Some(alias) => format!(" ({alias})"),
            None => String::new(),
        };
        lines.push(format!(
            "- {PRIMARY_MODEL_CHOICE}{caller_suffix}: the main model you are running on, bound with your current thinking level; use it for hard, quality-sensitive subagent tasks"
        ));
        lines.join("\n")
    }

    /// Resolve a spawn's model binding (v2 `resolveSubagentBinding`).
    ///
    /// Errors mirror v2's `CONFIG_INVALID` texts so the model sees the same
    /// guidance: they name the offending value and list the available choices.
    pub fn resolve(
        &self,
        session_llm: &Arc<dyn LLM>,
        requested: Option<&str>,
    ) -> Result<SubagentBinding, String> {
        if self.config.force {
            if let Some(requested) = requested {
                return Err(format!(
                    "Invalid model \"{requested}\": [secondary_model].force is set, so every subagent binds \"{}\" (omit the model parameter).",
                    self.config.default_model
                ));
            }
            return Ok(self.bind(self.config.default_model.as_str(), SubagentModelSource::Forced)?);
        }
        if requested == Some(PRIMARY_MODEL_CHOICE) {
            return Ok(SubagentBinding {
                llm: session_llm.clone(),
                source: SubagentModelSource::PrimaryOverride,
            });
        }
        if self.llms.contains_key(PRIMARY_MODEL_CHOICE) {
            return Err(format!(
                "[secondary_model.models] key \"{PRIMARY_MODEL_CHOICE}\" is reserved: it always binds the caller's own model. Rename the pool entry."
            ));
        }
        let choice = requested.unwrap_or(self.config.default_model.as_str());
        self.bind(choice, SubagentModelSource::SecondaryPool)
    }

    fn bind(&self, alias: &str, source: SubagentModelSource) -> Result<SubagentBinding, String> {
        let llm = self.llms.get(alias).ok_or_else(|| {
            let mut available: Vec<&str> = self
                .config
                .models
                .iter()
                .map(|entry| entry.alias.as_str())
                .collect();
            available.push(PRIMARY_MODEL_CHOICE);
            format!(
                "Invalid model \"{alias}\". Available models: {}.",
                available.join(", ")
            )
        })?;
        Ok(SubagentBinding {
            llm: llm.clone(),
            source,
        })
    }

    /// Resolve without a pool: an explicit `model` argument is rejected (the
    /// parameter is not advertised) and everything else inherits the session's
    /// own model.
    pub fn resolve_without_pool(requested: Option<&str>) -> Result<(), String> {
        match requested {
            Some(requested) => Err(format!(
                "Invalid model \"{requested}\": no [secondary_model.models] pool is configured, so subagents inherit the caller's model (pass \"{PRIMARY_MODEL_CHOICE}\" or omit the model parameter)."
            )),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::types::{BoxFuture, SecondaryModelEntry};
    use crate::turn_loop::types::{LLMChatParams, LLMChatResponse};

    struct NamedLlm(String);

    impl LLM for NamedLlm {
        fn system_prompt(&self) -> &str {
            "test"
        }
        fn model_name(&self) -> &str {
            &self.0
        }
        fn is_retryable_error(&self, _: &str) -> bool {
            false
        }
        fn chat(
            &self,
            _: LLMChatParams,
        ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
        {
            Box::pin(async {
                Ok(LLMChatResponse {
                    content: String::new(),
                    thinking: vec![],
                    tool_calls: vec![],
                    finish_reason: Some("stop".into()),
                    usage: crate::rpc::types::TokenUsage::default(),
                })
            })
        }
    }

    fn llm_llm(name: &str) -> Arc<dyn LLM> {
        Arc::new(NamedLlm(name.into()))
    }

    fn entry(alias: &str, hint: &str) -> SecondaryModelEntry {
        SecondaryModelEntry {
            alias: alias.into(),
            hint: hint.into(),
            llm: Default::default(),
        }
    }

    fn runtime(force: bool, models: Vec<SecondaryModelEntry>) -> SecondaryModelRuntime {
        let llms = models
            .iter()
            .map(|entry| (entry.alias.clone(), llm_llm(&entry.alias)))
            .collect();
        let config = SecondaryModelPool {
            force,
            default_model: models[0].alias.clone(),
            caller_model_alias: Some("main-model".into()),
            models,
        };
        SecondaryModelRuntime::new(config, llms)
    }

    fn session_llm() -> Arc<dyn LLM> {
        llm_llm("primary-llm")
    }

    fn pool_runtime() -> SecondaryModelRuntime {
        runtime(
            false,
            vec![
                entry("fast", "Cheap and quick."),
                entry("strong", "Pick this for hard problems."),
            ],
        )
    }

    #[test]
    fn default_binding_uses_the_default_alias() {
        let pool = pool_runtime();
        let binding = pool.resolve(&session_llm(), None).unwrap();
        assert_eq!(binding.source, SubagentModelSource::SecondaryPool);
        assert_eq!(binding.llm.model_name(), "fast");
    }

    #[test]
    fn explicit_alias_binds_that_alias() {
        let pool = pool_runtime();
        let binding = pool.resolve(&session_llm(), Some("strong")).unwrap();
        assert_eq!(binding.llm.model_name(), "strong");
    }

    #[test]
    fn primary_binds_the_session_llm() {
        let pool = pool_runtime();
        let binding = pool.resolve(&session_llm(), Some(PRIMARY_MODEL_CHOICE)).unwrap();
        assert_eq!(binding.source, SubagentModelSource::PrimaryOverride);
        assert_eq!(binding.llm.model_name(), "primary-llm");
    }

    #[test]
    fn invalid_alias_lists_the_available_choices() {
        let pool = pool_runtime();
        let Err(error) = pool.resolve(&session_llm(), Some("nope")) else {
            panic!("an unknown alias must fail");
        };
        assert!(error.contains("Invalid model \"nope\""), "{error}");
        assert!(error.contains("fast, strong, primary"), "{error}");
    }

    #[test]
    fn force_rejects_an_explicit_model_and_binds_the_default() {
        let pool = runtime(true, vec![entry("only", "")]);
        let forced = pool.resolve(&session_llm(), None).unwrap();
        assert_eq!(forced.source, SubagentModelSource::Forced);
        assert_eq!(forced.llm.model_name(), "only");

        let Err(error) = pool.resolve(&session_llm(), Some("other")) else {
            panic!("force must reject an explicit model");
        };
        assert!(error.contains("[secondary_model].force"), "{error}");
        let Err(primary) = pool.resolve(&session_llm(), Some(PRIMARY_MODEL_CHOICE)) else {
            panic!("force must reject primary too");
        };
        assert!(primary.contains("force is set"), "{primary}");
    }

    #[test]
    fn force_hides_the_model_parameter() {
        let pool = runtime(true, vec![entry("only", "")]);
        assert!(!pool.exposes_choice());
        assert!(pool_runtime().exposes_choice());
    }

    #[test]
    fn description_marks_default_and_main_model() {
        let mut pool = pool_runtime();
        // The configured order puts the non-default entry first; v2 still
        // lists the default alias first.
        pool.config.models = vec![
            entry("strong", "Pick this for hard problems."),
            entry("fast", "Cheap and quick."),
        ];
        pool.config.caller_model_alias = Some("strong".into());
        let description = pool.description();
        assert!(description.contains("- fast [default]"), "{description}");
        assert!(description.contains("- strong [main model]"), "{description}");
        assert!(description.contains("- primary (strong)"), "{description}");
        let default_line = description.find("- fast [default]").expect("default line listed");
        let main_line = description.find("- strong [main model]").expect("main line listed");
        assert!(default_line < main_line, "{description}");
    }

    #[test]
    fn without_a_pool_an_explicit_model_is_rejected() {
        assert!(SecondaryModelRuntime::resolve_without_pool(None).is_ok());
        let error = SecondaryModelRuntime::resolve_without_pool(Some("fast")).unwrap_err();
        assert!(error.contains("no [secondary_model.models] pool"), "{error}");
        assert!(error.contains("primary"), "{error}");
    }
}
