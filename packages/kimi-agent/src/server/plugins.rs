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

    /// Enable or disable a plugin.
    pub fn set_plugin_enabled(&self, id: &str, enabled: bool) -> Result<(), rusqlite::Error> {
        let mut installed = self.load_installed_map();
        let current = installed
            .entry(id.to_string())
            .or_insert_with(|| InstalledPluginInfo {
                enabled,
                version: Some("1.0.0".into()),
            });
        current.enabled = enabled;
        self.save_installed_map(&installed)
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

        let ds = list.iter().find(|p| p.id == "kimi-datasource").expect("kimi-datasource");
        assert_eq!(ds.tier, "official");
        assert_eq!(ds.display_name, "Kimi Datasource");
        assert_eq!(ds.version.as_deref(), Some("3.4.0"));
        assert_eq!(ds.source, "./official/kimi-datasource");
        assert_eq!(ds.keywords.as_ref().unwrap(), &vec!["data", "mcp"]);

        let wb = list.iter().find(|p| p.id == "kimi-webbridge").expect("kimi-webbridge");
        assert_eq!(wb.tier, "official");
        assert_eq!(wb.display_name, "Kimi WebBridge");
        assert_eq!(wb.version.as_deref(), Some("1.11.3"));
        assert_eq!(wb.source, "./official/kimi-webbridge");

        let sp = list.iter().find(|p| p.id == "superpowers").expect("superpowers");
        assert_eq!(sp.tier, "curated");
        assert_eq!(sp.display_name, "Superpowers");
        assert_eq!(sp.homepage.as_deref(), Some("https://github.com/obra/superpowers"));
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
        std::fs::write(plugins_dir.join("marketplace.json"), custom_catalog.to_string()).unwrap();

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

        // 1. Enable multiple plugins (one official, one custom third-party)
        pm.set_plugin_enabled("kimi-webbridge", true).unwrap();
        pm.set_plugin_enabled("custom-plugin-x", true).unwrap();

        // Must be sorted alphabetically by id
        let list1 = pm.list_plugins();
        assert_eq!(list1.len(), 2);
        assert_eq!(list1[0].id, "custom-plugin-x");
        assert_eq!(list1[0].name, "custom-plugin-x");
        assert_eq!(list1[0].source, "plugin:custom-plugin-x");
        assert!(list1[0].enabled);

        assert_eq!(list1[1].id, "kimi-webbridge");
        assert_eq!(list1[1].name, "Kimi WebBridge");
        assert!(list1[1].enabled);

        // 2. Disable plugin
        pm.set_plugin_enabled("kimi-webbridge", false).unwrap();
        let list2 = pm.list_plugins();
        assert_eq!(list2.len(), 2);
        let wb = list2.iter().find(|p| p.id == "kimi-webbridge").unwrap();
        assert!(!wb.enabled);

        // 3. Marketplace merge status
        let market = pm.list_marketplace();
        let wb_market = market.iter().find(|p| p.id == "kimi-webbridge").unwrap();
        assert_eq!(wb_market.installed.as_ref().map(|i| i.enabled), Some(false));

        // 4. Persistence across fresh PluginManager instance with the same store
        let pm_fresh = PluginManager::new(store);
        let list_persisted = pm_fresh.list_plugins();
        assert_eq!(list_persisted.len(), 2);

        // 5. Remove plugin
        let removed = pm_fresh.remove_plugin("kimi-webbridge").unwrap();
        assert!(removed);
        let list3 = pm_fresh.list_plugins();
        assert_eq!(list3.len(), 1);
        assert_eq!(list3[0].id, "custom-plugin-x");

        // Remove non-existent plugin returns false
        let removed_missing = pm_fresh.remove_plugin("non-existent").unwrap();
        assert!(!removed_missing);
    }
}
