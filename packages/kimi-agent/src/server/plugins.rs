//! Plugin catalog, marketplace, and state management for the native HTTP server.
//!
//! Mirrors kap-server's `IPluginService` and `/api/v1/plugins` REST surface.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::session::sqlite_store::SqliteSessionStore;

/// Entry shape for `/api/v1/plugins/marketplace`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMarketplaceEntry {
    pub id: String,
    pub tier: String,
    pub display_name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keywords: Option<Vec<String>>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed: Option<InstalledPluginInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPluginInfo {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Local root of a plugin that is not in the catalog. Recorded at install
    /// time because nothing else can map its id back to the directory the user
    /// pointed at, and a plugin that cannot be located contributes nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// When the plugin was first installed, RFC 3339 (v2 `PluginRecord.installedAt`).
    /// `None` for a record written before this field existed — the panel treats
    /// that as "unknown" and omits the line, which is the truth for such a
    /// record: the moment was simply not written down.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_at: Option<String>,
    /// The `source` the install was asked for, before it was resolved to a
    /// managed root (v2 `PluginRecord.originalSource`) — so a plugin that was
    /// pointed at a local directory still shows where it came from after the
    /// copy moved it under `<home>/plugins/<id>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_source: Option<String>,
    /// When the plugin content was last (re)installed, RFC 3339. v2 stamps it
    /// on **every** install and keeps `installedAt` from the first one
    /// (`manager.ts:140-141`), so a re-install reads as an update; this engine
    /// has no separate update flow, which makes a re-install the only such
    /// event. Absent for a record written before the field existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// Entry shape for `/api/v1/plugins`. Carries the same live state and
/// contribution counts as `PluginInfo`: consumers render the installed list
/// from these (state badge, skill / MCP / command counts), and leaving them
/// absent made every count read as `undefined` and the state blank.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub description: String,
    pub source: PluginSourceKind,
    /// The install source as it was given, before it was resolved to a managed
    /// root. Carried here as well as on [`PluginInfo`] because the list view's
    /// provenance label and trust badge are both computed from the pair
    /// (`formatPluginSourceLabel` / `pluginTrustLabel` read `source` **and**
    /// `originalSource`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_source: Option<String>,
    /// Present when `source` is [`PluginSourceKind::Github`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github: Option<PluginGithubMetadata>,
    pub state: String,
    pub skill_count: usize,
    pub mcp_server_count: usize,
    pub enabled_mcp_server_count: usize,
    pub command_count: usize,
    pub hook_count: usize,
    pub has_errors: bool,
}

/// Where a plugin came from, as a kind rather than as the string that was typed:
/// v2's `PluginSource` (`app/plugin/types.ts:96`). The host renders a
/// provenance label and decides a trust badge from this value, so it has to be
/// the vocabulary — a raw URL or path here compares equal to nothing, and every
/// such comparison silently takes the "unknown" branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginSourceKind {
    LocalPath,
    ZipUrl,
    Github,
}

/// A git reference kind (v2 `PluginGithubRef['kind']`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginGithubRefKind {
    Branch,
    Tag,
    Sha,
}

/// One git reference (v2 `PluginGithubRef`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginGithubRef {
    pub kind: PluginGithubRefKind,
    pub value: String,
}

/// A GitHub-hosted plugin's provenance (v2 `PluginGithubMetadata`). `installedSha`
/// is absent: the fork records no install-time commit, so a value there would be
/// invented, and every consumer treats its absence as "cannot compare against
/// upstream" rather than "matches".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginGithubMetadata {
    pub owner: String,
    pub repo: String,
    /// Always present (v2 requires it). A repository URL that named no ref is
    /// recorded as `branch` / `HEAD`, which is v2's own spelling for "no explicit
    /// pin" — `explicitGithubRef` drops a `HEAD` branch before comparing
    /// (`manager.ts:498`). v2 would have resolved the latest release tag over the
    /// network first; this engine has no resolver, and inventing a network call
    /// inside a plugin-list read is not an alignment change.
    #[serde(rename = "ref")]
    pub ref_: PluginGithubRef,
}

/// An install source classified the way v2's `resolveInstallSource` does
/// (`app/plugin/source.ts:19-36`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPluginSource {
    pub kind: PluginSourceKind,
    /// The URL or path as given.
    pub source: String,
    /// Set only for [`PluginSourceKind::Github`].
    pub github: Option<PluginGithubMetadata>,
}

/// Classify an install source into the v2 vocabulary.
///
/// One deliberate difference from v2: v2 *throws* for a relative path
/// (`source.ts:28-34`), because its catalogs carry absolute paths. The fork's
/// catalogs carry marketplace-relative paths (`"./official/demo"`, see
/// `resolve_plugin_root`), which are already resolved against the marketplace
/// directory by the time a record exists — so a non-URL is reported as
/// `local-path`, which is the same answer v2 gives the absolute path it resolves
/// to.
pub fn classify_plugin_source(source: &str) -> ResolvedPluginSource {
    let trimmed = source.trim();
    let github = parse_github_url(trimmed);
    if let Some(metadata) = github {
        return ResolvedPluginSource {
            kind: PluginSourceKind::Github,
            source: trimmed.to_string(),
            github: Some(metadata),
        };
    }
    let kind = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        PluginSourceKind::ZipUrl
    } else {
        PluginSourceKind::LocalPath
    };
    ResolvedPluginSource {
        kind,
        source: trimmed.to_string(),
        github: None,
    }
}

/// A 7–40 character lowercase hex string is a commit, not a branch (v2
/// `SHA_RE`, `source.ts:17`).
fn looks_like_sha(value: &str) -> bool {
    (7..=40).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// v2 `parseGithubUrl` (`source.ts:38-80`): `https` on `github.com` (or
/// `www.`), `<owner>/<repo>` with an optional `.git`, then one of
/// `tree/<ref>` / `releases/tag/<tag>` / `commit/<sha>`. `None` for anything
/// else, including a github URL with a trailing path that names no ref — v2
/// treats those as not-a-github-source rather than guessing.
fn parse_github_url(raw: &str) -> Option<PluginGithubMetadata> {
    let rest = raw.strip_prefix("https://")?;
    let (authority, path) = rest.split_once('/')?;
    let authority = authority.split('@').next().unwrap_or(authority);
    let authority = authority.split(':').next().unwrap_or(authority);
    if authority != "github.com" && authority != "www.github.com" {
        return None;
    }
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let owner = segments.first()?;
    let repo_raw = segments.get(1)?;
    let repo = repo_raw
        .strip_suffix(".git")
        .unwrap_or(repo_raw)
        .to_string();
    if repo.is_empty() {
        return None;
    }
    let tail = &segments[2.min(segments.len())..];
    let percent_decode = |value: &str| percent_decode(value).unwrap_or_else(|| value.to_string());
    let git_ref = match tail {
        [] => PluginGithubRef {
            kind: PluginGithubRefKind::Branch,
            value: "HEAD".to_string(),
        },
        [head, rest @ ..] if *head == "tree" && !rest.is_empty() => {
            let value = percent_decode(&rest.join("/"));
            PluginGithubRef {
                kind: if looks_like_sha(&value) {
                    PluginGithubRefKind::Sha
                } else {
                    PluginGithubRefKind::Branch
                },
                value,
            }
        }
        [head, second, rest @ ..]
            if *head == "releases" && *second == "tag" && !rest.is_empty() =>
        {
            PluginGithubRef {
                kind: PluginGithubRefKind::Tag,
                value: percent_decode(&rest.join("/")),
            }
        }
        [head, rest @ ..] if *head == "commit" && !rest.is_empty() => PluginGithubRef {
            kind: PluginGithubRefKind::Sha,
            value: percent_decode(&rest.join("/")),
        },
        _ => return None,
    };
    Some(PluginGithubMetadata {
        owner: (*owner).to_string(),
        repo,
        ref_: git_ref,
    })
}

/// Minimal percent-decoding for a URL path segment list: v2's
/// `decodeRefSegments` runs `decodeURIComponent` per segment and keeps the raw
/// segment when that throws, so a stray `%` cannot fail a plugin's provenance.
fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
            match u8::from_str_radix(hex, 16) {
                Ok(byte) => {
                    out.push(byte);
                    index += 3;
                    continue;
                }
                Err(_) => return None,
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).ok()
}

/// Fallback embedded marketplace if filesystem cannot find marketplace.json.
const EMBEDDED_MARKETPLACE_JSON: &str = r#"{
  "version": "1",
  "plugins": [
    {
      "id": "kimi-datasource",
      "tier": "official",
      "displayName": "Kimi Datasource",
      "version": "3.4.0",
      "description": "Stocks and financials from Wind, S&P Capital IQ, SEC EDGAR, etc.; news from Caixin, Xinhua Finance; macro from World Bank, IMF, NBS; corporate, academic, legal data, and more",
      "keywords": ["data", "mcp"],
      "source": "./official/kimi-datasource"
    },
    {
      "id": "kimi-webbridge",
      "tier": "official",
      "displayName": "Kimi WebBridge",
      "version": "1.11.3",
      "description": "Control your real browser from Kimi Code.",
      "keywords": ["browser", "automation", "webbridge"],
      "source": "./official/kimi-webbridge"
    },
    {
      "id": "superpowers",
      "tier": "curated",
      "displayName": "Superpowers",
      "description": "Planning, TDD, debugging, and delivery workflows for coding agents.",
      "homepage": "https://github.com/obra/superpowers",
      "keywords": ["skills", "planning", "tdd", "debugging", "code-review"],
      "source": "https://github.com/obra/superpowers"
    }
  ]
}"#;

/// One `commands[]` entry of `kimi.plugin.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginCommandEntry {
    pub path: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// One plugin's manifest, as the engine reads it. The field set is v2's
/// `PluginManifest` (`app/plugin/types.ts:34-52`) minus `systemPrompt` /
/// `systemPromptPath`, which this engine never reads — a manifest written for a
/// newer host still loads, and an unread field simply stays absent.
///
/// `skills` and `agents` are **resolved**: absolute, real, and proven to sit
/// inside the plugin root (v2 `resolveDirListField`,
/// `app/plugin/manifest.ts:161-212`). A raw `Value` is kept in
/// [`RawPluginManifest`] because the string-or-list distinction only exists
/// before that pass.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub keywords: Option<Vec<String>>,
    #[serde(default)]
    pub author: Option<PluginAuthorWire>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    /// Absolute, contained skill roots. Empty when the manifest declares none:
    /// a plugin that ships a root-level `SKILL.md` instead of a `skills`
    /// directory contributes nothing here, which is §6.36's recorded residual
    /// (v2's `rootSkillFallback` / `scanMode: 'root-skill-only'` has no fork
    /// counterpart, and resolving it needs a scan-mode concept the shared
    /// scanner does not have).
    #[serde(default)]
    pub skills: Option<Vec<String>>,
    /// Absolute, contained agent roots, defaulted to `<root>/agents` when the
    /// manifest declares none and the directory exists (v2 `manifest.ts:113-116`).
    #[serde(default)]
    pub agents: Option<Vec<String>>,
    #[serde(default)]
    pub session_start: Option<PluginSessionStartWire>,
    /// Free text the plugin wants prefixed onto every skill it contributes (v2
    /// `record.skillInstructions`, `app/plugin/manager.ts:614`), rendered as
    /// `<plugin-instructions plugin="id">`.
    #[serde(default)]
    pub skill_instructions: Option<String>,
    #[serde(default)]
    pub mcp_servers: Option<Value>,
    #[serde(default)]
    pub commands: Option<Vec<PluginCommandEntry>>,
    #[serde(default)]
    pub hooks: Option<Vec<Value>>,
    #[serde(default)]
    pub interface: Option<PluginInterfaceWire>,
}

/// A manifest exactly as written, before the pass that resolves and vets the
/// paths. Only the readers in this module consume it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPluginManifest {
    #[serde(default)]
    name: Option<Value>,
    #[serde(default)]
    version: Option<Value>,
    #[serde(default)]
    description: Option<Value>,
    #[serde(default)]
    keywords: Option<Value>,
    #[serde(default)]
    author: Option<Value>,
    #[serde(default)]
    homepage: Option<Value>,
    #[serde(default)]
    license: Option<Value>,
    #[serde(default)]
    skills: Option<Value>,
    #[serde(default)]
    agents: Option<Value>,
    #[serde(default)]
    session_start: Option<Value>,
    #[serde(default)]
    skill_instructions: Option<Value>,
    #[serde(default)]
    mcp_servers: Option<Value>,
    #[serde(default)]
    commands: Option<Vec<PluginCommandEntry>>,
    #[serde(default)]
    hooks: Option<Vec<Value>>,
    #[serde(default)]
    interface: Option<Value>,
}

/// A manifest's author: v2 accepts a bare string as shorthand for `{ name }`
/// (`readAuthor`, `manifest.ts:511-518`), and the bundled plugins use that form.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAuthorWire {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

/// The skill a plugin runs when a session starts (v2 `PluginSessionStart`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSessionStartWire {
    pub skill: String,
}

/// A plugin's marketplace-facing metadata (v2 `PluginInterface`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInterfaceWire {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short_description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub long_description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub developer_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub website_url: Option<String>,
}

/// One thing worth telling the user about a plugin (v2 `PluginDiagnostic`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiagnostic {
    /// `"error"` or `"warn"`. v2's `PluginDiagnosticSeverity` has no third
    /// value, so the wire stays a plain string rather than a closed enum the
    /// host would have to widen.
    pub severity: String,
    pub message: String,
}

/// One manifest parse (v2 `ParsedManifestResult`, `manifest.ts:30-36`).
#[derive(Debug, Clone, Default)]
pub struct ParsedPluginManifest {
    pub manifest: Option<PluginManifest>,
    /// `"kimi-plugin-root"` or `"kimi-plugin-dir"` — which of the two accepted
    /// locations answered.
    pub manifest_kind: Option<String>,
    pub manifest_path: Option<String>,
    /// The other location, when both exist. Reported rather than silently
    /// ignored, because a plugin author who edits the shadowed file sees no
    /// effect and would otherwise have no way to tell.
    pub shadowed_manifest_path: Option<String>,
    pub diagnostics: Vec<PluginDiagnostic>,
}

/// One plugin-contributed slash command — the wire the host renders as
/// `/pluginId:name`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommandDef {
    pub plugin_id: String,
    pub name: String,
    pub description: String,
    pub body: String,
    pub path: String,
}

/// One plugin-contributed MCP server, the wire `PluginInfo.mcpServers` carries.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpServerInfo {
    pub name: String,
    pub transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub enabled: bool,
}

/// One enabled plugin's MCP server, ready for the engine's MCP manager. `name`
/// is namespaced `<pluginId>__<server>` so two plugins can declare the same
/// server name without colliding.
#[derive(Debug, Clone)]
pub struct PluginMcpConfig {
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cwd: Option<String>,
    pub url: Option<String>,
    pub headers: HashMap<String, String>,
}

/// Full plugin detail for `getPluginInfo`: the catalog entry, the install
/// state, and everything the manifest contributes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub enabled: bool,
    pub state: String,
    /// The v2 source vocabulary, not the string that was typed — see
    /// [`PluginSourceKind`].
    pub source: PluginSourceKind,
    /// Present when `source` is [`PluginSourceKind::Github`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github: Option<PluginGithubMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// When the plugin was first installed, RFC 3339. Absent for a record
    /// written before the field existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_at: Option<String>,
    /// The `source` the install was asked for, before it was resolved to a
    /// managed root. Absent for a record written before the field existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_source: Option<String>,
    /// When the plugin content was last (re)installed. Absent for a record
    /// written before the field existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_path: Option<String>,
    /// Which of the two accepted manifest locations answered:
    /// `"kimi-plugin-root"` or `"kimi-plugin-dir"` (v2 `PluginManifestKind`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_kind: Option<String>,
    /// The manifest itself, with its path lists resolved (v2 `PluginInfo.manifest`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<PluginManifest>,
    /// The other manifest location, when the plugin has both. Without this the
    /// author of the shadowed file gets no signal that their edits do nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadowed_manifest_path: Option<String>,
    /// What the parse found worth reporting: a manifest that is missing,
    /// unreadable, or declares a path that is not a usable directory inside the
    /// plugin. Carried on the info rather than only logged, because the plugin
    /// list is where a user goes to find out why a plugin contributes nothing.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<PluginDiagnostic>,
    pub commands: Vec<PluginCommandDef>,
    pub mcp_servers: Vec<PluginMcpServerInfo>,
    pub skill_count: usize,
    pub mcp_server_count: usize,
    pub enabled_mcp_server_count: usize,
    pub command_count: usize,
    pub hook_count: usize,
    pub has_errors: bool,
}

/// The directory holding `marketplace.json`, so a relative catalog `source`
/// resolves to a real plugin root. `None` when the catalog is not on disk —
/// the embedded fallback has no roots to resolve.
pub fn default_marketplace_dir() -> Option<PathBuf> {
    let dir = PathBuf::from("plugins");
    dir.join("marketplace.json").is_file().then_some(dir)
}

/// Whether a catalog `source` or an install argument names a remote archive
/// rather than a local plugin root.
fn is_remote_source(source: &str) -> bool {
    source.starts_with("http://") || source.starts_with("https://")
}

/// Resolve a catalog `source` to a local plugin root. `None` for a remote
/// source (a URL) or a path that does not exist: those plugins have no local
/// content to read.
pub fn resolve_plugin_root(source: &str, marketplace_dir: Option<&Path>) -> Option<PathBuf> {
    if is_remote_source(source) {
        return None;
    }
    let path = Path::new(source);
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        marketplace_dir?.join(source.trim_start_matches("./"))
    };
    candidate.is_dir().then_some(candidate)
}

/// The current instant as RFC 3339, the format v2's `installedAt` /
/// `updatedAt` use. Second precision with milliseconds, matching the rest of the
/// engine's timestamps.
fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Whether `id` is usable as a single directory name under the managed plugin
/// root. A manifest-supplied `name` reaches here, so anything that could point
/// the resulting path at another directory — separators, drive prefixes, `..`,
/// or an empty string — is refused.
fn is_safe_plugin_id(id: &str) -> bool {
    if id.is_empty() || id == "." || id == ".." {
        return false;
    }
    if id.contains(['/', '\\']) || id.contains(':') {
        return false;
    }
    let mut components = Path::new(id).components();
    matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none()
}

/// The two manifest locations v2 accepts, the root one first
/// (`app/plugin/manifest.ts:16-17`). The root form wins when both are present.
/// The names are also what the "no manifest" diagnostic quotes, so they are
/// literals; the paths themselves are joined segment by segment so a Windows
/// path never comes out with mixed separators.
const PLUGIN_MANIFEST_ROOT_PATH: &str = "kimi.plugin.json";
const PLUGIN_MANIFEST_DIR_PATH: &str = ".kimi-plugin/plugin.json";
const PLUGIN_MANIFEST_DIR_DIR: &str = ".kimi-plugin";
const PLUGIN_MANIFEST_DIR_FILE: &str = "plugin.json";

/// Read and resolve a plugin's manifest (v2 `parseManifest`,
/// `app/plugin/manifest.ts:38-57` for the location choice). The paths it
/// returns are absolute, and a path that escapes the plugin root is dropped
/// with a diagnostic rather than followed.
pub fn parse_plugin_manifest(root: &Path) -> ParsedPluginManifest {
    let root_json = root.join(PLUGIN_MANIFEST_ROOT_PATH);
    let dir_json = root
        .join(PLUGIN_MANIFEST_DIR_DIR)
        .join(PLUGIN_MANIFEST_DIR_FILE);
    let root_exists = root_json.is_file();
    let dir_exists = dir_json.is_file();
    if !root_exists && !dir_exists {
        return ParsedPluginManifest {
            diagnostics: vec![PluginDiagnostic {
                severity: "error".into(),
                message: format!(
                    "No manifest at {PLUGIN_MANIFEST_ROOT_PATH} or {PLUGIN_MANIFEST_DIR_PATH}"
                ),
            }],
            ..Default::default()
        };
    }
    let manifest_path = if root_exists { &root_json } else { &dir_json };
    let manifest_kind = if root_exists {
        "kimi-plugin-root"
    } else {
        "kimi-plugin-dir"
    };
    let shadowed_manifest_path = (root_exists && dir_exists).then_some(dir_json.clone());

    let mut parsed = ParsedPluginManifest {
        manifest_kind: Some(manifest_kind.to_string()),
        manifest_path: Some(manifest_path.to_string_lossy().into_owned()),
        shadowed_manifest_path: shadowed_manifest_path
            .map(|path| path.to_string_lossy().into_owned()),
        ..Default::default()
    };

    let raw_text = match std::fs::read_to_string(manifest_path) {
        Ok(text) => text,
        Err(error) => {
            parsed.diagnostics.push(PluginDiagnostic {
                severity: "error".into(),
                message: format!(
                    "Failed to read {}: {error}",
                    manifest_path
                        .strip_prefix(root)
                        .unwrap_or(manifest_path)
                        .display()
                ),
            });
            return parsed;
        }
    };
    let raw: RawPluginManifest = match serde_json::from_str(&raw_text) {
        Ok(raw) => raw,
        Err(error) => {
            parsed.diagnostics.push(PluginDiagnostic {
                severity: "error".into(),
                message: format!(
                    "Failed to parse {}: {error}",
                    manifest_path
                        .strip_prefix(root)
                        .unwrap_or(manifest_path)
                        .display()
                ),
            });
            return parsed;
        }
    };

    let skills =
        resolve_dir_list_field(root, "skills", raw.skills.as_ref(), &mut parsed.diagnostics);
    let mut agents =
        resolve_dir_list_field(root, "agents", raw.agents.as_ref(), &mut parsed.diagnostics);
    if raw.agents.is_none() && root.join("agents").is_dir() {
        agents = vec![root.join("agents").to_string_lossy().into_owned()];
    }

    parsed.manifest = Some(PluginManifest {
        name: string_field(raw.name),
        version: string_field(raw.version),
        description: string_field(raw.description),
        keywords: string_array_field(raw.keywords),
        author: read_author(raw.author),
        homepage: string_field(raw.homepage),
        license: string_field(raw.license),
        skills: (!skills.is_empty()).then_some(skills),
        agents: (!agents.is_empty()).then_some(agents),
        session_start: read_session_start(raw.session_start, &mut parsed.diagnostics),
        skill_instructions: string_field(raw.skill_instructions),
        mcp_servers: raw.mcp_servers,
        commands: raw.commands,
        hooks: raw.hooks,
        interface: read_interface(raw.interface),
    });
    parsed
}

/// [`parse_plugin_manifest`]'s manifest alone, for the callers that only need
/// what the plugin contributes. `None` when there is no readable manifest — a
/// plugin without one contributes nothing.
pub fn read_plugin_manifest(root: &Path) -> Option<PluginManifest> {
    parse_plugin_manifest(root).manifest
}

/// Resolve a manifest path list to absolute directories inside the plugin root
/// (v2 `resolveDirListField`, `manifest.ts:161-212`).
///
/// The containment check is the load-bearing half: a manifest is third-party
/// content, so `"skills": "../../../somewhere-else"` or an absolute path must
/// not widen the scan past the plugin. Every drop is reported, because a
/// silently missing skill root is indistinguishable from a plugin that never
/// declared one.
fn resolve_dir_list_field(
    root: &Path,
    field: &str,
    raw: Option<&Value>,
    diagnostics: &mut Vec<PluginDiagnostic>,
) -> Vec<String> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    let entries: Vec<String> = match raw {
        Value::String(path) => vec![path.clone()],
        Value::Array(list) if list.iter().all(Value::is_string) => list
            .iter()
            .filter_map(|entry| entry.as_str().map(str::to_string))
            .collect(),
        _ => {
            diagnostics.push(PluginDiagnostic {
                severity: "error".into(),
                message: format!("\"{field}\" must be a string or string[]"),
            });
            return Vec::new();
        }
    };
    let real_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut resolved = Vec::new();
    for entry in entries {
        if !entry.starts_with("./") {
            diagnostics.push(PluginDiagnostic {
                severity: "error".into(),
                message: format!("\"{field}\" path must start with \"./\" (got \"{entry}\")"),
            });
            continue;
        }
        let absolute = root.join(entry.trim_start_matches("./"));
        let real = canonicalize_allowing_missing(&absolute);
        if !is_within(&real, &real_root) {
            diagnostics.push(PluginDiagnostic {
                severity: "error".into(),
                message: format!("\"{field}\" path resolves outside the plugin ({entry})"),
            });
            continue;
        }
        if !real.is_dir() {
            diagnostics.push(PluginDiagnostic {
                severity: "warn".into(),
                message: format!("\"{field}\" path is not a directory ({entry})"),
            });
            continue;
        }
        resolved.push(
            without_verbatim_prefix(&real)
                .to_string_lossy()
                .into_owned(),
        );
    }
    resolved
}

/// Canonicalize a path that may not exist, by canonicalizing its deepest existing
/// ancestor and re-appending the missing tail.
///
/// The plain fallback — use the path as written — is not equivalent, and the
/// difference is a false positive: `canonicalize(root)` expands a Windows 8.3
/// short name (`C:\Users\ADMINI~1\...`) to the long form while the un-canonicalized
/// child keeps the short one, so a perfectly ordinary `./skills/` compares as
/// "outside the plugin". Since the containment check exists to keep a manifest
/// from reaching out of its own folder, a version that cries wolf on every
/// missing directory is worse than none.
fn canonicalize_allowing_missing(path: &Path) -> PathBuf {
    if let Ok(real) = std::fs::canonicalize(path) {
        return real;
    }
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut current = path;
    loop {
        let Some(name) = current.file_name() else {
            return path.to_path_buf();
        };
        tail.push(name.to_os_string());
        let Some(parent) = current.parent() else {
            return path.to_path_buf();
        };
        if let Ok(real) = std::fs::canonicalize(parent) {
            let mut resolved = real;
            for segment in tail.iter().rev() {
                resolved.push(segment);
            }
            return resolved;
        }
        current = parent;
    }
}

/// Windows `canonicalize` answers with the `\\?\` verbatim form, which works for
/// every filesystem call and reads terribly everywhere else — it would reach
/// `PluginInfo.manifest.skills` and the plugin panel verbatim. The prefix carries
/// no information for an already-absolute path, so it is dropped for the value
/// that leaves this module; the containment checks above keep the canonical form.
fn without_verbatim_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        // A UNC path's `\\?\UNC\` prefix is not redundant the way `\\?\C:\` is:
        // leave it alone unless what follows is a drive path.
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// Whether `child` is `parent` or sits under it. Component-wise, so a sibling
/// whose name merely starts with the parent's (`/plugin-evil` beside
/// `/plugin`) is not inside it (v2 `isWithin`, `manifest.ts:552-555`).
fn is_within(child: &Path, parent: &Path) -> bool {
    let Ok(relative) = child.strip_prefix(parent) else {
        return false;
    };
    relative.as_os_str().is_empty() || !relative.starts_with("..")
}

fn string_field(raw: Option<Value>) -> Option<String> {
    raw.and_then(|value| match value {
        Value::String(text) => Some(text),
        _ => None,
    })
}

fn string_array_field(raw: Option<Value>) -> Option<Vec<String>> {
    raw.and_then(|value| match value {
        Value::Array(list) => Some(
            list.iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect(),
        ),
        _ => None,
    })
}

/// v2 `readAuthor` (`manifest.ts:511-518`): a bare string is `{ name }`.
fn read_author(raw: Option<Value>) -> Option<PluginAuthorWire> {
    match raw? {
        Value::String(name) => Some(PluginAuthorWire {
            name: Some(name),
            email: None,
        }),
        Value::Object(object) => {
            let name = object
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string);
            let email = object
                .get("email")
                .and_then(Value::as_str)
                .map(str::to_string);
            (name.is_some() || email.is_some()).then_some(PluginAuthorWire { name, email })
        }
        _ => None,
    }
}

/// v2 `readSessionStart` (`manifest.ts:245-263`).
fn read_session_start(
    raw: Option<Value>,
    diagnostics: &mut Vec<PluginDiagnostic>,
) -> Option<PluginSessionStartWire> {
    let raw = raw?;
    let Some(object) = raw.as_object() else {
        diagnostics.push(PluginDiagnostic {
            severity: "warn".into(),
            message: "\"sessionStart\" must be an object".into(),
        });
        return None;
    };
    let skill = object
        .get("skill")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if skill.is_empty() {
        diagnostics.push(PluginDiagnostic {
            severity: "warn".into(),
            message: "\"sessionStart.skill\" is required when sessionStart is present".into(),
        });
        return None;
    }
    Some(PluginSessionStartWire {
        skill: skill.to_string(),
    })
}

/// v2 `readInterface` (`manifest.ts:520-529`): string fields off the object, and
/// absent when it is not an object at all.
fn read_interface(raw: Option<Value>) -> Option<PluginInterfaceWire> {
    let object = raw?.as_object()?.clone();
    let field = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_string);
    Some(PluginInterfaceWire {
        display_name: field("displayName"),
        short_description: field("shortDescription"),
        long_description: field("longDescription"),
        developer_name: field("developerName"),
        website_url: field("websiteURL"),
    })
}

/// Parse one command markdown file into its wire. Frontmatter is the same
/// minimal `key: value` form the skill loader reads: `name` falls back to the
/// file stem, `description` to the first non-empty body line (capped at 240
/// characters).
pub fn parse_plugin_command(
    text: &str,
    command_path: &Path,
    plugin_id: &str,
    fallback_name: Option<&str>,
) -> PluginCommandDef {
    let trimmed = text.trim_start();
    let mut name = fallback_name.map(str::to_string).unwrap_or_else(|| {
        command_path
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_default()
    });
    let mut description = String::new();
    let mut body = trimmed;

    if let Some(rest) = trimmed.strip_prefix("---")
        && let Some(end_idx) = rest.find("\n---")
    {
        for line in rest[..end_idx].lines() {
            let line = line.trim();
            if let Some(val) = line.strip_prefix("name:") {
                let parsed = val.trim().trim_matches('"').trim_matches('\'');
                if !parsed.is_empty() {
                    name = parsed.to_string();
                }
            } else if let Some(val) = line.strip_prefix("description:") {
                let parsed = val.trim().trim_matches('"').trim_matches('\'');
                if !parsed.is_empty() {
                    description = parsed.to_string();
                }
            }
        }
        body = rest[end_idx + 4..].trim_start_matches(['\r', '\n']);
    }

    let body = body.trim().to_string();
    if description.is_empty() {
        description = body
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(|line| {
                if line.chars().count() > 240 {
                    let head: String = line.chars().take(239).collect();
                    format!("{head}…")
                } else {
                    line.to_string()
                }
            })
            .unwrap_or_else(|| "No description provided.".to_string());
    }

    PluginCommandDef {
        plugin_id: plugin_id.to_string(),
        name,
        description,
        body,
        path: command_path.to_string_lossy().replace('\\', "/"),
    }
}

/// Load the marketplace catalog from disk or fallback embedded definitions.
pub fn load_marketplace(repo_root: Option<&Path>) -> Vec<PluginMarketplaceEntry> {
    let mut catalog_str = String::new();
    if let Some(root) = repo_root {
        let path = root.join("plugins").join("marketplace.json");
        if let Ok(content) = std::fs::read_to_string(&path) {
            catalog_str = content;
        }
    }
    if catalog_str.is_empty()
        && let Ok(content) = std::fs::read_to_string("plugins/marketplace.json")
    {
        catalog_str = content;
    }
    if catalog_str.is_empty() {
        catalog_str = EMBEDDED_MARKETPLACE_JSON.to_string();
    }

    parse_marketplace(&catalog_str)
}

/// Load the catalog from a directory that holds `marketplace.json` directly,
/// falling back to the embedded definitions when it is absent.
pub fn load_marketplace_from(dir: &Path) -> Vec<PluginMarketplaceEntry> {
    match std::fs::read_to_string(dir.join("marketplace.json")) {
        Ok(content) => parse_marketplace(&content),
        Err(_) => parse_marketplace(EMBEDDED_MARKETPLACE_JSON),
    }
}

fn parse_marketplace(catalog_str: &str) -> Vec<PluginMarketplaceEntry> {
    let parsed: Value =
        serde_json::from_str(catalog_str).unwrap_or_else(|_| json!({ "plugins": [] }));
    let mut entries = Vec::new();

    if let Some(list) = parsed.get("plugins").and_then(|v| v.as_array()) {
        for item in list {
            let id = match item.get("id").and_then(|v| v.as_str()) {
                Some(s) if !s.is_empty() => s.to_string(),
                _ => continue,
            };
            let tier = item
                .get("tier")
                .and_then(|v| v.as_str())
                .unwrap_or("third-party")
                .to_string();
            let display_name = item
                .get("displayName")
                .and_then(|v| v.as_str())
                .unwrap_or(&id)
                .to_string();
            let description = item
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let homepage = item
                .get("homepage")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let keywords = item.get("keywords").and_then(|v| v.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            });
            let source = item
                .get("source")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let version = item
                .get("version")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            entries.push(PluginMarketplaceEntry {
                id,
                tier,
                display_name,
                description,
                homepage,
                keywords,
                source,
                version,
                installed: None,
            });
        }
    }

    entries
}

/// Manage installed plugin states in SqliteSessionStore under `plugins/registry`,
/// and read the content an installed plugin's manifest contributes.
pub struct PluginManager {
    store: Arc<SqliteSessionStore>,
    /// Directory holding `marketplace.json`, so a relative catalog `source`
    /// resolves to a real plugin root. `None` disables root resolution.
    marketplace_dir: Option<PathBuf>,
    /// Kimi home. A remote plugin is installed under `<home>/plugins/<id>`,
    /// which then wins over the catalog `source` when resolving a root.
    home_dir: Option<PathBuf>,
    /// The host's own executable, when the host wants plugin stdio servers
    /// declared with `command: "node"` re-executed inside the host runtime
    /// (`<exe> __plugin_run_node <entry>`) instead of requiring a system
    /// Node.js. `None` leaves those servers spawning `node` as declared.
    node_runner: Option<PathBuf>,
    /// Installed ids as of the last `reload()`, so the next one can report what
    /// changed. Seeded at construction.
    known_ids: Mutex<Vec<String>>,
}

impl PluginManager {
    pub fn new(store: Arc<SqliteSessionStore>) -> Self {
        let manager = Self {
            store,
            marketplace_dir: default_marketplace_dir(),
            home_dir: None,
            node_runner: None,
            known_ids: Mutex::new(Vec::new()),
        };
        let mut ids: Vec<String> = manager.load_installed_map().into_keys().collect();
        ids.sort();
        *manager.known_ids.lock().unwrap_or_else(|p| p.into_inner()) = ids;
        manager
    }

    /// Point the manager at the catalog directory the host resolved, so a
    /// relative `source` resolves against it instead of the process cwd.
    pub fn with_marketplace_dir(mut self, dir: Option<PathBuf>) -> Self {
        self.marketplace_dir = dir;
        self
    }

    /// Point the manager at the Kimi home, so a remote plugin has somewhere to
    /// be installed (`<home>/plugins/<id>`).
    pub fn with_home_dir(mut self, dir: Option<PathBuf>) -> Self {
        self.home_dir = dir;
        self
    }

    /// Record the host executable so plugin stdio servers declared with
    /// `command: "node"` are re-executed through the host runtime instead of a
    /// system Node.js (see [`Self::plugin_mcp_configs`]).
    pub fn with_node_runner(mut self, exe: Option<PathBuf>) -> Self {
        self.node_runner = exe;
        self
    }

    /// Where a remote plugin is installed: `<home>/plugins/<id>`. `None` when
    /// there is no home, or when the id is not a single path segment — the id
    /// becomes a directory name here and a deletion target in
    /// [`Self::remove_plugin`], and a manifest is untrusted input.
    pub fn managed_root(&self, id: &str) -> Option<PathBuf> {
        let home = self.home_dir.as_deref()?;
        is_safe_plugin_id(id).then(|| home.join("plugins").join(id))
    }

    /// Load the map of installed plugin records: `id -> InstalledPluginInfo`.
    pub fn load_installed_map(&self) -> HashMap<String, InstalledPluginInfo> {
        let raw = self
            .store
            .get_state("plugins", "registry")
            .unwrap_or(None)
            .unwrap_or_else(|| json!({}));

        let mut map = HashMap::new();
        if let Some(obj) = raw.as_object() {
            for (k, v) in obj {
                if let Ok(info) = serde_json::from_value::<InstalledPluginInfo>(v.clone()) {
                    map.insert(k.clone(), info);
                }
            }
        }
        map
    }

    /// Save the map of installed plugin records.
    fn save_installed_map(
        &self,
        map: &HashMap<String, InstalledPluginInfo>,
    ) -> Result<(), rusqlite::Error> {
        let val = serde_json::to_value(map).unwrap_or_else(|_| json!({}));
        self.store.put_state("plugins", "registry", &val)
    }

    /// List all installed plugin summaries for `/api/v1/plugins`. Projected
    /// from [`Self::plugin_info`], so the list and the detail view can never
    /// disagree about a plugin's state or contribution counts.
    pub fn list_plugins(&self) -> Vec<PluginSummary> {
        let mut out: Vec<PluginSummary> = self
            .load_installed_map()
            .into_keys()
            .filter_map(|id| self.plugin_info(&id))
            .map(|info| PluginSummary {
                id: info.id,
                name: info.name,
                version: info.version,
                enabled: info.enabled,
                description: info.description,
                source: info.source,
                original_source: info.original_source,
                github: info.github,
                state: info.state,
                skill_count: info.skill_count,
                mcp_server_count: info.mcp_server_count,
                enabled_mcp_server_count: info.enabled_mcp_server_count,
                command_count: info.command_count,
                hook_count: info.hook_count,
                has_errors: info.has_errors,
            })
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    /// List marketplace entries merged with live install states for `/api/v1/plugins/marketplace`.
    pub fn list_marketplace(&self) -> Vec<PluginMarketplaceEntry> {
        let installed = self.load_installed_map();
        let mut entries = self.catalog();

        for entry in &mut entries {
            if let Some(info) = installed.get(&entry.id) {
                entry.installed = Some(info.clone());
            }
        }

        entries
    }

    /// Install a plugin by id.
    ///
    /// The id must resolve against the marketplace catalog (or already be
    /// installed — reinstalling keeps its recorded version). Returns `Ok(None)`
    /// for an unknown id so the caller can answer 404 instead of inventing an
    /// install record; the previous behaviour fabricated `enabled: true` plus a
    /// hardcoded `version: "1.0.0"` for *any* string, which made the plugin
    /// panel list plugins that were never installed.
    pub fn install_plugin(&self, id: &str) -> Result<Option<InstalledPluginInfo>, rusqlite::Error> {
        let marketplace = self.catalog();
        // The host may hand over either the catalog id or the catalog `source`
        // (the TUI resolves a path or URL before calling); the record is always
        // keyed by the catalog id, so both spellings land on one entry.
        let known = marketplace.iter().find(|m| m.id == id || m.source == id);
        let key = known
            .map(|m| m.id.clone())
            .unwrap_or_else(|| id.to_string());
        let mut installed = self.load_installed_map();
        let existing = installed.get(&key).cloned();

        if known.is_none() && existing.is_none() {
            return Ok(None);
        }

        let info = InstalledPluginInfo {
            enabled: existing.as_ref().map(|e| e.enabled).unwrap_or(true),
            version: existing
                .as_ref()
                .and_then(|e| e.version.clone())
                .or_else(|| known.and_then(|m| m.version.clone())),
            root: existing.as_ref().and_then(|e| e.root.clone()),
            // First install stamps the moment; a re-install keeps it, so
            // "installed" does not silently become "reinstalled".
            installed_at: existing
                .as_ref()
                .and_then(|e| e.installed_at.clone())
                .or_else(|| Some(now_rfc3339())),
            original_source: existing
                .as_ref()
                .and_then(|e| e.original_source.clone())
                .or_else(|| known.map(|m| m.source.clone())),
            // Every install re-stamps this while installed_at is kept, so a
            // re-install reads as an update (v2 manager.ts:140-141).
            updated_at: Some(now_rfc3339()),
        };
        installed.insert(key, info.clone());
        self.save_installed_map(&installed)?;
        Ok(Some(info))
    }

    /// Install a plugin from a catalog id, a catalog `source`, a local plugin
    /// root, or a remote archive URL. A remote source is downloaded, extracted,
    /// and copied into the managed root before the install is recorded; a local
    /// one is recorded as-is. `None` when the source resolves to nothing
    /// installable.
    ///
    /// A catalogued plugin whose `source` is a URL is remote even when it is
    /// installed by id: recording the row without fetching the archive left the
    /// plugin listed and contributing nothing.
    ///
    /// An uncatalogued local root is keyed by its manifest's own `name`, never
    /// by the path string it was handed: a path is not a plugin identity, it
    /// would list as a path-shaped id that no other call can look up, and
    /// `Path::join` with an absolute id escapes the managed root, so the
    /// install appeared to succeed while contributing nothing.
    pub fn install_plugin_from(
        &self,
        source: &str,
    ) -> Result<Option<(String, InstalledPluginInfo)>, String> {
        let trimmed = source.trim();
        let known = self
            .catalog()
            .into_iter()
            .find(|entry| entry.id == trimmed || entry.source == trimmed);

        let remote_source = if is_remote_source(trimmed) {
            Some(trimmed)
        } else {
            known
                .as_ref()
                .map(|entry| entry.source.as_str())
                .filter(|source| is_remote_source(source))
        };
        let mut local_root = None;
        let mut local_version = None;
        let id = match remote_source {
            // The catalog names the id when it knows the source; otherwise the
            // archive's own manifest does.
            Some(source) => {
                self.fetch_into_managed_root(known.as_ref().map(|entry| entry.id.as_str()), source)?
            }
            None => match &known {
                Some(entry) => entry.id.clone(),
                None => {
                    let Some(root) = resolve_plugin_root(trimmed, self.marketplace_dir.as_deref())
                    else {
                        return Ok(None);
                    };
                    let Some(manifest) = read_plugin_manifest(&root) else {
                        return Ok(None);
                    };
                    let Some(name) = manifest
                        .name
                        .as_deref()
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                    else {
                        return Err(format!(
                            "\"{trimmed}\" has no `name` in its kimi.plugin.json, so the plugin cannot be identified."
                        ));
                    };
                    local_root = Some(root.to_string_lossy().to_string());
                    local_version = manifest.version.clone();
                    name.to_string()
                }
            },
        };

        let mut installed = self.load_installed_map();
        let existing = installed.get(&id).cloned();
        let info = InstalledPluginInfo {
            enabled: existing.as_ref().map(|entry| entry.enabled).unwrap_or(true),
            version: existing
                .as_ref()
                .and_then(|entry| entry.version.clone())
                .or_else(|| known.as_ref().and_then(|entry| entry.version.clone()))
                .or(local_version),
            root: existing
                .as_ref()
                .and_then(|entry| entry.root.clone())
                .or(local_root),
            installed_at: existing
                .as_ref()
                .and_then(|entry| entry.installed_at.clone())
                .or_else(|| Some(now_rfc3339())),
            // Whatever the caller named: a catalog `source`, or the local path
            // or URL the user pointed at. This is the pre-resolution spelling,
            // which is the whole point — after the copy it is unrecognizable.
            original_source: existing
                .as_ref()
                .and_then(|entry| entry.original_source.clone())
                .or_else(|| known.map(|entry| entry.source.clone()))
                .or(Some(id.clone())),
            // Every install re-stamps this while `installed_at` is kept, so a
            // re-install reads as an update (v2 `manager.ts:140-141`).
            updated_at: Some(now_rfc3339()),
        };
        installed.insert(id.clone(), info.clone());
        self.save_installed_map(&installed)
            .map_err(|e| e.to_string())?;
        Ok(Some((id, info)))
    }

    /// Download a remote plugin archive, extract it, and copy it into the
    /// managed root. Returns the installed id: the catalog id when the source
    /// is catalogued, otherwise the archive manifest's `name`.
    fn fetch_into_managed_root(
        &self,
        catalog_id: Option<&str>,
        source: &str,
    ) -> Result<String, String> {
        use crate::server::plugin_archive as archive;

        let home = self.home_dir.as_deref().ok_or_else(|| {
            "This process has no Kimi home, so a remote plugin cannot be installed.".to_string()
        })?;
        let url = archive::archive_url_for(source);
        let bytes = archive::download_archive(&url)?;

        let staging = home.join("plugins").join(".download");
        let _ = std::fs::remove_dir_all(&staging);
        archive::extract_archive(&bytes, &staging)?;

        let root = archive::detect_plugin_root(&staging);
        let Some(manifest) = read_plugin_manifest(&root) else {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!(
                "The archive for \"{source}\" has no kimi.plugin.json at its root."
            ));
        };
        let id = match catalog_id {
            Some(id) => id.to_string(),
            None => {
                let name = manifest.name.clone().ok_or_else(|| {
                    "The archive's manifest has no `name`, so the plugin cannot be identified."
                        .to_string()
                })?;
                if !is_safe_plugin_id(name.trim()) {
                    let _ = std::fs::remove_dir_all(&staging);
                    return Err(format!(
                        "The archive's manifest names the plugin \"{name}\", which is not a usable plugin id."
                    ));
                }
                name.trim().to_string()
            }
        };

        let managed = home.join("plugins").join(&id);
        let result = archive::replace_directory(&root, &managed);
        let _ = std::fs::remove_dir_all(&staging);
        result?;
        Ok(id)
    }

    /// Enable or disable a plugin.
    ///
    /// Returns `Ok(false)` when the id is neither installed nor present in the
    /// marketplace: an unknown id must not be recorded (the old code
    /// `or_insert_with`'d a fake `version: "1.0.0"` entry for it).
    pub fn set_plugin_enabled(&self, id: &str, enabled: bool) -> Result<bool, rusqlite::Error> {
        let mut installed = self.load_installed_map();
        match installed.get_mut(id) {
            Some(current) => {
                current.enabled = enabled;
                self.save_installed_map(&installed)?;
                Ok(true)
            }
            None => {
                // Not installed yet: only a catalogued plugin may be enabled,
                // and it is recorded with the catalog's version.
                let marketplace = self.catalog();
                let Some(entry) = marketplace.iter().find(|m| m.id == id) else {
                    return Ok(false);
                };
                installed.insert(
                    id.to_string(),
                    InstalledPluginInfo {
                        enabled,
                        version: entry.version.clone(),
                        root: None,
                        // Enabling without installing still records a moment:
                        // the plugin is catalogued and its content is on disk, so
                        // "installed" is true in every way this fork can observe.
                        installed_at: Some(now_rfc3339()),
                        updated_at: Some(now_rfc3339()),
                        original_source: Some(entry.source.clone()),
                    },
                );
                self.save_installed_map(&installed)?;
                Ok(true)
            }
        }
    }

    /// Remove an installed plugin, including the managed copy a remote install
    /// left under `<home>/plugins/<id>`. Dropping only the registry row left
    /// that directory behind, and a root holding a manifest silently keeps
    /// contributing skills and MCP servers after the plugin is gone.
    pub fn remove_plugin(&self, id: &str) -> Result<bool, rusqlite::Error> {
        let mut installed = self.load_installed_map();
        let existed = installed.remove(id).is_some();
        if existed {
            self.save_installed_map(&installed)?;
            if let Some(managed) = self.managed_root(id) {
                let _ = std::fs::remove_dir_all(managed);
            }
        }
        Ok(existed)
    }

    /// The catalog this manager resolves against: the directory the host
    /// pointed at, or the cwd-relative / embedded fallback.
    fn catalog(&self) -> Vec<PluginMarketplaceEntry> {
        match self.marketplace_dir.as_deref() {
            Some(dir) => load_marketplace_from(dir),
            None => load_marketplace(None),
        }
    }

    /// The local root of an installed plugin. A remote install under
    /// `<home>/plugins/<id>` wins; then the root recorded at install time (an
    /// uncatalogued local directory); otherwise the catalog `source` is
    /// resolved, which answers `None` for a remote source or a path that is not
    /// on disk.
    pub fn plugin_root(&self, id: &str) -> Option<PathBuf> {
        if let Some(managed) = self.managed_root(id)
            && crate::server::plugin_archive::has_manifest(&managed)
        {
            return Some(managed);
        }
        if let Some(recorded) = self
            .load_installed_map()
            .get(id)
            .and_then(|info| info.root.as_deref())
        {
            let path = PathBuf::from(recorded);
            if crate::server::plugin_archive::has_manifest(&path) {
                return Some(path);
            }
        }
        let source = self
            .catalog()
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.source.clone())?;
        resolve_plugin_root(&source, self.marketplace_dir.as_deref())
    }

    /// Every command one plugin contributes, in manifest order.
    pub fn plugin_commands(&self, id: &str) -> Vec<PluginCommandDef> {
        let Some(root) = self.plugin_root(id) else {
            return Vec::new();
        };
        let Some(manifest) = read_plugin_manifest(&root) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for entry in manifest.commands.unwrap_or_default() {
            let command_path = if Path::new(&entry.path).is_absolute() {
                PathBuf::from(&entry.path)
            } else {
                root.join(entry.path.trim_start_matches("./"))
            };
            let Ok(text) = std::fs::read_to_string(&command_path) else {
                continue;
            };
            out.push(parse_plugin_command(
                &text,
                &command_path,
                id,
                entry.name.as_deref(),
            ));
        }
        out
    }

    /// Every command the enabled plugins contribute, in plugin-id order.
    pub fn enabled_commands(&self) -> Vec<PluginCommandDef> {
        let installed = self.load_installed_map();
        let mut ids: Vec<String> = installed
            .iter()
            .filter(|(_, info)| info.enabled)
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids.iter().flat_map(|id| self.plugin_commands(id)).collect()
    }

    /// Comma-separated sorted ids of the enabled plugins (v2 #3963
    /// `enabled_plugins`): an empty string when the set is known empty.
    pub fn enabled_plugin_ids(&self) -> String {
        let mut ids: Vec<String> = self
            .list_plugins()
            .into_iter()
            .filter(|plugin| plugin.enabled)
            .map(|plugin| plugin.id)
            .collect();
        ids.sort();
        ids.join(",")
    }

    /// The MCP servers an installed plugin's manifest declares.
    pub fn plugin_mcp_servers(&self, id: &str) -> Vec<PluginMcpServerInfo> {
        let Some(root) = self.plugin_root(id) else {
            return Vec::new();
        };
        let Some(manifest) = read_plugin_manifest(&root) else {
            return Vec::new();
        };
        let Some(servers) = manifest
            .mcp_servers
            .as_ref()
            .and_then(|value| value.as_object())
        else {
            return Vec::new();
        };
        let disabled = self.load_disabled_mcp_servers(id);
        let mut out = Vec::new();
        for (name, config) in servers {
            let transport = config
                .get("transport")
                .and_then(|value| value.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    if config.get("command").is_some() {
                        "stdio".to_string()
                    } else {
                        "http".to_string()
                    }
                });
            out.push(PluginMcpServerInfo {
                name: name.clone(),
                transport,
                command: config
                    .get("command")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                args: config
                    .get("args")
                    .and_then(|value| value.as_array())
                    .map(|list| {
                        list.iter()
                            .filter_map(|value| value.as_str().map(str::to_string))
                            .collect()
                    }),
                url: config
                    .get("url")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                enabled: !disabled.contains(name),
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// The skill roots the enabled plugins declare, in plugin-id order, each
    /// paired with the plugin it came from and that plugin's
    /// `skillInstructions` (v2 `manager.pluginSkillRoots`,
    /// `app/plugin/manager.ts:307-321` — the same `plugin: {id, instructions}`
    /// on every root one plugin contributes).
    ///
    /// A manifest `skills` value is a single path or a list; each resolves
    /// against the plugin root, and a path that is not a directory is dropped
    /// so a stale manifest cannot widen the scan.
    pub fn plugin_skill_dirs(&self) -> Vec<crate::skills::PluginSkillDir> {
        let mut out = Vec::new();
        for id in self.enabled_ids() {
            let Some(root) = self.plugin_root(&id) else {
                continue;
            };
            let Some(manifest) = read_plugin_manifest(&root) else {
                continue;
            };
            let instructions = manifest
                .skill_instructions
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string);
            // Already absolute and proven inside the plugin root by
            // `parse_plugin_manifest`, so this loop cannot widen the scan.
            for dir in manifest.skills.iter().flatten() {
                out.push(crate::skills::PluginSkillDir {
                    dir: PathBuf::from(dir),
                    plugin_id: id.clone(),
                    instructions: instructions.clone(),
                });
            }
        }
        out
    }

    /// [`Self::plugin_skill_dirs`] as bare paths, for the callers that only
    /// merge the roots into a flat scan (the REST skill lists, the prompt's
    /// skills section) and never ask which plugin contributed a skill.
    pub fn plugin_skill_dir_paths(&self) -> Vec<PathBuf> {
        self.plugin_skill_dirs()
            .into_iter()
            .map(|entry| entry.dir)
            .collect()
    }

    /// The MCP servers the enabled plugins declare, ready for the engine's MCP
    /// manager. A server the user disabled for that plugin is skipped, and the
    /// name is namespaced so two plugins can declare the same server name.
    pub fn plugin_mcp_configs(&self) -> Vec<PluginMcpConfig> {
        let mut out = Vec::new();
        for id in self.enabled_ids() {
            let Some(root) = self.plugin_root(&id) else {
                continue;
            };
            let Some(manifest) = read_plugin_manifest(&root) else {
                continue;
            };
            let Some(servers) = manifest
                .mcp_servers
                .as_ref()
                .and_then(|value| value.as_object())
            else {
                continue;
            };
            let disabled = self.load_disabled_mcp_servers(&id);
            for (name, config) in servers {
                if disabled.contains(name) {
                    continue;
                }
                let transport = config
                    .get("transport")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        if config.get("command").is_some() {
                            "stdio".to_string()
                        } else {
                            "http".to_string()
                        }
                    });
                let mut command = config
                    .get("command")
                    .and_then(|value| value.as_str())
                    .map(|command| resolve_command_against(&root, command));
                let mut args: Vec<String> = config
                    .get("args")
                    .and_then(|value| value.as_array())
                    .map(|list| {
                        list.iter()
                            .filter_map(|value| value.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                let mut env = string_map(config.get("env"));
                // A JS stdio server declared with `command: "node"` does not
                // require a system Node.js: when the host recorded its own
                // executable, the entry is re-executed inside the host runtime
                // via the hidden `__plugin_run_node` subcommand, which
                // dynamic-imports the entry with `KIMI_PLUGIN_ROOT` pinned to
                // the plugin root. Non-node commands are left as declared.
                if let Some(runner) = self
                    .node_runner
                    .as_deref()
                    .filter(|_| command.as_deref().is_some_and(is_node_command))
                    && let Some(entry) = args.first().cloned()
                {
                    command = Some(runner.to_string_lossy().to_string());
                    env.insert(
                        "KIMI_PLUGIN_ROOT".to_string(),
                        root.to_string_lossy().to_string(),
                    );
                    let mut rewritten = vec!["__plugin_run_node".to_string(), entry];
                    rewritten.extend(args.drain(1..));
                    args = rewritten;
                }
                out.push(PluginMcpConfig {
                    name: format!("{id}__{name}"),
                    transport,
                    command,
                    args,
                    env,
                    // A manifest `cwd` is relative to the plugin root, not to
                    // whatever directory the host happens to run in.
                    cwd: config
                        .get("cwd")
                        .and_then(|value| value.as_str())
                        .map(|cwd| resolve_dir_against(&root, cwd)),
                    url: config
                        .get("url")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                    headers: string_map(config.get("headers")),
                });
            }
        }
        out
    }

    /// The installed-and-enabled plugin ids, sorted.
    fn enabled_ids(&self) -> Vec<String> {
        let installed = self.load_installed_map();
        let mut ids: Vec<String> = installed
            .iter()
            .filter(|(_, info)| info.enabled)
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }

    /// Full detail for one installed plugin.
    pub fn plugin_info(&self, id: &str) -> Option<PluginInfo> {
        let installed = self.load_installed_map();
        let info = installed.get(id)?;
        let catalog = self.catalog();
        let meta = catalog.iter().find(|entry| entry.id == id);
        let root = self.plugin_root(id);
        // One parse, reused for the manifest itself and for the paths: reading
        // the file twice could report a `manifestPath` that disagrees with the
        // `manifest` beside it.
        let ParsedPluginManifest {
            manifest,
            manifest_kind,
            manifest_path,
            shadowed_manifest_path,
            diagnostics,
        } = root
            .as_deref()
            .map(parse_plugin_manifest)
            .unwrap_or_default();
        let commands = self.plugin_commands(id);
        let mcp_servers = self.plugin_mcp_servers(id);
        let manifest_ref = manifest.as_ref();
        let skill_count = manifest_ref
            .and_then(|manifest| manifest.skills.as_ref())
            .map(Vec::len)
            .unwrap_or(0);
        let hook_count = manifest_ref
            .and_then(|manifest| manifest.hooks.as_ref())
            .map(Vec::len)
            .unwrap_or(0);
        let forward_slashes = |path: &Path| path.to_string_lossy().replace('\\', "/");
        // v2 `recordFrom` (`app/plugin/manager.ts:596-602`): any `error`
        // diagnostic — or no readable manifest at all — makes the record an
        // error, and a **warning never does**. Before this the fork reported
        // `ok` for a plugin whose manifest it had just rejected, which is the
        // one thing a state badge must not do.
        //
        // The fork's `remote` is kept for the catalogued-but-not-on-disk case:
        // v2 has no word for it because every v2 record has a managed root.
        let state = if root.is_none() {
            "remote".to_string()
        } else if diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == "error")
            || manifest_ref.is_none()
        {
            "error".to_string()
        } else {
            "ok".to_string()
        };
        // The install source, classified. `original_source` is the string the
        // install was asked for, which is the only spelling that still means
        // anything once the content has been copied into the managed root; the
        // catalog entry is the fallback for a record that predates the field.
        let resolved_source = classify_plugin_source(
            info.original_source
                .as_deref()
                .or(meta.map(|entry| entry.source.as_str()))
                .unwrap_or(id),
        );
        // An installed plugin the manifest parse could not vouch for. Mirrors the
        // state rule above, so the two can never disagree.
        let has_errors = state == "error";

        Some(PluginInfo {
            id: id.to_string(),
            name: meta
                .map(|entry| entry.display_name.clone())
                .or_else(|| manifest_ref.and_then(|manifest| manifest.name.clone()))
                .unwrap_or_else(|| id.to_string()),
            display_name: meta
                .map(|entry| entry.display_name.clone())
                .or_else(|| manifest_ref.and_then(|manifest| manifest.name.clone()))
                .unwrap_or_else(|| id.to_string()),
            description: meta
                .map(|entry| entry.description.clone())
                .or_else(|| manifest_ref.and_then(|manifest| manifest.description.clone()))
                .unwrap_or_default(),
            version: info
                .version
                .clone()
                .or_else(|| meta.and_then(|entry| entry.version.clone()))
                .or_else(|| manifest_ref.and_then(|manifest| manifest.version.clone()))
                .unwrap_or_else(|| "1.0.0".into()),
            enabled: info.enabled,
            state: state.clone(),
            // Classified from the source the user actually installed from, so
            // the answer survives the copy into the managed root. A record
            // written before `originalSource` was recorded falls back to the
            // catalog's `source` string, which is the same string when the
            // plugin is still catalogued.
            source: resolved_source.kind,
            github: resolved_source.github,
            root: root.as_deref().map(forward_slashes),
            installed_at: info.installed_at.clone(),
            original_source: info.original_source.clone(),
            updated_at: info.updated_at.clone(),
            // The paths the parse actually used, not a reconstruction: a plugin
            // on the `.kimi-plugin/plugin.json` form has no root manifest, and
            // naming a file that is not there is worse than naming none.
            manifest_path: manifest_path.as_deref().map(Path::new).map(forward_slashes),
            manifest_kind,
            manifest,
            shadowed_manifest_path: shadowed_manifest_path
                .as_deref()
                .map(Path::new)
                .map(forward_slashes),
            diagnostics,
            command_count: commands.len(),
            mcp_server_count: mcp_servers.len(),
            enabled_mcp_server_count: mcp_servers.iter().filter(|server| server.enabled).count(),
            skill_count,
            hook_count,
            has_errors,
            commands,
            mcp_servers,
        })
    }

    /// Enable or disable one MCP server a plugin declares. The choice is
    /// recorded per plugin, so editing the manifest does not silently
    /// re-enable a server the user turned off.
    pub fn set_mcp_server_enabled(
        &self,
        id: &str,
        server: &str,
        enabled: bool,
    ) -> Result<bool, rusqlite::Error> {
        if !self
            .plugin_mcp_servers(id)
            .iter()
            .any(|entry| entry.name == server)
        {
            return Ok(false);
        }
        let mut disabled = self.load_disabled_mcp_servers(id);
        if enabled {
            disabled.remove(server);
        } else {
            disabled.insert(server.to_string());
        }
        let value =
            serde_json::to_value(disabled.iter().collect::<Vec<_>>()).unwrap_or_else(|_| json!([]));
        self.store
            .put_state("plugins", &format!("mcp_disabled:{id}"), &value)?;
        Ok(true)
    }

    fn load_disabled_mcp_servers(&self, id: &str) -> std::collections::BTreeSet<String> {
        self.store
            .get_state("plugins", &format!("mcp_disabled:{id}"))
            .unwrap_or(None)
            .and_then(|value| serde_json::from_value::<Vec<String>>(value).ok())
            .map(|list| list.into_iter().collect())
            .unwrap_or_default()
    }

    /// Re-read the catalog and every installed plugin's manifest, reporting
    /// what changed since the previous reload and which manifests no longer
    /// parse. The manager caches nothing, so this is a re-validation rather
    /// than a cache flush.
    pub fn reload(&self) -> ReloadSummary {
        let installed = self.load_installed_map();
        let mut current: Vec<String> = installed.keys().cloned().collect();
        current.sort();

        let previous = {
            let mut guard = self.known_ids.lock().unwrap_or_else(|p| p.into_inner());
            std::mem::replace(&mut *guard, current.clone())
        };

        let added = current
            .iter()
            .filter(|id| !previous.contains(id))
            .cloned()
            .collect();
        let removed = previous
            .into_iter()
            .filter(|id| !current.contains(id))
            .collect();

        let mut errors = Vec::new();
        for (id, info) in &installed {
            if !info.enabled {
                continue;
            }
            let Some(root) = self.plugin_root(id) else {
                continue;
            };
            if read_plugin_manifest(&root).is_none() {
                errors.push(ReloadError {
                    id: id.clone(),
                    message: format!(
                        "{} is missing or is not valid JSON",
                        root.join("kimi.plugin.json").to_string_lossy()
                    ),
                });
            }
        }
        errors.sort_by(|a, b| a.id.cmp(&b.id));

        ReloadSummary {
            added,
            removed,
            errors,
        }
    }
}

/// One manifest that failed to load during a reload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReloadError {
    pub id: String,
    pub message: String,
}

/// What a reload changed — the wire `ReloadSummary` the host renders.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReloadSummary {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub errors: Vec<ReloadError>,
}

/// A manifest `{ key: "value" }` object as a string map, dropping non-strings.
fn string_map(value: Option<&Value>) -> HashMap<String, String> {
    value
        .and_then(|value| value.as_object())
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|text| (key.clone(), text.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Resolve a manifest `cwd` against the plugin root. An absolute path is kept.
fn resolve_dir_against(root: &Path, value: &str) -> String {
    if Path::new(value).is_absolute() {
        return value.to_string();
    }
    root.join(value.trim_start_matches("./"))
        .to_string_lossy()
        .replace('\\', "/")
}

/// Resolve a manifest `command` against the plugin root when it names a path
/// (`./bin/server.mjs`). A bare name (`node`) is left alone so PATH lookup
/// still works.
fn resolve_command_against(root: &Path, value: &str) -> String {
    if value.starts_with("./") || value.starts_with("../") {
        return resolve_dir_against(root, value);
    }
    value.to_string()
}

/// Whether a manifest `command` names the system Node.js runtime (`node`,
/// `node.exe`, or a path resolving to either), which the host runtime can
/// re-execute instead of spawning a separate Node process.
fn is_node_command(command: &str) -> bool {
    let name = std::path::Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command);
    name == "node" || name.eq_ignore_ascii_case("node.exe")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_marketplace_has_official_entries() {
        let list = load_marketplace(None);
        assert_eq!(list.len(), 3);

        let ds = list
            .iter()
            .find(|p| p.id == "kimi-datasource")
            .expect("kimi-datasource");
        assert_eq!(ds.tier, "official");
        assert_eq!(ds.display_name, "Kimi Datasource");
        assert_eq!(ds.version.as_deref(), Some("3.4.0"));
        assert_eq!(ds.source, "./official/kimi-datasource");
        assert_eq!(ds.keywords.as_ref().unwrap(), &vec!["data", "mcp"]);

        let wb = list
            .iter()
            .find(|p| p.id == "kimi-webbridge")
            .expect("kimi-webbridge");
        assert_eq!(wb.tier, "official");
        assert_eq!(wb.display_name, "Kimi WebBridge");
        assert_eq!(wb.version.as_deref(), Some("1.11.3"));
        assert_eq!(wb.source, "./official/kimi-webbridge");

        let sp = list
            .iter()
            .find(|p| p.id == "superpowers")
            .expect("superpowers");
        assert_eq!(sp.tier, "curated");
        assert_eq!(sp.display_name, "Superpowers");
        assert_eq!(
            sp.homepage.as_deref(),
            Some("https://github.com/obra/superpowers")
        );
    }

    #[test]
    fn test_load_marketplace_from_custom_repo_root() {
        let temp_dir = tempfile::tempdir().unwrap();
        let plugins_dir = temp_dir.path().join("plugins");
        std::fs::create_dir_all(&plugins_dir).unwrap();

        let custom_catalog = serde_json::json!({
            "version": "1",
            "plugins": [
                {
                    "id": "custom-tool",
                    "tier": "community",
                    "displayName": "Custom Tool",
                    "version": "2.0.0",
                    "description": "A custom tool",
                    "source": "https://example.test/custom"
                }
            ]
        });
        std::fs::write(
            plugins_dir.join("marketplace.json"),
            custom_catalog.to_string(),
        )
        .unwrap();

        let entries = load_marketplace(Some(temp_dir.path()));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "custom-tool");
        assert_eq!(entries[0].tier, "community");
        assert_eq!(entries[0].display_name, "Custom Tool");
        assert_eq!(entries[0].version.as_deref(), Some("2.0.0"));
    }

    /// v2 #3963 `enabled_plugins`: the sorted, comma-joined enabled set —
    /// an empty string when the set is known empty.
    #[test]
    fn test_enabled_plugin_ids_reports_the_sorted_enabled_set() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let pm = PluginManager::new(store.clone());

        assert_eq!(pm.enabled_plugin_ids(), "", "no plugins: known empty set");

        assert!(pm.set_plugin_enabled("kimi-webbridge", true).unwrap());
        assert_eq!(pm.enabled_plugin_ids(), "kimi-webbridge");

        assert!(pm.set_plugin_enabled("superpowers", true).unwrap());
        assert_eq!(
            pm.enabled_plugin_ids(),
            "kimi-webbridge,superpowers",
            "ids are sorted, not insertion-ordered"
        );

        assert!(pm.set_plugin_enabled("kimi-webbridge", false).unwrap());
        assert_eq!(pm.enabled_plugin_ids(), "superpowers");
    }

    #[test]
    fn test_plugin_manager_enable_disable_and_remove() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let pm = PluginManager::new(store.clone());

        assert!(pm.list_plugins().is_empty());

        // 1. A catalogued plugin can be enabled, and it is recorded with the
        //    catalog's version — not a fabricated literal.
        assert!(pm.set_plugin_enabled("kimi-webbridge", true).unwrap());
        let list1 = pm.list_plugins();
        assert_eq!(list1.len(), 1);
        assert_eq!(list1[0].id, "kimi-webbridge");
        assert_eq!(list1[0].name, "Kimi WebBridge");
        assert!(list1[0].enabled);
        assert_eq!(list1[0].version, "1.11.3");

        // 2. An id that is neither installed nor in the catalog is rejected and
        //    must NOT be recorded (it used to get a fake `version: "1.0.0"`).
        assert!(!pm.set_plugin_enabled("custom-plugin-x", true).unwrap());
        assert_eq!(pm.list_plugins().len(), 1);
        assert!(pm.list_plugins().iter().all(|p| p.id != "custom-plugin-x"));

        // 3. `install_plugin`: unknown → None; catalogued → recorded info.
        assert!(pm.install_plugin("no-such-plugin").unwrap().is_none());
        let installed = pm.install_plugin("superpowers").unwrap().unwrap();
        assert_eq!(installed.version, None);
        let ids: Vec<String> = pm.list_plugins().into_iter().map(|p| p.id).collect();
        assert!(ids.contains(&"superpowers".to_string()));

        // 4. Disable
        assert!(pm.set_plugin_enabled("kimi-webbridge", false).unwrap());
        let list2 = pm.list_plugins();
        let wb = list2.iter().find(|p| p.id == "kimi-webbridge").unwrap();
        assert!(!wb.enabled);

        // 5. Marketplace merge status
        let market = pm.list_marketplace();
        let wb_market = market.iter().find(|p| p.id == "kimi-webbridge").unwrap();
        assert_eq!(wb_market.installed.as_ref().map(|i| i.enabled), Some(false));

        // 6. Persistence across a fresh PluginManager instance on the same store
        let pm_fresh = PluginManager::new(store);
        assert_eq!(pm_fresh.list_plugins().len(), 2);

        // 7. Remove plugin
        assert!(pm_fresh.remove_plugin("kimi-webbridge").unwrap());
        let list3 = pm_fresh.list_plugins();
        assert_eq!(list3.len(), 1);
        assert_eq!(list3[0].id, "superpowers");

        // Remove non-existent plugin returns false
        assert!(!pm_fresh.remove_plugin("non-existent").unwrap());
    }

    #[test]
    fn parse_plugin_command_reads_frontmatter_and_falls_back() {
        let path = Path::new("/plugins/demo/commands/review.md");

        let with_frontmatter = parse_plugin_command(
            "---\nname: code-review\ndescription: Review the diff\n---\n\nReview $ARGUMENTS\n",
            path,
            "demo",
            None,
        );
        assert_eq!(with_frontmatter.name, "code-review");
        assert_eq!(with_frontmatter.description, "Review the diff");
        assert_eq!(with_frontmatter.body, "Review $ARGUMENTS");
        assert_eq!(with_frontmatter.plugin_id, "demo");

        // No frontmatter: the file stem names it, the first body line describes it.
        let bare = parse_plugin_command("Do the thing\n\nmore\n", path, "demo", None);
        assert_eq!(bare.name, "review");
        assert_eq!(bare.description, "Do the thing");
        assert_eq!(bare.body, "Do the thing\n\nmore");

        // An explicit manifest name wins over the file stem.
        let named = parse_plugin_command("body\n", path, "demo", Some("explicit"));
        assert_eq!(named.name, "explicit");
        assert_eq!(named.description, "body");
    }

    #[test]
    fn resolve_plugin_root_skips_remote_and_missing_sources() {
        let temp = tempfile::tempdir().unwrap();
        let marketplace = temp.path();
        std::fs::create_dir_all(marketplace.join("official/demo")).unwrap();

        assert_eq!(
            resolve_plugin_root("./official/demo", Some(marketplace)),
            Some(marketplace.join("official/demo"))
        );
        assert_eq!(
            resolve_plugin_root("https://example.test/demo", Some(marketplace)),
            None
        );
        assert_eq!(
            resolve_plugin_root("./official/missing", Some(marketplace)),
            None
        );
        assert_eq!(resolve_plugin_root("./official/demo", None), None);
    }

    /// The panel renders an install date and the pre-resolution source, and the
    /// engine sent neither. Both are facts only the install record knows, so
    /// they are recorded once at install and preserved afterwards — a re-install
    /// must not silently restate when the plugin arrived.
    #[test]
    fn an_install_records_when_and_from_where_and_keeps_both() {
        let temp = tempfile::tempdir().unwrap();
        let marketplace = temp.path();
        let root = marketplace.join("official/demo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            marketplace.join("marketplace.json"),
            r#"{"version":"1","plugins":[{"id":"demo","tier":"official","displayName":"Demo","description":"A demo","source":"./official/demo"}]}"#,
        )
        .unwrap();
        std::fs::write(root.join("kimi.plugin.json"), r#"{"name":"demo"}"#).unwrap();

        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let pm = PluginManager::new(store).with_marketplace_dir(Some(marketplace.to_path_buf()));

        let installed = pm.install_plugin("demo").unwrap().expect("catalogued");
        let first_install = installed.installed_at.clone().expect("an install is dated");
        assert!(
            chrono::DateTime::parse_from_rfc3339(&first_install).is_ok(),
            "{first_install} is not RFC 3339"
        );
        assert_eq!(
            installed.original_source.as_deref(),
            Some("./official/demo"),
            "the catalog source, before it was resolved to a root"
        );

        // A second install is not a new arrival.
        std::thread::sleep(std::time::Duration::from_millis(5));
        let again = pm
            .install_plugin("demo")
            .unwrap()
            .expect("still catalogued");
        assert_eq!(again.installed_at.as_deref(), Some(first_install.as_str()));
        assert_eq!(again.original_source.as_deref(), Some("./official/demo"));

        // And they reach the host, which is the point of recording them.
        let info = pm.plugin_info("demo").expect("info");
        assert_eq!(info.installed_at.as_deref(), Some(first_install.as_str()));
        assert_eq!(info.original_source.as_deref(), Some("./official/demo"));
    }

    /// A record written before these fields existed still loads, and reports
    /// them as absent rather than inventing a date. The panel then omits the
    /// lines, which is the truth: the moment was never written down.
    #[test]
    fn an_older_install_record_loads_without_the_new_fields() {
        let temp = tempfile::tempdir().unwrap();
        let marketplace = temp.path();
        let root = marketplace.join("official/demo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            marketplace.join("marketplace.json"),
            r#"{"version":"1","plugins":[{"id":"demo","tier":"official","displayName":"Demo","description":"A demo","source":"./official/demo"}]}"#,
        )
        .unwrap();
        std::fs::write(root.join("kimi.plugin.json"), r#"{"name":"demo"}"#).unwrap();

        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let pm = PluginManager::new(store).with_marketplace_dir(Some(marketplace.to_path_buf()));
        // The shape a fork from before these fields wrote: enabled, version, root.
        let legacy = InstalledPluginInfo {
            enabled: true,
            version: Some("1.0.0".into()),
            root: None,
            installed_at: None,
            original_source: None,
            updated_at: None,
        };
        assert!(
            serde_json::from_value::<InstalledPluginInfo>(serde_json::json!({
                "enabled": true,
                "version": "1.0.0"
            }))
            .is_ok(),
            "a record without the new fields must still deserialize"
        );

        let mut installed = pm.load_installed_map();
        installed.insert("demo".to_string(), legacy);
        pm.save_installed_map(&installed).unwrap();
        let info = pm.plugin_info("demo").expect("info");
        assert_eq!(info.installed_at, None);
        assert_eq!(info.original_source, None);
        assert!(info.installed_at.is_none(), "no invented date");
    }

    /// v2's `resolveInstallSource` / `parseGithubUrl` (`app/plugin/source.ts:19-92`),
    /// case for case. The `source` value is the whole basis of the host's
    /// provenance label and trust badge, so a misclassification is a wrong badge
    /// rather than a cosmetic difference.
    #[test]
    fn an_install_source_is_classified_the_way_v2_classifies_it() {
        let github = |source: &str| classify_plugin_source(source).github.expect("github");

        // A bare repository URL: no ref named, so v2's "no explicit pin"
        // spelling. v2 would have resolved the latest release tag over the
        // network here; `explicitGithubRef` drops a `HEAD` branch before
        // comparing, so every consumer reads it the same way.
        let bare = github("https://github.com/octocat/hello");
        assert_eq!(bare.owner, "octocat");
        assert_eq!(bare.repo, "hello");
        assert_eq!(bare.ref_.kind, PluginGithubRefKind::Branch);
        assert_eq!(bare.ref_.value, "HEAD");

        // `.git` is stripped from the repo, `www.` accepted from the host.
        let suffix = github("https://www.github.com/octocat/hello.git");
        assert_eq!(suffix.repo, "hello");

        // `tree/<ref>`: hex is a commit, anything else a branch.
        let branch = github("https://github.com/octocat/hello/tree/main");
        assert_eq!(branch.ref_.kind, PluginGithubRefKind::Branch);
        assert_eq!(branch.ref_.value, "main");
        let sha = github("https://github.com/octocat/hello/tree/a1b2c3d4e5f6");
        assert_eq!(sha.ref_.kind, PluginGithubRefKind::Sha);
        // 6 hex characters is not a SHA — too short to be one.
        assert_eq!(
            github("https://github.com/octocat/hello/tree/a1b2c3")
                .ref_
                .kind,
            PluginGithubRefKind::Branch
        );

        let tag = github("https://github.com/octocat/hello/releases/tag/v2.1.0");
        assert_eq!(tag.ref_.kind, PluginGithubRefKind::Tag);
        assert_eq!(tag.ref_.value, "v2.1.0");

        let commit = github("https://github.com/octocat/hello/commit/deadbeef");
        assert_eq!(commit.ref_.kind, PluginGithubRefKind::Sha);
        assert_eq!(commit.ref_.value, "deadbeef");

        // A ref with an escaped slash keeps it: v2 joins the decoded segments.
        let slashy = github("https://github.com/octocat/hello/tree/feature%2Fx");
        assert_eq!(slashy.ref_.value, "feature/x");

        // Not a github source: another host, a non-https scheme, a bare host, a
        // trailing path that names no ref, or a non-URL.
        for source in [
            "https://example.test/octocat/hello",
            "http://github.com/octocat/hello",
            "https://github.com/octocat",
            "https://github.com/octocat/hello/blob/main/README.md",
            "./official/demo",
            "/abs/path/to/plugin",
        ] {
            let resolved = classify_plugin_source(source);
            assert!(
                resolved.github.is_none(),
                "{source} must not read as a github source"
            );
        }
        assert_eq!(
            classify_plugin_source("https://example.test/p.zip").kind,
            PluginSourceKind::ZipUrl
        );
        assert_eq!(
            classify_plugin_source("./official/demo").kind,
            PluginSourceKind::LocalPath
        );
        // Surrounding whitespace is trimmed, as v2's `source.trim()` does.
        assert_eq!(
            classify_plugin_source("  https://example.test/p.zip  ").kind,
            PluginSourceKind::ZipUrl
        );
    }

    /// The wire has to carry the *vocabulary*, because every host-side reader
    /// compares against it: the provenance label, the trust badge, the official
    /// install check and the update notifier's identity key all branch on
    /// `source === 'github' | 'zip-url'`. A raw URL matched none of them, so the
    /// badge was always "third-party" and the update notifier never fired.
    #[test]
    fn the_wire_carries_the_source_vocabulary_and_the_github_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let marketplace = temp.path();
        let root = marketplace.join("official/remote");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            marketplace.join("marketplace.json"),
            r#"{"version":"1","plugins":[{"id":"remote","tier":"community","displayName":"Remote","description":"From GitHub","source":"https://github.com/example/remote/tree/main"}]}"#,
        )
        .unwrap();
        std::fs::write(root.join("kimi.plugin.json"), r#"{"name":"remote"}"#).unwrap();

        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let pm = PluginManager::new(store).with_marketplace_dir(Some(marketplace.to_path_buf()));
        pm.install_plugin("remote").unwrap().expect("catalogued");

        let info = pm.plugin_info("remote").expect("info");
        assert_eq!(info.source, PluginSourceKind::Github);
        let github = info.github.as_ref().expect("github metadata");
        assert_eq!(github.owner, "example");
        assert_eq!(github.repo, "remote");
        assert_eq!(github.ref_.kind, PluginGithubRefKind::Branch);
        assert_eq!(github.ref_.value, "main");
        // The pre-resolution spelling is kept, which is what the host pairs with
        // the vocabulary to render `github <owner>/<repo>@<ref>`.
        assert_eq!(
            info.original_source.as_deref(),
            Some("https://github.com/example/remote/tree/main")
        );

        // The list projection carries both too: the list view's label and badge
        // are computed from a `PluginSummary`, not from the detail view.
        let summary = pm
            .list_plugins()
            .into_iter()
            .find(|plugin| plugin.id == "remote")
            .expect("summary");
        assert_eq!(summary.source, PluginSourceKind::Github);
        assert!(summary.github.is_some());
        assert!(summary.original_source.is_some());

        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["source"], "github");
        assert_eq!(json["github"]["ref"]["kind"], "branch");
        assert_eq!(json["github"]["ref"]["value"], "main");
    }

    /// v2 stamps `updatedAt` on every install and keeps `installedAt` from the
    /// first (`manager.ts:140-141`), so a re-install is what an update looks
    /// like here — the panel only shows the line when the two differ.
    #[test]
    fn a_reinstall_keeps_the_install_time_and_advances_the_update_time() {
        let temp = tempfile::tempdir().unwrap();
        let marketplace = temp.path();
        let root = marketplace.join("official/demo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            marketplace.join("marketplace.json"),
            r#"{"version":"1","plugins":[{"id":"demo","tier":"official","displayName":"Demo","description":"A demo","source":"./official/demo"}]}"#,
        )
        .unwrap();
        std::fs::write(root.join("kimi.plugin.json"), r#"{"name":"demo"}"#).unwrap();

        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let pm = PluginManager::new(store).with_marketplace_dir(Some(marketplace.to_path_buf()));

        let first = pm.install_plugin("demo").unwrap().expect("catalogued");
        let installed_at = first.installed_at.clone().expect("dated");
        let first_updated = first.updated_at.clone().expect("dated");

        std::thread::sleep(std::time::Duration::from_millis(5));
        let again = pm
            .install_plugin("demo")
            .unwrap()
            .expect("still catalogued");
        assert_eq!(again.installed_at.as_deref(), Some(installed_at.as_str()));
        assert_ne!(
            again.updated_at.as_deref(),
            Some(first_updated.as_str()),
            "a re-install advances updatedAt"
        );
        assert!(chrono::DateTime::parse_from_rfc3339(again.updated_at.as_ref().unwrap()).is_ok());
    }

    /// A declared root that does not exist must be reported as v2 reports it — a
    /// `warn` for "not a directory" — never as an escape.
    ///
    /// This regressed: the first containment check canonicalized the *target* and
    /// fell back to the path as written when that failed, while the root was
    /// canonicalized. On Windows those two disagree whenever the root is spelled
    /// with an 8.3 short name (`C:\Users\ADMINI~1\...`), so every missing
    /// directory came back as "resolves outside the plugin" — an error, on the
    /// most ordinary manifest there is.
    #[test]
    fn a_missing_declared_root_is_a_warning_and_not_an_escape() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugin");
        std::fs::create_dir_all(&root).unwrap();
        // Neither the root's skills dir nor its agents dir exists.
        std::fs::write(
            root.join("kimi.plugin.json"),
            r#"{"name":"hollow","skills":"./skills/","agents":"./agents/"}"#,
        )
        .unwrap();

        let parsed = parse_plugin_manifest(&root);
        assert!(
            parsed.diagnostics.iter().all(|d| d.severity == "warn"),
            "no error expected, got {:?}",
            parsed.diagnostics
        );
        assert_eq!(parsed.diagnostics.len(), 2, "{:?}", parsed.diagnostics);
        assert!(
            parsed
                .diagnostics
                .iter()
                .all(|d| d.message.contains("not a directory")),
            "{:?}",
            parsed.diagnostics
        );
        assert!(
            parsed
                .diagnostics
                .iter()
                .all(|d| !d.message.contains("outside the plugin")),
            "{:?}",
            parsed.diagnostics
        );
    }

    /// v2's state rule (`manager.ts:596-602`): an `error` diagnostic or an
    /// unreadable manifest makes the record an error, a **warning does not**.
    /// The fork used to answer `ok` for a plugin whose manifest the same read had
    /// just rejected — and `hasErrors` contradicted it at the same time.
    ///
    /// `state` is badge-only in the fork: nothing gates a plugin's contributions
    /// on it, so this changes what the panel says and nothing else. That is also
    /// why the "an error-state plugin contributes nothing" half of v2's rule is
    /// *not* adopted here — see the ledger.
    #[test]
    fn the_state_follows_the_diagnostics_and_a_warning_does_not_flip_it() {
        let temp = tempfile::tempdir().unwrap();

        let install = |name: &str, manifest: &str, skills_dir: bool| {
            let marketplace = temp.path().join(name);
            let root = marketplace.join("official").join(name);
            std::fs::create_dir_all(&root).unwrap();
            if skills_dir {
                std::fs::create_dir_all(root.join("skills")).unwrap();
            }
            std::fs::write(
                marketplace.join("marketplace.json"),
                format!(
                    r#"{{"version":"1","plugins":[{{"id":"{name}","tier":"official","displayName":"{name}","description":"d","source":"./official/{name}"}}]}}"#
                ),
            )
            .unwrap();
            std::fs::write(root.join("kimi.plugin.json"), manifest).unwrap();
            let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
            let pm =
                PluginManager::new(store).with_marketplace_dir(Some(marketplace.to_path_buf()));
            pm.install_plugin(name).unwrap().expect("catalogued");
            let info = pm.plugin_info(name).expect("info");
            (pm, info)
        };

        // Clean: ok, no diagnostics.
        let (_, clean) = install("clean", r#"{"name":"clean","skills":"./skills/"}"#, true);
        assert_eq!(clean.state, "ok");
        assert!(!clean.has_errors);
        assert!(clean.diagnostics.is_empty());

        // A warning — here a declared skill root that is not a directory — leaves
        // the state alone, exactly as v2 does.
        let (_, warned) = install("warned", r#"{"name":"warned","skills":"./skills/"}"#, false);
        assert_eq!(
            warned.state, "ok",
            "a warning is not an error: {:?}",
            warned.diagnostics
        );
        assert!(!warned.has_errors);
        assert!(
            warned
                .diagnostics
                .iter()
                .any(|d| d.severity == "warn" && d.message.contains("not a directory")),
            "{:?}",
            warned.diagnostics
        );

        // An error — a path that tries to leave the plugin — flips it. The skill
        // root was already dropped when the path was resolved, so the badge now
        // matches what the plugin actually does.
        let (_, escaping) = install(
            "escaping",
            r#"{"name":"escaping","skills":"../elsewhere/"}"#,
            true,
        );
        assert_eq!(escaping.state, "error");
        assert!(escaping.has_errors);
        assert!(
            escaping.diagnostics.iter().any(|d| d.severity == "error"),
            "{:?}",
            escaping.diagnostics
        );

        // No manifest at all is an error too — and used to report `ok`.
        let (pm, _) = install("manifestless", r#"{"name":"manifestless"}"#, true);
        std::fs::remove_file(
            temp.path()
                .join("manifestless")
                .join("official")
                .join("manifestless")
                .join("kimi.plugin.json"),
        )
        .unwrap();
        let info = pm.plugin_info("manifestless").expect("info");
        assert_eq!(info.state, "error");
        assert!(info.has_errors);
        assert!(
            info.diagnostics
                .iter()
                .any(|d| d.severity == "error" && d.message.contains("No manifest at")),
            "{:?}",
            info.diagnostics
        );
    }

    #[test]
    fn plugin_commands_and_info_read_the_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let marketplace = temp.path();
        let root = marketplace.join("official/demo");
        std::fs::create_dir_all(root.join("commands")).unwrap();
        // Declared below, so it has to exist for the skill count to be 1.
        std::fs::create_dir_all(root.join("skills")).unwrap();
        std::fs::write(
            marketplace.join("marketplace.json"),
            r#"{"version":"1","plugins":[{"id":"demo","tier":"official","displayName":"Demo","description":"A demo","source":"./official/demo"}]}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("kimi.plugin.json"),
            r#"{
              "name": "demo",
              "version": "1.0.0",
              "skills": "./skills/",
              "mcpServers": { "data": { "command": "node", "args": ["server.mjs"] } },
              "commands": [{ "path": "./commands/review.md" }]
            }"#,
        )
        .unwrap();
        std::fs::write(
            root.join("commands/review.md"),
            "---\ndescription: Review the diff\n---\n\nReview it\n",
        )
        .unwrap();

        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let pm = PluginManager::new(store).with_marketplace_dir(Some(marketplace.to_path_buf()));

        // Nothing is installed yet, so nothing is contributed.
        assert!(pm.enabled_commands().is_empty());

        pm.install_plugin("demo").unwrap().expect("catalogued");
        let commands = pm.enabled_commands();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].plugin_id, "demo");
        assert_eq!(commands[0].name, "review");
        assert_eq!(commands[0].description, "Review the diff");
        assert_eq!(commands[0].body, "Review it");

        let info = pm.plugin_info("demo").expect("installed");
        assert_eq!(info.command_count, 1);
        assert_eq!(info.mcp_server_count, 1);
        assert_eq!(info.skill_count, 1);
        assert_eq!(info.state, "ok");
        assert_eq!(info.mcp_servers[0].name, "data");
        assert_eq!(info.mcp_servers[0].transport, "stdio");
        assert!(info.mcp_servers[0].enabled);

        // Disabling one MCP server is recorded and reflected; an unknown name
        // is refused rather than silently recorded.
        assert!(pm.set_mcp_server_enabled("demo", "data", false).unwrap());
        let info = pm.plugin_info("demo").expect("installed");
        assert!(!info.mcp_servers[0].enabled);
        assert!(!pm.set_mcp_server_enabled("demo", "nope", false).unwrap());

        // Disabling the plugin drops its commands.
        pm.set_plugin_enabled("demo", false).unwrap();
        assert!(pm.enabled_commands().is_empty());

        // Reload reports the diff against the snapshot taken at construction.
        let summary = pm.reload();
        assert_eq!(summary.added, vec!["demo".to_string()]);
        assert!(summary.removed.is_empty());
        assert!(summary.errors.is_empty());

        // A second reload has nothing new to report.
        let summary = pm.reload();
        assert!(summary.added.is_empty());
        assert!(summary.removed.is_empty());
        assert!(summary.errors.is_empty());
    }

    #[test]
    fn enabled_plugins_contribute_skill_dirs_and_mcp_configs() {
        let temp = tempfile::tempdir().unwrap();
        let marketplace = temp.path();
        let root = marketplace.join("official/demo");
        // The declared skill root has to exist: v2 drops a path that is not a
        // directory (with a `warn`), where the fork used to count the entry and
        // let the later scan find nothing.
        std::fs::create_dir_all(root.join("skills/review")).unwrap();
        std::fs::write(
            marketplace.join("marketplace.json"),
            r#"{"version":"1","plugins":[{"id":"demo","tier":"official","displayName":"Demo","description":"A demo","source":"./official/demo"}]}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("kimi.plugin.json"),
            r#"{
              "name": "demo",
              "skills": "./skills/",
              "skillInstructions": "  Always answer in the house voice.  ",
              "mcpServers": {
                "data": { "command": "node", "args": ["server.mjs"], "env": { "TOKEN": "x" }, "cwd": "./" },
                "remote": { "url": "https://example.test/mcp" }
              }
            }"#,
        )
        .unwrap();

        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let pm = PluginManager::new(store).with_marketplace_dir(Some(marketplace.to_path_buf()));

        // Nothing installed: nothing contributed.
        assert!(pm.plugin_skill_dirs().is_empty());
        assert!(pm.plugin_mcp_configs().is_empty());

        pm.install_plugin("demo").unwrap().expect("catalogued");
        let skill_dirs = pm.plugin_skill_dirs();
        assert_eq!(skill_dirs.len(), 1);
        // Resolved, so the answer is the real path rather than the manifest's
        // `./skills/` joined onto however the root happened to be spelled.
        assert_eq!(
            skill_dirs[0].dir,
            without_verbatim_prefix(&std::fs::canonicalize(root.join("skills")).unwrap())
        );
        assert_eq!(skill_dirs[0].plugin_id, "demo");
        // Trimmed on the way in: the renderer wraps the text in
        // `<plugin-instructions>` and an indented body would only widen the gap.
        assert_eq!(
            skill_dirs[0].instructions.as_deref(),
            Some("Always answer in the house voice.")
        );

        let configs = pm.plugin_mcp_configs();
        assert_eq!(configs.len(), 2);
        let data = configs
            .iter()
            .find(|config| config.name == "demo__data")
            .expect("data");
        assert_eq!(data.transport, "stdio");
        assert_eq!(data.command.as_deref(), Some("node"));
        assert_eq!(data.args, vec!["server.mjs"]);
        assert_eq!(data.env.get("TOKEN").map(String::as_str), Some("x"));
        // A manifest `cwd` is anchored to the plugin root, not the process cwd.
        let root_posix = root.to_string_lossy().replace('\\', "/");
        assert!(
            data.cwd
                .as_deref()
                .is_some_and(|cwd| cwd.starts_with(&root_posix)),
            "cwd {:?} must sit under {root_posix}",
            data.cwd
        );
        let remote = configs
            .iter()
            .find(|config| config.name == "demo__remote")
            .expect("remote");
        assert_eq!(remote.transport, "http");
        assert_eq!(remote.url.as_deref(), Some("https://example.test/mcp"));

        // Disabling one server drops it from the contributed set.
        assert!(pm.set_mcp_server_enabled("demo", "data", false).unwrap());
        let configs = pm.plugin_mcp_configs();
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0].name, "demo__remote");

        // Disabling the plugin drops everything.
        pm.set_plugin_enabled("demo", false).unwrap();
        assert!(pm.plugin_skill_dirs().is_empty());
        assert!(pm.plugin_mcp_configs().is_empty());
    }

    /// v2's two manifest locations, root first (`app/plugin/manifest.ts:16-17`,
    /// `:55-57`): the dir form answers when the root form is absent, and when
    /// both exist the root one wins with the other reported as shadowed. The
    /// fork read only `kimi.plugin.json`, so a plugin on the dir form
    /// contributed nothing at all.
    #[test]
    fn a_manifest_is_read_from_either_location_and_a_shadowed_one_is_reported() {
        let temp = tempfile::tempdir().unwrap();

        let dir_form = temp.path().join("dir-form");
        std::fs::create_dir_all(dir_form.join(".kimi-plugin")).unwrap();
        std::fs::write(
            dir_form.join(".kimi-plugin").join("plugin.json"),
            r#"{"name":"dirform","skills":"./skills/"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(dir_form.join("skills")).unwrap();
        let parsed = parse_plugin_manifest(&dir_form);
        assert_eq!(parsed.manifest_kind.as_deref(), Some("kimi-plugin-dir"));
        assert_eq!(
            parsed.manifest_path.as_deref(),
            Some(
                dir_form
                    .join(".kimi-plugin")
                    .join("plugin.json")
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert!(parsed.shadowed_manifest_path.is_none());
        assert_eq!(
            parsed
                .manifest
                .as_ref()
                .and_then(|m| m.name.clone())
                .as_deref(),
            Some("dirform")
        );

        let both = temp.path().join("both");
        std::fs::create_dir_all(both.join(".kimi-plugin")).unwrap();
        std::fs::write(
            both.join("kimi.plugin.json"),
            r#"{"name":"winner","skills":"./skills/"}"#,
        )
        .unwrap();
        std::fs::write(
            both.join(".kimi-plugin").join("plugin.json"),
            r#"{"name":"loser"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(both.join("skills")).unwrap();
        let parsed = parse_plugin_manifest(&both);
        assert_eq!(parsed.manifest_kind.as_deref(), Some("kimi-plugin-root"));
        assert_eq!(
            parsed
                .manifest
                .as_ref()
                .and_then(|m| m.name.clone())
                .as_deref(),
            Some("winner"),
            "the root manifest wins"
        );
        // Reported rather than silently ignored: an author editing the file that
        // has no effect otherwise gets no signal at all.
        assert_eq!(
            parsed.shadowed_manifest_path.as_deref(),
            Some(
                both.join(".kimi-plugin")
                    .join("plugin.json")
                    .to_string_lossy()
                    .as_ref()
            )
        );

        let none = temp.path().join("none");
        std::fs::create_dir_all(&none).unwrap();
        let parsed = parse_plugin_manifest(&none);
        assert!(parsed.manifest.is_none());
        assert!(parsed.manifest_path.is_none());
        assert_eq!(parsed.diagnostics.len(), 1);
        assert_eq!(parsed.diagnostics[0].severity, "error");
        assert!(
            parsed.diagnostics[0].message.contains("No manifest at"),
            "{}",
            parsed.diagnostics[0].message
        );
    }

    /// A manifest is third-party content, so a declared path may not lead out of
    /// the plugin (v2 `resolveDirListField`'s containment check,
    /// `app/plugin/manifest.ts:194-201`). The fork resolved `skills` with
    /// `root.join(rel.trim_start_matches("./"))` and additionally accepted an
    /// absolute path outright, so a plugin could point the scan at any directory
    /// on the machine. Every drop is reported, because a missing skill root is
    /// otherwise indistinguishable from a plugin that never declared one.
    #[test]
    fn a_manifest_path_may_not_leave_the_plugin_and_every_drop_is_reported() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugin");
        let outside = temp.path().join("outside-skills");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(root.join("skills")).unwrap();
        std::fs::write(
            root.join("kimi.plugin.json"),
            r#"{
              "name": "escaper",
              "skills": ["./skills/", "./../outside-skills", "/etc", "skills-relative"]
            }"#,
        )
        .unwrap();

        let parsed = parse_plugin_manifest(&root);
        let skills = parsed
            .manifest
            .as_ref()
            .and_then(|m| m.skills.clone())
            .expect("skills");
        assert_eq!(
            skills.len(),
            1,
            "only the in-plugin root survives: {skills:?}"
        );
        let root_real = std::fs::canonicalize(&root).unwrap();
        assert_eq!(
            PathBuf::from(&skills[0]),
            without_verbatim_prefix(&std::fs::canonicalize(root_real.join("skills")).unwrap())
        );

        let messages: Vec<&str> = parsed
            .diagnostics
            .iter()
            .map(|d| d.message.as_str())
            .collect();
        // `./../outside-skills` passes the `./` rule and is caught by the
        // containment check — the case that actually matters, since it is the
        // one a prefix test would wave through.
        assert_eq!(
            messages
                .iter()
                .filter(|m| m.contains("resolves outside the plugin"))
                .count(),
            1,
            "{messages:?}"
        );
        // The other two are refused by the prefix rule before containment is
        // reached; the absolute one used to be accepted outright by the fork.
        assert_eq!(
            messages
                .iter()
                .filter(|m| m.contains("must start with \"./\""))
                .count(),
            2,
            "{messages:?}"
        );
    }

    /// A sibling directory whose name merely starts with the plugin's is not
    /// inside it (`isWithin` is component-wise, `manifest.ts:552-555`), so
    /// `../plugin-evil` cannot pass as `plugin`.
    #[test]
    fn containment_is_component_wise_not_a_prefix_match() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugin");
        let sibling = temp.path().join("plugin-evil");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("kimi.plugin.json"),
            r#"{"name":"c","skills":"../plugin-evil/"}"#,
        )
        .unwrap();

        let parsed = parse_plugin_manifest(&root);
        assert!(
            parsed
                .manifest
                .as_ref()
                .and_then(|m| m.skills.as_ref())
                .is_none_or(Vec::is_empty),
            "a sibling sharing the name prefix is outside: {:?}",
            parsed.manifest.as_ref().and_then(|m| m.skills.clone())
        );
        assert!(
            parsed
                .diagnostics
                .iter()
                .any(|d| d.message.contains("must start with")),
            "{:?}",
            parsed.diagnostics
        );
    }

    /// The panel's manifest-derived lines read these fields, and the engine sent
    /// none of them: `keywords` and `sessionStart` were not even parsed, and
    /// `skills` reached the host as whatever shape the JSON had — a single
    /// string, which the panel then iterated character by character.
    #[test]
    fn the_manifest_reaches_the_host_in_the_shape_the_panel_reads() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugin");
        std::fs::create_dir_all(root.join("skills")).unwrap();
        std::fs::write(
            root.join("kimi.plugin.json"),
            r#"{
              "name": "brandpack",
              "version": "1.2.0",
              "description": "House style",
              "keywords": ["brand", "voice"],
              "author": "Moonshot AI",
              "license": "MIT",
              "homepage": "https://example.test/brandpack",
              "skills": "./skills/",
              "sessionStart": { "skill": "brandpack.onboard" },
              "skillInstructions": "Answer in the house voice.",
              "interface": {
                "displayName": "Brand Pack",
                "shortDescription": "Keeps the house voice.",
                "developerName": "Example",
                "websiteURL": "https://example.test"
              }
            }"#,
        )
        .unwrap();

        let parsed = parse_plugin_manifest(&root);
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let manifest = parsed.manifest.expect("manifest");

        // A bare string author is v2's `{ name }` shorthand (`readAuthor`), which
        // is the form the bundled plugins use.
        assert_eq!(
            manifest.author.as_ref().and_then(|a| a.name.as_deref()),
            Some("Moonshot AI")
        );
        assert_eq!(
            manifest.keywords.as_deref(),
            Some(["brand".to_string(), "voice".to_string()].as_slice())
        );
        assert_eq!(
            manifest.session_start.as_ref().map(|s| s.skill.as_str()),
            Some("brandpack.onboard")
        );
        assert_eq!(manifest.license.as_deref(), Some("MIT"));
        assert_eq!(
            manifest.homepage.as_deref(),
            Some("https://example.test/brandpack")
        );
        assert_eq!(
            manifest
                .interface
                .as_ref()
                .and_then(|i| i.short_description.as_deref()),
            Some("Keeps the house voice.")
        );
        // A list, always: the panel iterates this, and a bare string would have
        // produced one line per character.
        let skills = manifest.skills.as_deref().expect("skills list");
        assert_eq!(skills.len(), 1);
        assert!(skills[0].ends_with("skills"), "{}", skills[0]);

        // And the serialized wire is what the host parses.
        let json = serde_json::to_value(&manifest).unwrap();
        assert_eq!(json["sessionStart"]["skill"], "brandpack.onboard");
        assert_eq!(json["skillInstructions"], "Answer in the house voice.");
        assert!(json["skills"].is_array());
        assert_eq!(json["interface"]["developerName"], "Example");
    }

    #[test]
    fn a_node_runner_rewrites_node_plugin_servers_onto_the_host_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let marketplace = temp.path();
        let root = marketplace.join("official/demo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            marketplace.join("marketplace.json"),
            r#"{"version":"1","plugins":[{"id":"demo","tier":"official","displayName":"Demo","description":"A demo","source":"./official/demo"}]}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("kimi.plugin.json"),
            r#"{
              "name": "demo",
              "mcpServers": {
                "data": { "command": "node", "args": ["./bin/server.mjs", "--port", "7"], "env": { "TOKEN": "x" } },
                "native": { "command": "./bin/daemon", "args": ["serve"] },
                "remote": { "url": "https://example.test/mcp" }
              }
            }"#,
        )
        .unwrap();

        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let pm = PluginManager::new(store)
            .with_marketplace_dir(Some(marketplace.to_path_buf()))
            .with_node_runner(Some(temp.path().join("kimi")));
        pm.install_plugin("demo").unwrap().expect("catalogued");

        let configs = pm.plugin_mcp_configs();
        let data = configs
            .iter()
            .find(|config| config.name == "demo__data")
            .expect("data");
        // `node` + its entry arg are folded into the host's hidden sub-command;
        // the rest of the argument vector and the env pass through unchanged,
        // and the plugin root rides KIMI_PLUGIN_ROOT.
        assert_eq!(
            data.command.as_deref(),
            Some(temp.path().join("kimi").to_string_lossy().as_ref())
        );
        assert_eq!(
            data.args,
            vec!["__plugin_run_node", "./bin/server.mjs", "--port", "7"]
        );
        assert_eq!(
            data.env.get("KIMI_PLUGIN_ROOT").map(String::as_str),
            Some(root.to_string_lossy().as_ref())
        );
        assert_eq!(data.env.get("TOKEN").map(String::as_str), Some("x"));
        // A non-node command is left un-rewritten (its `./` path still
        // resolves against the plugin root, as always).
        let native = configs
            .iter()
            .find(|config| config.name == "demo__native")
            .expect("native");
        assert_eq!(
            native.command.as_deref(),
            Some(resolve_dir_against(&root, "./bin/daemon").as_str())
        );
        assert_eq!(native.args, vec!["serve"]);
        assert!(!native.env.contains_key("KIMI_PLUGIN_ROOT"));
    }

    #[test]
    fn a_remote_install_lands_in_the_managed_root() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let marketplace = temp.path().join("marketplace");
        std::fs::create_dir_all(&marketplace).unwrap();
        std::fs::write(
            marketplace.join("marketplace.json"),
            r#"{"version":"1","plugins":[{"id":"demo","tier":"curated","displayName":"Demo","description":"A demo","source":"https://github.com/example/demo"}]}"#,
        )
        .unwrap();

        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let pm = PluginManager::new(store)
            .with_marketplace_dir(Some(marketplace))
            .with_home_dir(Some(home.clone()));

        // The managed root is where a remote install would land, and it wins
        // over the catalog source once it holds a manifest.
        let managed = pm.managed_root("demo").expect("home is set");
        assert_eq!(managed, home.join("plugins").join("demo"));
        assert!(pm.plugin_root("demo").is_none());

        std::fs::create_dir_all(&managed).unwrap();
        std::fs::write(managed.join("kimi.plugin.json"), r#"{"name":"demo"}"#).unwrap();
        assert_eq!(pm.plugin_root("demo"), Some(managed.clone()));

        // A local path that is not catalogued installs under its manifest name,
        // never the path string, and stays resolvable to the directory the user
        // pointed at.
        let local = temp.path().join("local-plugin");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::write(
            local.join("kimi.plugin.json"),
            r#"{"name":"local","version":"2.1.0"}"#,
        )
        .unwrap();
        let installed = pm
            .install_plugin_from(local.to_str().unwrap())
            .unwrap()
            .expect("a local manifest installs");
        assert_eq!(
            installed.0, "local",
            "keyed by the manifest name, not the path"
        );
        assert_eq!(installed.1.version.as_deref(), Some("2.1.0"));
        assert_eq!(pm.plugin_root("local"), Some(local.clone()));
        assert!(pm.install_plugin_from("no-such-plugin").unwrap().is_none());
    }

    /// A catalogued plugin whose `source` is a URL is remote even when it is
    /// installed by its catalog id: the install has to fetch the archive, not
    /// just record a row. The loopback source is refused by the SSRF guard, so
    /// the refusal proves the download path was entered.
    #[test]
    fn a_catalogued_url_source_downloads_when_installed_by_id() {
        let temp = tempfile::tempdir().unwrap();
        let marketplace = temp.path().join("marketplace");
        std::fs::create_dir_all(&marketplace).unwrap();
        std::fs::write(
            marketplace.join("marketplace.json"),
            r#"{"plugins":[{"id":"remote-demo","displayName":"Remote Demo","source":"http://127.0.0.1:9/plugin.zip"}]}"#,
        )
        .unwrap();

        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let pm = PluginManager::new(store)
            .with_marketplace_dir(Some(marketplace))
            .with_home_dir(Some(temp.path().join("home")));

        let error = pm
            .install_plugin_from("remote-demo")
            .expect_err("a refused download is not a successful install");
        assert!(error.contains("private"), "unexpected error: {error}");
        assert!(
            pm.list_plugins().is_empty(),
            "a refused download must not record an install"
        );
    }

    #[test]
    fn an_uncatalogued_local_path_never_installs_as_a_path_shaped_id() {
        let temp = tempfile::tempdir().unwrap();
        let marketplace = temp.path().join("marketplace");
        std::fs::create_dir_all(&marketplace).unwrap();
        std::fs::write(marketplace.join("marketplace.json"), r#"{"plugins":[]}"#).unwrap();

        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let pm = PluginManager::new(store)
            .with_marketplace_dir(Some(marketplace))
            .with_home_dir(Some(temp.path().join("home")));

        let local = temp.path().join("standalone");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::write(local.join("kimi.plugin.json"), r#"{"name":"standalone"}"#).unwrap();

        let (id, _) = pm
            .install_plugin_from(local.to_str().unwrap())
            .unwrap()
            .expect("the manifest identifies it");
        assert_eq!(id, "standalone");
        // The id is a real key: every later call resolves through it.
        let ids: Vec<String> = pm.list_plugins().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["standalone".to_string()]);
        assert_eq!(pm.plugin_root(&id), Some(local));

        // A directory with no manifest is not installable, so a bogus path can
        // never record an install.
        let bare = temp.path().join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        assert!(
            pm.install_plugin_from(bare.to_str().unwrap())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn removing_a_plugin_also_drops_its_managed_copy() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let marketplace = temp.path().join("marketplace");
        std::fs::create_dir_all(marketplace.join("official/demo")).unwrap();
        std::fs::write(
            marketplace.join("marketplace.json"),
            r#"{"version":"1","plugins":[{"id":"demo","tier":"official","displayName":"Demo","source":"./official/demo"}]}"#,
        )
        .unwrap();
        std::fs::write(
            marketplace.join("official/demo/kimi.plugin.json"),
            r#"{"name":"demo"}"#,
        )
        .unwrap();

        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let pm = PluginManager::new(store)
            .with_marketplace_dir(Some(marketplace))
            .with_home_dir(Some(home.clone()));

        // A remote install is the case that lands a copy under `<home>/plugins`.
        let managed = home.join("plugins").join("demo");
        std::fs::create_dir_all(&managed).unwrap();
        std::fs::write(managed.join("kimi.plugin.json"), r#"{"name":"demo"}"#).unwrap();
        pm.install_plugin_from("demo")
            .unwrap()
            .expect("the catalog identifies it");
        assert_eq!(pm.plugin_root("demo"), Some(managed.clone()));

        assert!(pm.remove_plugin("demo").unwrap());
        assert!(
            !managed.exists(),
            "the managed copy is gone, so a removed plugin cannot keep contributing"
        );
        // The catalog still declares it, but nothing is installed.
        assert!(pm.list_plugins().is_empty());
    }

    #[test]
    fn managed_roots_refuse_ids_that_are_not_a_single_path_segment() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let pm = PluginManager::new(store).with_home_dir(Some(temp.path().to_path_buf()));

        assert!(pm.managed_root("demo").is_some());
        for id in ["..", ".", "", "a/b", "a\\b", "C:\\Windows", "../escape"] {
            assert!(
                pm.managed_root(id).is_none(),
                "{id:?} must not resolve to a managed directory"
            );
        }
    }
}
