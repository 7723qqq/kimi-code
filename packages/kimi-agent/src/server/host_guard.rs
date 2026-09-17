//! The DNS-rebinding guard: which `Host` values this server answers to.
//!
//! A browser sends the `Host` of the URL it was told to load, so a page served
//! from `evil.example` that resolves to this server's address arrives with
//! `Host: evil.example` — and, being same-origin from the browser's point of
//! view, can read every response the bearer token would otherwise gate. The
//! credential cannot stop that: the browser attaches it for the attacker.
//! Comparing the header against the addresses this server is actually
//! reachable at does stop it.
//!
//! Ports are ignored. `Host: 127.0.0.1:58627` and `Host: 127.0.0.1` name the
//! same host, and the port is already pinned by the socket the request arrived
//! on.

use std::net::IpAddr;

/// The `Host` values a server accepts, beyond the ones every bind allows.
#[derive(Debug, Clone, Default)]
pub struct HostGuard {
    /// The host the listener was bound to, as given to `--serve`.
    bind_host: String,
    /// Extra values from `--allowed-host` / `KIMI_CODE_ALLOWED_HOSTS`.
    extra: Vec<String>,
}

impl HostGuard {
    pub fn new(bind_host: impl Into<String>, extra: Vec<String>) -> Self {
        Self {
            bind_host: bind_host.into(),
            extra,
        }
    }

    /// Whether a request carrying this `Host` header may be answered.
    ///
    /// A missing or empty header is refused: HTTP/1.1 requires `Host`, so its
    /// absence means the request was not built by a client that meant to reach
    /// this server.
    pub fn allows(&self, host: Option<&str>) -> bool {
        let Some(host) = host.filter(|value| !value.is_empty()) else {
            return false;
        };
        let host = strip_port(host);

        if matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1" | "[::1]") {
            return true;
        }
        // `*.localhost` is reserved for loopback by RFC 6761, so it resolves to
        // this machine by definition.
        if host.ends_with(".localhost") {
            return true;
        }
        // An IP literal is an address the caller had to know; a rebinding
        // attack arrives under a *name*, so this cannot be one. Brackets are
        // stripped first, so `[fe80::1]` counts as the literal it is.
        let bare = host
            .strip_prefix('[')
            .and_then(|inner| inner.strip_suffix(']'))
            .unwrap_or(&host);
        if bare.parse::<IpAddr>().is_ok() {
            return true;
        }
        if host == strip_port(&self.bind_host) {
            return true;
        }
        self.extra.iter().any(|entry| {
            let entry = strip_port(entry);
            match entry.strip_prefix('.') {
                // A leading dot is a domain suffix: the domain itself and any
                // subdomain of it.
                Some(base) => host == base || host.ends_with(&entry),
                None => host == entry,
            }
        })
    }
}

/// Split a `--allowed-host` / `KIMI_CODE_ALLOWED_HOSTS` value on commas,
/// dropping empty entries so a trailing comma is not an error.
pub fn split_allowed_hosts(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect()
}

/// Strip the port from a `Host` header value, lowercasing it. IPv6 brackets
/// are kept, so `[::1]:8080` becomes `[::1]` and a bare `::1` stays `::1`.
pub fn strip_port(host: &str) -> String {
    if host.starts_with('[') {
        let end = host.find(']').map_or(host.len(), |index| index + 1);
        return host[..end].to_ascii_lowercase();
    }
    let Some(first) = host.find(':') else {
        return host.to_ascii_lowercase();
    };
    // A second colon means this is a bare IPv6 address, not `host:port`.
    if host.rfind(':') == Some(first) {
        let port = &host[first + 1..];
        if !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()) {
            return host[..first].to_ascii_lowercase();
        }
    }
    host.to_ascii_lowercase()
}

/// The 403 body for a rejected `Host`, naming both ways to allow it.
pub fn rejection_message(host: Option<&str>) -> String {
    let normalized = host.filter(|value| !value.is_empty()).map(strip_port);
    let label = normalized
        .clone()
        .unwrap_or_else(|| "<missing>".to_string());
    let argument = normalized.unwrap_or_else(|| "<host>".to_string());
    format!(
        "Invalid Host header: {label}; allow this host with KIMI_CODE_ALLOWED_HOSTS={argument} \
         or 'kimi web --allowed-host {argument}'."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_port_keeps_ipv6_brackets_and_drops_the_port() {
        assert_eq!(strip_port("example.com:8080"), "example.com");
        assert_eq!(strip_port("example.com"), "example.com");
        assert_eq!(strip_port("EXAMPLE.com"), "example.com");
        assert_eq!(strip_port("[::1]:8080"), "[::1]");
        assert_eq!(strip_port("[::1]"), "[::1]");
        assert_eq!(strip_port("::1"), "::1");
        assert_eq!(strip_port("fe80::1"), "fe80::1");
    }

    #[test]
    fn loopback_names_and_ip_literals_are_allowed() {
        let guard = HostGuard::new("127.0.0.1", Vec::new());
        for host in [
            "127.0.0.1",
            "127.0.0.1:58627",
            "localhost",
            "localhost:58627",
            "LOCALHOST",
            "::1",
            "[::1]:58627",
            "app.localhost",
            "192.168.1.5:58627",
            "[fe80::1]:58627",
        ] {
            assert!(guard.allows(Some(host)), "{host} should be allowed");
        }
    }

    #[test]
    fn a_name_that_is_not_the_bind_host_is_refused() {
        let guard = HostGuard::new("127.0.0.1", Vec::new());
        assert!(!guard.allows(Some("evil.example")));
        assert!(!guard.allows(Some("evil.example:58627")));
        assert!(!guard.allows(Some("127.0.0.1.evil.example")));
        assert!(!guard.allows(None));
        assert!(!guard.allows(Some("")));
    }

    #[test]
    fn the_bind_host_is_allowed_even_when_it_is_not_loopback() {
        let guard = HostGuard::new("kimi.internal:58627", Vec::new());
        assert!(guard.allows(Some("kimi.internal")));
        assert!(guard.allows(Some("kimi.internal:58627")));
        assert!(!guard.allows(Some("other.internal")));
    }

    #[test]
    fn extra_hosts_match_exactly_or_as_a_domain_suffix() {
        let guard = HostGuard::new(
            "127.0.0.1",
            vec!["kimi.example".to_string(), ".corp.example".to_string()],
        );
        assert!(guard.allows(Some("kimi.example")));
        assert!(guard.allows(Some("kimi.example:58627")));
        assert!(!guard.allows(Some("sub.kimi.example")));
        assert!(guard.allows(Some("corp.example")));
        assert!(guard.allows(Some("a.b.corp.example")));
        assert!(!guard.allows(Some("notcorp.example")));
    }

    #[test]
    fn split_allowed_hosts_trims_and_drops_empties() {
        assert_eq!(
            split_allowed_hosts("a.example, b.example ,,c.example,"),
            vec!["a.example", "b.example", "c.example"]
        );
        assert!(split_allowed_hosts("").is_empty());
    }

    #[test]
    fn the_rejection_message_names_both_ways_to_allow_the_host() {
        let message = rejection_message(Some("evil.example:58627"));
        assert!(message.contains("evil.example"), "{message}");
        assert!(!message.contains("58627"), "{message}");
        assert!(
            message.contains("KIMI_CODE_ALLOWED_HOSTS=evil.example"),
            "{message}"
        );
        assert!(message.contains("--allowed-host evil.example"), "{message}");

        let missing = rejection_message(None);
        assert!(missing.contains("<missing>"), "{missing}");
        assert!(missing.contains("--allowed-host <host>"), "{missing}");
    }
}
