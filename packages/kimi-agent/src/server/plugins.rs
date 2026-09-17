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
    pub source: String,
    pub state: String,
    pub skill_count: usize,
    pub mcp_server_count: usize,
    pub enabled_mcp_server_count: usize,
    pub command_count: usize,
    pub hook_count: usize,
    pub has_errors: bool,
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

/// The subset of `kimi.plugin.json` the engine reads. Unknown fields are
/// ignored, so a manifest written for a newer host still loads.
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
    pub author: Option<String>,
    /// `"./skills/"` or `["./a/", "./b/"]`.
    #[serde(default)]
    pub skills: Option<Value>,
    #[serde(default)]
    pub mcp_servers: Option<Value>,
    #[serde(default)]
    pub commands: Option<Vec<PluginCommandEntry>>,
    #[serde(default)]
    pub hooks: Option<Vec<Value>>,
    #[serde(default)]
    pub interface: Option<Value>,
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
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_path: Option<String>,
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

/// Read `kimi.plugin.json` from a plugin root. `None` when the file is absent
/// or unparseable — a plugin without a manifest contributes nothing.
pub fn read_plugin_manifest(root: &Path) -> Option<PluginManifest> {
    let raw = std::fs::read_to_string(root.join("kimi.plugin.json")).ok()?;
    serde_json::from_str(&raw).ok()
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
                .or_else(|| known.and_then(|entry| entry.version))
                .or(local_version),
            root: existing
                .as_ref()
                .and_then(|entry| entry.root.clone())
                .or(local_root),
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

    /// The skill roots the enabled plugins declare, in plugin-id order. A
    /// manifest `skills` value is a single path or a list; each resolves
    /// against the plugin root, and a path that is not a directory is dropped
    /// so a stale manifest cannot widen the scan.
    pub fn plugin_skill_dirs(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for id in self.enabled_ids() {
            let Some(root) = self.plugin_root(&id) else {
                continue;
            };
            let Some(manifest) = read_plugin_manifest(&root) else {
                continue;
            };
            for rel in manifest_paths(manifest.skills.as_ref()) {
                let dir = if Path::new(&rel).is_absolute() {
                    PathBuf::from(&rel)
                } else {
                    root.join(rel.trim_start_matches("./"))
                };
                if dir.is_dir() {
                    out.push(dir);
                }
            }
        }
        out
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
                out.push(PluginMcpConfig {
                    name: format!("{id}__{name}"),
                    transport,
                    command: config
                        .get("command")
                        .and_then(|value| value.as_str())
                        .map(|command| resolve_command_against(&root, command)),
                    args: config
                        .get("args")
                        .and_then(|value| value.as_array())
                        .map(|list| {
                            list.iter()
                                .filter_map(|value| value.as_str().map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                    env: string_map(config.get("env")),
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
        let manifest = root.as_deref().and_then(read_plugin_manifest);

        let commands = self.plugin_commands(id);
        let mcp_servers = self.plugin_mcp_servers(id);
        let skill_count = manifest
            .as_ref()
            .and_then(|manifest| manifest.skills.as_ref())
            .map(count_manifest_paths)
            .unwrap_or(0);
        let hook_count = manifest
            .as_ref()
            .and_then(|manifest| manifest.hooks.as_ref())
            .map(Vec::len)
            .unwrap_or(0);

        Some(PluginInfo {
            id: id.to_string(),
            name: meta
                .map(|entry| entry.display_name.clone())
                .or_else(|| manifest.as_ref().and_then(|manifest| manifest.name.clone()))
                .unwrap_or_else(|| id.to_string()),
            display_name: meta
                .map(|entry| entry.display_name.clone())
                .or_else(|| manifest.as_ref().and_then(|manifest| manifest.name.clone()))
                .unwrap_or_else(|| id.to_string()),
            description: meta
                .map(|entry| entry.description.clone())
                .or_else(|| {
                    manifest
                        .as_ref()
                        .and_then(|manifest| manifest.description.clone())
                })
                .unwrap_or_default(),
            version: info
                .version
                .clone()
                .or_else(|| meta.and_then(|entry| entry.version.clone()))
                .or_else(|| {
                    manifest
                        .as_ref()
                        .and_then(|manifest| manifest.version.clone())
                })
                .unwrap_or_else(|| "1.0.0".into()),
            enabled: info.enabled,
            state: if root.is_some() { "ok" } else { "remote" }.to_string(),
            source: meta
                .map(|entry| entry.source.clone())
                .unwrap_or_else(|| format!("plugin:{id}")),
            root: root
                .as_ref()
                .map(|path| path.to_string_lossy().replace('\\', "/")),
            manifest_path: root.as_ref().map(|path| {
                path.join("kimi.plugin.json")
                    .to_string_lossy()
                    .replace('\\', "/")
            }),
            command_count: commands.len(),
            mcp_server_count: mcp_servers.len(),
            enabled_mcp_server_count: mcp_servers.iter().filter(|server| server.enabled).count(),
            skill_count,
            hook_count,
            has_errors: manifest.is_none() && root.is_some(),
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

/// The paths a manifest `skills` value names: a single string or a list.
fn manifest_paths(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(path)) => vec![path.clone()],
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(|entry| entry.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

/// Count the entries a manifest `skills` value names.
fn count_manifest_paths(value: &Value) -> usize {
    manifest_paths(Some(value)).len()
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

    #[test]
    fn plugin_commands_and_info_read_the_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let marketplace = temp.path();
        let root = marketplace.join("official/demo");
        std::fs::create_dir_all(root.join("commands")).unwrap();
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
        assert_eq!(pm.plugin_skill_dirs(), vec![root.join("skills")]);

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
