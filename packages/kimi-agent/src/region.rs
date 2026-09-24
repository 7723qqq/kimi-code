//! Kimi region resolution — the port of `packages/oauth/src/region.ts`
//! (`resolveKimiRegion`, `kimiRegionProfile`, `resolveKimiRemoteControlAuth`)
//! plus the credential-slot key it compares against
//! (`managed-kimi-code.ts` `resolveKimiCodeOAuthKey`).
//!
//! Only what the Remote Control relay decision needs is ported: the two region
//! profiles' OAuth host / base URL / relay origin, the resolver that picks a
//! region, and the auth verdict that turns it into a relay origin. The
//! remaining profile fields (CDN, site, telemetry) belong to TS surfaces that
//! still live in `packages/oauth`.
//!
//! Why it exists in Rust: the standalone server owns the Remote Control runtime
//! (`server/remote_control.rs`) and must pick the relay that matches the user's
//! login region. Upstream #3969 fixed this by handing the server's configured
//! OAuth ref to the Remote Control manager, which then resolved both the
//! credential slot and the relay itself — no wire change. The wire shape
//! (`setRemoteControlRequestSchema` in the retired `kap-server`) stayed
//! `{ enabled: boolean }`, and so does this port.
use std::path::Path;

use sha2::{Digest, Sha256};

/// The managed Kimi Code provider id (`managed-kimi-code`); its `oauth` ref is
/// where a persisted login records its credential slot and OAuth host.
pub const KIMI_CODE_PROVIDER_NAME: &str = "managed:kimi-code";

/// The mainland-China credential slot. A login in this slot persists no
/// `oauthHost`, so the slot's presence is itself an explicit-mainland signal.
pub const KIMI_CODE_OAUTH_KEY: &str = "oauth/kimi-code";

/// Prefix of a per-environment credential slot
/// (`oauth/kimi-code-env-<digest>`).
pub const KIMI_CODE_SCOPED_OAUTH_KEY_PREFIX: &str = "oauth/kimi-code-env-";

/// Install-channel marker file under the Kimi home dir, written by install
/// scripts. Consulted only while the user has never logged in.
pub const KIMI_REGION_MARKER_FILENAME: &str = "region";

const DEFAULT_KIMI_CODE_OAUTH_HOST: &str = "https://auth.kimi.com";
const DEFAULT_KIMI_CODE_BASE_URL: &str = "https://api.kimi.com/coding/v1";

/// The two Kimi Code deployments. A region bundles the OAuth host, the managed
/// API base URL and the Remote Control relay origin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KimiRegion {
    MainlandCn,
    Global,
}

impl KimiRegion {
    pub fn as_str(self) -> &'static str {
        match self {
            KimiRegion::MainlandCn => "mainland-cn",
            KimiRegion::Global => "global",
        }
    }

    fn from_marker(raw: &str) -> Option<Self> {
        match raw.trim() {
            "mainland-cn" => Some(KimiRegion::MainlandCn),
            "global" => Some(KimiRegion::Global),
            _ => None,
        }
    }
}

/// The endpoints one region pins.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KimiRegionProfile {
    pub oauth_host: &'static str,
    pub base_url: &'static str,
    /// Remote Control relay origin (the public `kimi rc` / `/web` URL).
    pub relay_origin: &'static str,
}

pub fn kimi_region_profile(region: KimiRegion) -> KimiRegionProfile {
    match region {
        KimiRegion::MainlandCn => KimiRegionProfile {
            oauth_host: DEFAULT_KIMI_CODE_OAUTH_HOST,
            base_url: DEFAULT_KIMI_CODE_BASE_URL,
            relay_origin: crate::server::remote_control::REMOTE_CONTROL_RELAY_ORIGIN,
        },
        KimiRegion::Global => KimiRegionProfile {
            oauth_host: "https://auth.kimi.ai",
            base_url: "https://api.kimi.ai/coding/v1",
            relay_origin: "https://code-rc.kimi.ai",
        },
    }
}

fn normalize_endpoint(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn region_for_oauth_host(oauth_host: &str) -> Option<KimiRegion> {
    let normalized = normalize_endpoint(oauth_host);
    [KimiRegion::MainlandCn, KimiRegion::Global]
        .into_iter()
        .find(|region| normalize_endpoint(kimi_region_profile(*region).oauth_host) == normalized)
}

/// The credential slot an OAuth host / base URL pair logs into
/// (`resolveKimiCodeOAuthKey`). The default slot is shared by the mainland
/// endpoints; every other pair gets a scoped, digest-derived slot so two
/// environments never share one credential file.
pub fn resolve_kimi_code_oauth_key(oauth_host: Option<&str>, base_url: Option<&str>) -> String {
    let oauth_host = normalize_endpoint(oauth_host.unwrap_or(DEFAULT_KIMI_CODE_OAUTH_HOST));
    let base_url = normalize_endpoint(base_url.unwrap_or(DEFAULT_KIMI_CODE_BASE_URL));
    if oauth_host == DEFAULT_KIMI_CODE_OAUTH_HOST && base_url == DEFAULT_KIMI_CODE_BASE_URL {
        return KIMI_CODE_OAUTH_KEY.to_string();
    }
    // The digest covers the same JSON v2 hashes, field order included:
    // `JSON.stringify({ oauthHost, baseUrl })`. Each value goes through
    // serde's string encoder so a quote or backslash inside a configured
    // endpoint escapes exactly as `JSON.stringify` escapes it — hand-built
    // JSON would let two different endpoint pairs hash to one slot.
    let payload = format!(
        "{{\"oauthHost\":{},\"baseUrl\":{}}}",
        encode_json_string(&oauth_host),
        encode_json_string(&base_url),
    );
    let digest = Sha256::digest(payload.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{KIMI_CODE_SCOPED_OAUTH_KEY_PREFIX}{}", &hex[..16])
}

fn encode_json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| {
        // Encoding a `str` cannot fail; a fallback keeps a broken encoder from
        // silently hashing a different payload.
        format!("\"{}\"", value.replace('"', "\\\""))
    })
}

/// The credential slot a global (`.ai`) login uses. It is a scoped slot, not
/// the default one, so the relay verdict has to recognize it explicitly.
pub fn global_kimi_code_oauth_key() -> String {
    let profile = kimi_region_profile(KimiRegion::Global);
    resolve_kimi_code_oauth_key(Some(profile.oauth_host), Some(profile.base_url))
}

/// The persisted login ref as v2's server reads it: the managed provider's
/// `oauth` table in `config.toml` (`key` + `oauthHost`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConfiguredOAuthRef {
    pub key: Option<String>,
    pub oauth_host: Option<String>,
}

impl ConfiguredOAuthRef {
    /// Read `providers."managed:kimi-code".oauth` out of a loaded config.
    pub fn from_config(config: &crate::config::KimiConfig) -> Self {
        let oauth = config
            .providers
            .get(KIMI_CODE_PROVIDER_NAME)
            .and_then(|provider| provider.oauth.as_ref());
        Self {
            key: oauth
                .and_then(|oauth| oauth.get("key"))
                .and_then(|value| value.as_str())
                .map(str::to_string),
            oauth_host: oauth
                .and_then(|oauth| oauth.get("oauthHost"))
                .and_then(|value| value.as_str())
                .map(str::to_string),
        }
    }
}

/// Region resolution order (v2 `resolveKimiRegion`), first match wins:
/// 1. an env OAuth host that names a profile pins the region; an unknown env
///    host is a custom environment and falls through to the default,
/// 2. the persisted login's `oauthHost`,
/// 3. a persisted default-slot login (mainland-China persists no host),
/// 4. the install-channel marker file,
/// 5. mainland-China.
pub fn resolve_kimi_region(configured: &ConfiguredOAuthRef, home_dir: Option<&Path>) -> KimiRegion {
    let env_host = std::env::var("KIMI_CODE_OAUTH_HOST")
        .ok()
        .or_else(|| std::env::var("KIMI_OAUTH_HOST").ok())
        .filter(|value| !value.is_empty());
    if let Some(host) = env_host {
        return region_for_oauth_host(&host).unwrap_or(KimiRegion::MainlandCn);
    }
    if let Some(host) = configured
        .oauth_host
        .as_deref()
        .filter(|host| !host.is_empty())
        && let Some(region) = region_for_oauth_host(host)
    {
        return region;
    }
    if configured.key.as_deref() == Some(KIMI_CODE_OAUTH_KEY) {
        return KimiRegion::MainlandCn;
    }
    if let Some(home) = home_dir
        && let Ok(raw) = std::fs::read_to_string(home.join(KIMI_REGION_MARKER_FILENAME))
        && let Some(region) = KimiRegion::from_marker(&raw)
    {
        return region;
    }
    KimiRegion::MainlandCn
}

/// The relay origin Remote Control must use, given the persisted login.
///
/// v2 `resolveKimiRemoteControlAuth`: the relay follows the resolved region,
/// except that a custom-environment login — a scoped slot outside the two
/// official ones, with no recognized `oauthHost` — keeps the mainland relay, so
/// an install-channel marker cannot flip a custom environment to `.ai`.
pub fn resolve_kimi_remote_control_relay_origin(
    configured: &ConfiguredOAuthRef,
    home_dir: Option<&Path>,
) -> String {
    let region = resolve_kimi_region(configured, home_dir);
    let profile = kimi_region_profile(region);
    let custom_slot = configured
        .key
        .as_deref()
        .filter(|key| !key.is_empty())
        .is_some_and(|key| key != KIMI_CODE_OAUTH_KEY && key != global_kimi_code_oauth_key());
    let host_pinned = configured
        .oauth_host
        .as_deref()
        .filter(|host| !host.is_empty())
        .is_some_and(|host| region_for_oauth_host(host).is_some());
    if custom_slot && !host_pinned {
        return kimi_region_profile(KimiRegion::MainlandCn)
            .relay_origin
            .to_string();
    }
    profile.relay_origin.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ref_with(key: Option<&str>, oauth_host: Option<&str>) -> ConfiguredOAuthRef {
        ConfiguredOAuthRef {
            key: key.map(str::to_string),
            oauth_host: oauth_host.map(str::to_string),
        }
    }

    #[test]
    fn the_global_slot_key_matches_the_ts_digest() {
        // `sha256('{"oauthHost":"https://auth.kimi.ai","baseUrl":"https://api.kimi.ai/coding/v1"}')`
        // truncated to 16 hex chars, as `resolveKimiCodeOAuthKey` computes it.
        assert_eq!(
            global_kimi_code_oauth_key(),
            "oauth/kimi-code-env-0e4f99c69cc27850"
        );
        assert_eq!(
            resolve_kimi_code_oauth_key(Some("https://auth.kimi.com"), None),
            KIMI_CODE_OAUTH_KEY
        );
        assert_eq!(
            resolve_kimi_code_oauth_key(
                Some("https://auth.kimi.com/"),
                Some("https://api.kimi.com/coding/v1/")
            ),
            KIMI_CODE_OAUTH_KEY,
            "endpoint normalization must not change the default slot"
        );
    }

    /// A quote inside an endpoint must escape like `JSON.stringify` does,
    /// otherwise two different endpoint pairs could hash to the same slot —
    /// and two environments would then share one credential file.
    #[test]
    fn the_slot_digest_escapes_endpoints_instead_of_interpolating_them() {
        let quoted = resolve_kimi_code_oauth_key(
            Some("https://auth.example/\""),
            Some("https://api.example/v1"),
        );
        let crafted: String = resolve_kimi_code_oauth_key(
            Some("https://auth.example/x"),
            Some("https://api.example/v1\""),
        );
        assert_ne!(quoted, crafted, "distinct endpoints must not share a slot");
        let expected_digest = {
            use sha2::{Digest, Sha256};
            let payload = "{\"oauthHost\":\"https://auth.example/\\\"\",\"baseUrl\":\"https://api.example/v1\"}";
            let hex: String = Sha256::digest(payload.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            format!("{KIMI_CODE_SCOPED_OAUTH_KEY_PREFIX}{}", &hex[..16])
        };
        assert_eq!(quoted, expected_digest);
    }

    #[test]
    fn a_global_login_picks_the_global_relay() {
        let configured = ref_with(
            Some(&global_kimi_code_oauth_key()),
            Some("https://auth.kimi.ai"),
        );
        assert_eq!(resolve_kimi_region(&configured, None), KimiRegion::Global);
        assert_eq!(
            resolve_kimi_remote_control_relay_origin(&configured, None),
            "https://code-rc.kimi.ai"
        );
    }

    #[test]
    fn a_mainland_login_picks_the_mainland_relay() {
        let configured = ref_with(Some(KIMI_CODE_OAUTH_KEY), None);
        assert_eq!(
            resolve_kimi_region(&configured, None),
            KimiRegion::MainlandCn
        );
        assert_eq!(
            resolve_kimi_remote_control_relay_origin(&configured, None),
            crate::server::remote_control::REMOTE_CONTROL_RELAY_ORIGIN
        );
    }

    #[test]
    fn a_custom_environment_keeps_the_mainland_relay_even_under_a_global_marker() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(KIMI_REGION_MARKER_FILENAME), "global\n").unwrap();
        // Region follows the marker, but the relay must not: a scoped custom
        // slot with no recognized host stays on the mainland relay.
        let configured = ref_with(Some("oauth/kimi-code-env-deadbeefdeadbeef"), None);
        assert_eq!(
            resolve_kimi_region(&configured, Some(dir.path())),
            KimiRegion::Global
        );
        assert_eq!(
            resolve_kimi_remote_control_relay_origin(&configured, Some(dir.path())),
            crate::server::remote_control::REMOTE_CONTROL_RELAY_ORIGIN
        );
        // A recognized host pins the region, so the global relay applies.
        let pinned = ref_with(
            Some("oauth/kimi-code-env-deadbeefdeadbeef"),
            Some("https://auth.kimi.ai"),
        );
        assert_eq!(
            resolve_kimi_remote_control_relay_origin(&pinned, Some(dir.path())),
            "https://code-rc.kimi.ai"
        );
    }

    #[test]
    fn the_marker_only_decides_before_a_login_and_outranks_nothing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(KIMI_REGION_MARKER_FILENAME), "  global  ").unwrap();
        assert_eq!(
            resolve_kimi_region(&ConfiguredOAuthRef::default(), Some(dir.path())),
            KimiRegion::Global
        );
        // A persisted default-slot login is an explicit mainland signal and
        // outranks the marker.
        let configured = ref_with(Some(KIMI_CODE_OAUTH_KEY), None);
        assert_eq!(
            resolve_kimi_region(&configured, Some(dir.path())),
            KimiRegion::MainlandCn
        );
        // A marker that is neither region name is ignored.
        std::fs::write(dir.path().join(KIMI_REGION_MARKER_FILENAME), "mars\n").unwrap();
        assert_eq!(
            resolve_kimi_region(&ConfiguredOAuthRef::default(), Some(dir.path())),
            KimiRegion::MainlandCn
        );
    }

    #[test]
    fn an_unknown_configured_host_does_not_pin_a_region() {
        // Falls through to the default slot check, then the (absent) marker.
        let configured = ref_with(None, Some("https://auth.internal.example"));
        assert_eq!(
            resolve_kimi_region(&configured, None),
            KimiRegion::MainlandCn
        );
        assert_eq!(
            resolve_kimi_remote_control_relay_origin(&configured, None),
            crate::server::remote_control::REMOTE_CONTROL_RELAY_ORIGIN
        );
    }

    #[test]
    fn the_persisted_ref_is_read_from_the_managed_provider() {
        let config: crate::config::KimiConfig = concat!(
            "[providers.\"managed:kimi-code\"]\n",
            "type = \"kimi\"\n\n",
            "[providers.\"managed:kimi-code\".oauth]\n",
            "key = \"oauth/kimi-code-env-0e4f99c69cc27850\"\n",
            "oauthHost = \"https://auth.kimi.ai\"\n",
        )
        .parse()
        .unwrap();
        let configured = ConfiguredOAuthRef::from_config(&config);
        assert_eq!(
            configured.key.as_deref(),
            Some("oauth/kimi-code-env-0e4f99c69cc27850")
        );
        assert_eq!(
            configured.oauth_host.as_deref(),
            Some("https://auth.kimi.ai")
        );
        assert_eq!(
            resolve_kimi_remote_control_relay_origin(&configured, None),
            "https://code-rc.kimi.ai"
        );
    }
}
