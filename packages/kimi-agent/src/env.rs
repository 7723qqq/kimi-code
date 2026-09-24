//! Environment-variable switch parsing (v2 `_base/utils/env.ts`
//! `parseBooleanEnv`).

/// v2 `parseBooleanEnv`: `1` / `true` / `yes` / `on` are truthy and
/// `0` / `false` / `no` / `off` falsy (case-insensitive, surrounding
/// whitespace ignored); an unset, empty, or unrecognized value is neither.
pub fn parse_bool_env(value: Option<&str>) -> Option<bool> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "" => None,
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Env switch that defaults ON (v2 `parseBooleanEnv(...) !== false`): only an
/// explicit falsy value disables it — unset, empty, or unrecognized keeps it
/// on.
pub fn env_switch_default_on(name: &str) -> bool {
    parse_bool_env(std::env::var(name).ok().as_deref()) != Some(false)
}

/// Env switch that defaults OFF (v2 `parseBooleanEnv(...) === true`): only an
/// explicit truthy value enables it.
pub fn env_switch_default_off(name: &str) -> bool {
    parse_bool_env(std::env::var(name).ok().as_deref()) == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_bool_env_matches_v2_parse_boolean_env() {
        for value in ["1", "true", " TRUE ", "yes", "on", "On"] {
            assert_eq!(parse_bool_env(Some(value)), Some(true), "{value:?}");
        }
        for value in ["0", "false", " FALSE ", "no", "off", "Off"] {
            assert_eq!(parse_bool_env(Some(value)), Some(false), "{value:?}");
        }
        for value in [None, Some(""), Some("  "), Some("banana"), Some("2")] {
            assert_eq!(parse_bool_env(value), None, "{value:?}");
        }
    }

    #[test]
    fn default_on_only_bows_to_an_explicit_falsy() {
        for value in [None, Some(""), Some("1"), Some("banana"), Some("on")] {
            assert!(
                parse_bool_env(value) != Some(false),
                "{value:?} keeps a default-on switch on"
            );
        }
        for value in ["0", "false", "no", "off"] {
            assert_eq!(parse_bool_env(Some(value)), Some(false), "{value:?}");
        }
    }
}
