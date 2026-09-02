//! Bearer-token authentication for the native API, modelled on the rules
//! `packages/kap-server` enforces so one client credential works against either
//! server.
//!
//! Mirrored:
//!
//! - the credential is `Authorization: Bearer <token>` on REST, and a
//!   `kimi-code.bearer.<token>` subprotocol on the WebSocket upgrade, because a
//!   browser cannot set headers on a WebSocket handshake;
//! - a token is 32 random bytes as base64url (43 chars, unpadded), the same
//!   shape as kap-server's `server.token`, and read from / written to the same
//!   file;
//! - a rejected request gets `401` with the `{code: 40101, message:
//!   "Unauthorized"}` envelope;
//! - `OPTIONS`, the health route and the two schema documents need no
//!   credential.
//!
//! Not mirrored, deliberately: kap-server's per-IP failure limiter (a separate
//! middleware there), and its rule that non-`/api/` paths serve static web
//! assets — this server has none, so an unknown path is a 404, not a bypass.

use std::sync::Arc;

use base64::prelude::*;

const BEARER_PREFIX: &str = "Bearer ";

/// The subprotocol a browser uses to carry the token into a WebSocket upgrade.
pub const WS_BEARER_PREFIX: &str = "kimi-code.bearer.";

/// Random bytes behind a generated token (base64url of 32 bytes is 43 chars).
const TOKEN_BYTES: usize = 32;

/// Whether a request may proceed.
///
/// `Missing` and `Invalid` are kept apart for the server's own use — a future
/// failure limiter bans on `Invalid` and not on `Missing`. The client sees the
/// same 401 envelope for both, matching kap-server's `middleware/auth.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allowed,
    Missing,
    Invalid,
}

impl Decision {
    pub fn is_allowed(self) -> bool {
        matches!(self, Self::Allowed)
    }
}

/// The credential a running server checks against.
#[derive(Clone)]
pub enum ServerAuth {
    /// A token must match. `Arc<str>` so a connection task checks without
    /// copying the secret per request.
    Token(Arc<str>),
    /// Auth turned off behind an explicit flag. Correct only on a loopback bind.
    Disabled,
}

impl ServerAuth {
    /// Read the token from `path`, or generate one, persist it, and return it.
    ///
    /// Sharing kap-server's `server.token` means an existing web UI or editor
    /// client keeps working when pointed at this server instead of kap-server.
    pub fn load_or_create(path: &std::path::Path) -> Result<Self, std::io::Error> {
        if let Ok(existing) = std::fs::read_to_string(path) {
            let token = existing.trim();
            if !token.is_empty() {
                return Ok(Self::Token(Arc::from(token)));
            }
        }

        let token = generate_token();
        // 0600 matters: this file is a credential, and the default mode would
        // leave it group-readable on POSIX.
        write_private(path, token.as_bytes())?;
        Ok(Self::Token(Arc::from(token.as_str())))
    }

    /// Where kap-server keeps its token: `<kimi home>/server.token`.
    ///
    /// The home resolution mirrors `resolveKimiHome` in agent-core-v2 —
    /// `KIMI_CODE_HOME` wins, else `~/.kimi-code` — so one file serves both
    /// servers. `config::dirs_home` is not reused: it ignores `KIMI_CODE_HOME`.
    pub fn default_token_path() -> Option<std::path::PathBuf> {
        let home = match std::env::var_os("KIMI_CODE_HOME") {
            Some(from_env) => std::path::PathBuf::from(from_env),
            None => {
                let os_home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
                std::path::PathBuf::from(os_home).join(".kimi-code")
            }
        };
        Some(home.join("server.token"))
    }

    pub fn disabled() -> Self {
        Self::Disabled
    }

    pub fn is_disabled(&self) -> bool {
        matches!(self, Self::Disabled)
    }

    /// The enforced token, if any. Used for the startup banner only.
    pub fn token(&self) -> Option<&str> {
        match self {
            Self::Token(token) => Some(token),
            Self::Disabled => None,
        }
    }

    /// Check a REST request's `Authorization` header.
    pub fn check_bearer(&self, authorization: Option<&str>) -> Decision {
        match self {
            Self::Disabled => Decision::Allowed,
            Self::Token(expected) => match bearer_value(authorization) {
                None => Decision::Missing,
                Some(presented) => {
                    if secret_matches(expected, presented) {
                        Decision::Allowed
                    } else {
                        Decision::Invalid
                    }
                }
            },
        }
    }

    /// Check a WebSocket upgrade, which may carry the token as a bearer header
    /// (non-browser clients) or as a subprotocol (browsers).
    ///
    /// The second return value is the protocol the handshake must echo back:
    /// RFC 6455 requires the server to select one of the client's offered
    /// protocols, and a browser client fails the negotiation without it.
    pub fn check_upgrade(
        &self,
        authorization: Option<&str>,
        protocols: Option<&str>,
    ) -> (Decision, Option<String>) {
        if self.is_disabled() {
            return (Decision::Allowed, selected_bearer_protocol(protocols));
        }

        // A real bearer header takes precedence; no protocol is then negotiated,
        // since the token did not arrive as one.
        if bearer_value(authorization).is_some() {
            return (self.check_bearer(authorization), None);
        }

        match (self, offered_bearer_protocol(protocols)) {
            (Self::Disabled, protocol) => (Decision::Allowed, protocol),
            (Self::Token(expected), Some(protocol)) => {
                let token = protocol.trim_start_matches(WS_BEARER_PREFIX);
                let decision = if secret_matches(expected, token) {
                    Decision::Allowed
                } else {
                    Decision::Invalid
                };
                // Echo only what we accepted; a refusal must not negotiate.
                (decision, decision.is_allowed().then_some(protocol))
            }
            (Self::Token(_), None) => (Decision::Missing, None),
        }
    }

    /// Paths reachable without a credential.
    pub fn is_bypassed(method: &str, path: &str) -> bool {
        if method.eq_ignore_ascii_case("OPTIONS") {
            return true;
        }
        let method = method.to_ascii_uppercase();
        (method == "GET"
            && matches!(
                path,
                "/api/v1/healthz" | "/api/v1/health" | "/health"
            ))
            || path == "/openapi.json"
            || path == "/asyncapi.json"
    }
}

/// Pull the token out of a `Bearer <token>` header value.
fn bearer_value(header: Option<&str>) -> Option<&str> {
    let token = header?.trim().strip_prefix(BEARER_PREFIX)?;
    (!token.is_empty()).then_some(token)
}

fn protocol_entries(header: Option<&str>) -> impl Iterator<Item = &str> {
    header
        .into_iter()
        .flat_map(|value| value.split(','))
        .map(str::trim)
}

/// The first offered `kimi-code.bearer.*` protocol, verbatim, for echoing.
fn selected_bearer_protocol(header: Option<&str>) -> Option<String> {
    protocol_entries(header)
        .find(|entry| entry.starts_with(WS_BEARER_PREFIX))
        .map(str::to_string)
}

/// As above, but only when it actually carries a token.
fn offered_bearer_protocol(header: Option<&str>) -> Option<String> {
    protocol_entries(header)
        .filter(|entry| entry.starts_with(WS_BEARER_PREFIX))
        .filter(|entry| entry.len() > WS_BEARER_PREFIX.len())
        .map(str::to_string)
        .next()
}

/// Compare two secrets without short-circuiting on the first differing byte.
///
/// A length mismatch returns early; that reveals only the token length, which
/// this server always generates at 43 chars.
fn secret_matches(expected: &str, presented: &str) -> bool {
    let (want, got) = (expected.as_bytes(), presented.as_bytes());
    if want.len() != got.len() {
        return false;
    }
    want.iter()
        .zip(got.iter())
        .fold(0_u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

fn generate_token() -> String {
    let mut bytes = [0_u8; TOKEN_BYTES];
    for chunk in bytes.chunks_mut(8) {
        let random = fastrand::u64(..).to_le_bytes();
        chunk.copy_from_slice(&random[..chunk.len()]);
    }
    BASE64_URL_SAFE_NO_PAD.encode(bytes)
}

fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    use std::io::Write;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::File::create(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    {
        // No POSIX mode bits to set: the file inherits the directory's ACL,
        // which is why a non-loopback bind still needs an explicit opt-in.
    }
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc as StdArc;

    fn auth(token: &str) -> ServerAuth {
        ServerAuth::Token(StdArc::from(token))
    }

    fn temp_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("kimi-auth-{}", fastrand::u32(..)))
    }

    #[test]
    fn a_matching_bearer_is_accepted_and_the_rest_are_refusals() {
        let server = auth("tok3n");
        assert!(server.check_bearer(Some("Bearer tok3n")).is_allowed());
        assert_eq!(server.check_bearer(None), Decision::Missing);
        assert_eq!(server.check_bearer(Some("Basic tok3n")), Decision::Missing);
        assert_eq!(server.check_bearer(Some("Bearer ")), Decision::Missing);
        assert_eq!(server.check_bearer(Some("Bearer nope")), Decision::Invalid);
        // Trailing whitespace is tolerated on the value, the way a hand-typed
        // header deserves to be.
        assert!(server.check_bearer(Some("Bearer tok3n  ")).is_allowed());
    }

    #[test]
    fn disabled_mode_allows_everything_it_is_asked_about() {
        let server = ServerAuth::disabled();
        assert!(server.check_bearer(None).is_allowed());
        assert!(server.check_upgrade(None, None).0.is_allowed());
        assert_eq!(server.token(), None);
    }

    #[test]
    fn a_browser_token_in_the_subprotocol_is_accepted_and_echoed() {
        let server = auth("tok3n");
        let (decision, protocol) =
            server.check_upgrade(None, Some("chrome-v1, kimi-code.bearer.tok3n"));
        assert!(decision.is_allowed());
        assert_eq!(
            protocol.as_deref(),
            Some("kimi-code.bearer.tok3n"),
            "the selected protocol must be echoed or the browser aborts"
        );
    }

    #[test]
    fn a_wrong_subprotocol_token_is_refused_without_being_echoed() {
        let server = auth("tok3n");
        let (decision, protocol) = server.check_upgrade(None, Some("kimi-code.bearer.wrong"));
        assert_eq!(decision, Decision::Invalid);
        assert_eq!(protocol, None);
    }

    #[test]
    fn an_empty_bearer_subprotocol_is_not_a_credential() {
        let server = auth("tok3n");
        assert_eq!(
            server.check_upgrade(None, Some("kimi-code.bearer.")).0,
            Decision::Missing
        );
    }

    #[test]
    fn a_bearer_header_wins_over_a_subprotocol_and_negotiates_no_protocol() {
        let server = auth("tok3n");
        let (decision, protocol) =
            server.check_upgrade(Some("Bearer tok3n"), Some("kimi-code.bearer.evil"));
        assert!(decision.is_allowed());
        assert_eq!(protocol, None);
    }

    #[test]
    fn health_and_schemas_need_no_credential_but_state_routes_do() {
        assert!(ServerAuth::is_bypassed("GET", "/api/v1/healthz"));
        assert!(ServerAuth::is_bypassed("GET", "/api/v1/health"));
        assert!(ServerAuth::is_bypassed("GET", "/openapi.json"));
        assert!(ServerAuth::is_bypassed("OPTIONS", "/api/v1/sessions"));
        assert!(!ServerAuth::is_bypassed("GET", "/api/v1/sessions"));
        assert!(!ServerAuth::is_bypassed("POST", "/api/v1/sessions/s1/prompt"));
        assert!(!ServerAuth::is_bypassed("GET", "/api/v1/ws"));
        assert!(!ServerAuth::is_bypassed("POST", "/health"));
    }

    #[test]
    fn secret_comparison_is_length_then_value_exact() {
        assert!(secret_matches("abc", "abc"));
        assert!(!secret_matches("abc", "ab"));
        assert!(!secret_matches("abc", "abd"));
        assert!(!secret_matches("abc", ""));
    }

    #[test]
    fn generated_tokens_match_kap_server_shape_and_are_unique() {
        let first = generate_token();
        let second = generate_token();
        assert_eq!(first.len(), 43, "base64url(32 bytes): {first}");
        assert!(
            first
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "must be url-safe: {first}"
        );
        assert_ne!(first, second);
    }

    #[test]
    fn load_or_create_persists_a_token_and_reuses_it() {
        let dir = temp_dir();
        let path = dir.join("server.token");

        let created = ServerAuth::load_or_create(&path).expect("creates");
        let token = created.token().expect("generated token").to_string();
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), token);

        let loaded = ServerAuth::load_or_create(&path).expect("reads back");
        assert_eq!(loaded.token(), Some(token.as_str()), "must not re-roll");
        assert!(
            loaded.check_bearer(Some(&format!("Bearer {token}")))
                .is_allowed()
        );

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_blank_token_file_is_replaced_rather_than_adopted() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("server.token");
        std::fs::write(&path, "   \n").unwrap();

        let loaded = ServerAuth::load_or_create(&path).unwrap();
        assert!(!loaded.token().unwrap_or_default().is_empty());

        std::fs::remove_dir_all(dir).ok();
    }
}
