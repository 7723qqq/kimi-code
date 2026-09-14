//! Plugin catalog, marketplace, and state management for the native HTTP server.
//!
//! Mirrors kap-server's `IPluginService` and `/api/v1/plugins` REST surface.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

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
}

/// Entry shape for `/api/v1/plugins`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub description: String,
    pub source: String,
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

    let parsed: Value =
        serde_json::from_str(&catalog_str).unwrap_or_else(|_| json!({ "plugins": [] }));
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

/// Manage installed plugin states in SqliteSessionStore under `plugins/registry`.
pub struct PluginManager {
    store: Arc<SqliteSessionStore>,
}

impl PluginManager {
    pub fn new(store: Arc<SqliteSessionStore>) -> Self {
        Self { store }
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

    /// List all installed plugin summaries for `/api/v1/plugins`.
    pub fn list_plugins(&self) -> Vec<PluginSummary> {
        let installed = self.load_installed_map();
        let marketplace = load_marketplace(None);
        let mut out = Vec::new();

        for (id, info) in installed {
            let meta = marketplace.iter().find(|m| m.id == id);
            let name = meta
                .map(|m| m.display_name.clone())
                .unwrap_or_else(|| id.clone());
            let version = info
                .version
                .clone()
                .or_else(|| meta.and_then(|m| m.version.clone()))
                .unwrap_or_else(|| "1.0.0".into());
            let description = meta.map(|m| m.description.clone()).unwrap_or_default();
            let source = meta
                .map(|m| m.source.clone())
                .unwrap_or_else(|| format!("plugin:{id}"));

            out.push(PluginSummary {
                id,
                name,
                version,
                enabled: info.enabled,
                description,
                source,
            });
        }

        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    /// List marketplace entries merged with live install states for `/api/v1/plugins/marketplace`.
    pub fn list_marketplace(&self) -> Vec<PluginMarketplaceEntry> {
        let installed = self.load_installed_map();
        let mut entries = load_marketplace(None);

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
    pub fn install_plugin(
        &self,
        id: &str,
    ) -> Result<Option<InstalledPluginInfo>, rusqlite::Error> {
        let marketplace = load_marketplace(None);
        let known = marketplace.iter().find(|m| m.id == id);
        let mut installed = self.load_installed_map();
        let existing = installed.get(id).cloned();

        if known.is_none() && existing.is_none() {
            return Ok(None);
        }

        let info = InstalledPluginInfo {
            enabled: existing.as_ref().map(|e| e.enabled).unwrap_or(true),
            version: existing
                .and_then(|e| e.version)
                .or_else(|| known.and_then(|m| m.version.clone())),
        };
        installed.insert(id.to_string(), info.clone());
        self.save_installed_map(&installed)?;
        Ok(Some(info))
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
                let marketplace = load_marketplace(None);
                let Some(entry) = marketplace.iter().find(|m| m.id == id) else {
                    return Ok(false);
                };
                installed.insert(
                    id.to_string(),
                    InstalledPluginInfo {
                        enabled,
                        version: entry.version.clone(),
                    },
                );
                self.save_installed_map(&installed)?;
                Ok(true)
            }
        }
    }

    /// Remove an installed plugin.
    pub fn remove_plugin(&self, id: &str) -> Result<bool, rusqlite::Error> {
        let mut installed = self.load_installed_map();
        let existed = installed.remove(id).is_some();
        if existed {
            self.save_installed_map(&installed)?;
        }
        Ok(existed)
    }
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
}
