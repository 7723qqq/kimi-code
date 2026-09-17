---
'@moonshot-ai/kimi-code': minor
'@moonshot-ai/kimi-code-sdk': minor
---

Installed plugins now actually contribute, and a plugin whose catalog `source` is a URL can be installed.

**Content.** An enabled plugin's `skills` directories join the engine's skill scan, and its `mcpServers` join the session's MCP connection set — namespaced `<pluginId>__<server>` so two plugins can declare the same server name, and skipped when the user disabled that server for that plugin. Before this, both were read by nothing: the two official plugins (`kimi-webbridge` ships skills, `kimi-datasource` ships an MCP server) installed and then did nothing.

**Remote install.** A catalog `source` that is a GitHub repository or a zip URL is now downloaded, extracted, and copied into `<data_dir>/plugins/<id>`, which then wins over the catalog source when resolving the plugin root. The download reuses the FetchUrl SSRF guard — every hop is resolved, checked against the private-address rules, and pinned, so a rebinding host cannot swap the address between the check and the connect. Extraction refuses any entry that would escape the destination, and the previous install is only removed once the new one is in place, so a failed install leaves the old copy intact.

A catalogued plugin whose `source` is a URL is remote even when it is installed by its catalog id, so both install surfaces — `POST /api/v1/plugins` and the SDK's `installPlugin` — fetch the archive rather than recording a row with nothing behind it.

A plugin installed this way has no marketplace catalog entry, so its `name`, `version`, and `description` are read from the plugin's own manifest instead of falling back to the id and a placeholder version.
