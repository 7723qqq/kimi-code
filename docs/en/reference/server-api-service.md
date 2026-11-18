# Service and configuration endpoints

This page lists the endpoints for server information, login and usage, Remote Control, configuration, models and providers, skills and MCP, capabilities and plugins, workspaces, file uploads, GUI storage, global search, and MCP management. Shared conventions are in [Server API](./server-api.md).

## Server and metadata

| Method and path | Description |
| --- | --- |
| `GET /api/v1/healthz` | Liveness probe; auth-exempt |
| `GET /api/v1/meta` | Server version, capability map, `server_id`, experimental flags |
| `POST /api/v1/shutdown` | Graceful shutdown (replies 200 first); mounted only on loopback binds |

### `GET /api/v1/healthz`

Liveness probe for scripts and process supervisors. It is the one `/api` endpoint exempt from the bearer token (see [Authentication](./server-api.md#authentication)) and answers without touching config or the engine.

On success, `data` is `{ "ok": true }`.

### `GET /api/v1/meta`

Returns this instance's identity and capability map. Most fields are frozen at boot; `experimental_flags` and `features` are resolved per request, so a flag flip or a failed feature shows up in the next response.

On success, `data` carries:

| Field | Type | Description |
| --- | --- | --- |
| `server_version` | string | Server version |
| `capabilities` | object | Capability map — `websocket`, `file_upload`, `fs_query`, `mcp`, all always `true` |
| `server_id` | string | Unique id of this server instance |
| `started_at` | string | Boot time, ISO 8601 |
| `open_in_apps` | array | Host apps usable as `open-in` targets (`finder` / `cursor` / `vscode` / `iterm` / `terminal`); currently always empty |
| `dangerous_bypass_auth` | boolean | Whether the server was started with `--dangerous-bypass-auth` (clients may skip the token prompt) |
| `backend` | string | Engine backend, `v1` or `v2`; always `v2` for this server |
| `web_title` | string | Custom browser tab title from `--web-title`; omitted when unset |
| `experimental_flags` | object | Experimental flag id → enabled, resolved at request time |
| `features` | array | Engine features as `{ name, state, meta }`; `state` is `Pending` / `Activating` / `Active` / `Unloading` / `Failed` |

### `POST /api/v1/shutdown`

Asks the server to shut down gracefully. The reply is sent first and the shutdown runs immediately after, so the caller can trust the response it received. The route is mounted only on loopback binds — on a non-loopback bind it is not registered at all (requests hit a 404) unless the server was started with `--allow-remote-shutdown`.

On success, `data` is `{ "ok": true }`.

## Login and usage

These endpoints drive the managed Kimi OAuth login lifecycle and expose account-level information. The managed provider is named `managed:kimi-code`; the optional `provider` parameter on every endpoint below defaults to it.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/auth` | Auth snapshot |
| `POST /api/v1/oauth/login` | Start the OAuth device-code login flow |
| `GET /api/v1/oauth/login` | Poll the login flow state |
| `DELETE /api/v1/oauth/login` | Cancel a pending login flow |
| `POST /api/v1/oauth/logout` | Log out the managed provider |
| `GET /api/v1/oauth/usage` | Plan quota and booster wallet |
| `GET /api/v1/oauth/userinfo` | Account profile |
| `GET /api/v1/oauth/region` | Resolve the client region (`mainland-cn` / `global`) |

### `GET /api/v1/auth`

Auth snapshot: whether the default model resolves to a usable provider configuration, plus the managed provider's login state. `models_ready` is `true` when the global `default_model` alias exists in the model table and resolves to a configured provider — including providerless flat models carrying their own `base_url` and models injected through `KIMI_MODEL_*` environment variables. It does not verify credentials, so a prompt can still fail afterwards with `40111` / `40112`.

On success, `data` carries `models_ready` (boolean), `providers_count` (number of configured providers), and `managed_provider` (`null`, or `{ name, status }` with `status` one of `authenticated` / `expired` / `revoked` / `unauthenticated`). The global default model alias itself is read from `GET /api/v1/config` (`default_model`), not from this endpoint.

### `POST /api/v1/oauth/login`

Starts an OAuth device-code login flow for the managed provider; starting a new flow aborts any pending flow for the same provider. When the account is already authenticated, no user interaction is needed and the response reports `authenticated` immediately.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | body | string | Managed provider name. Default `managed:kimi-code` |
| `region` | body | string | `mainland-cn` or `global`; overrides the region resolution described under `GET /api/v1/oauth/region` for this flow |

On success, `data` has one of two shapes. A pending flow — `{ flow_id, provider, status: "pending", verification_uri, verification_uri_complete, user_code, expires_in, interval, expires_at }`: open `verification_uri_complete` (or `verification_uri` and enter `user_code`), then poll `GET /api/v1/oauth/login` every `interval` seconds until the flow resolves or `expires_at` passes (`expires_in` is the same deadline in seconds). The already-authenticated fast path — `{ flow_id, provider, status: "authenticated" }`.

### `GET /api/v1/oauth/login`

Polls the login flow state for a provider. Returns `null` when no flow has been started.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | query | string | Managed provider name. Default `managed:kimi-code` |

On success, `data` is `null` or a flow snapshot: `{ flow_id, provider, status, verification_uri, verification_uri_complete, user_code, expires_in, expires_at, interval }`, where `status` is `pending` / `authenticated` / `denied` / `expired` / `cancelled`. Once the flow leaves `pending`, `resolved_at` records when it reached its terminal state and `error_message` describes a failed flow.

### `DELETE /api/v1/oauth/login`

Cancels the pending login flow for a provider. When no flow is pending, the call is a no-op that reports the last known state.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | query | string | Managed provider name. Default `managed:kimi-code` |

On success, `data` is `{ cancelled, status }`: `cancelled` is `true` only when a `pending` flow was actually aborted, and `status` is the flow state after the call.

### `POST /api/v1/oauth/logout`

Logs out the managed provider: discards the stored OAuth credential, aborts any pending login flow, and removes the managed provider from the configuration. OAuth-managed providers reject manual edit and delete (see `PUT` / `DELETE /api/v1/providers/{provider_id}` below), so log out first to remove one.

For the default Kimi provider (`managed:kimi-code`), logout also tears down this machine's Remote Control and clears cached Remote Control cloud sessions. When no tunnel is running or another process hosts it, logout first deactivates this machine's device and holds the machine lock so no process on this machine can start Remote Control again until the credential is discarded; a cleanup failure aborts the logout. When this server hosts the tunnel, the credential is discarded first and the tunnel is torn down right after the response is flushed, so a logout sent through the Remote Control link still receives its response. Logging out any other provider leaves Remote Control untouched.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | body | string | Managed provider name. Default `managed:kimi-code` |

On success, `data` is `{ logged_out: true, provider }`.

### `GET /api/v1/oauth/usage`

Plan quota and booster wallet of the managed account, fetched live from the account service. An upstream failure does not fail the envelope — it comes back in-band with `kind: "error"`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | query | string | Managed provider name. Default `managed:kimi-code` |

On success, `data` is `{ kind: "ok", quota }` or `{ kind: "error", message, status? }`, where `status` is the upstream HTTP status when one exists. In the `ok` shape, `quota` is `{ usages, extraUsage }`: `usages` carries one `{ usedRatio, resetAt? }` entry per quota window the account has — `limit5h`, `limit7d`, `monthTotal`, `monthCode` — with `usedRatio` as a 0–1 float and `resetAt` as an RFC3339 reset timestamp, and clients render whichever entries are present; `extraUsage` (nullable) is the pay-as-you-go wallet: `{ balanceCents, totalCents, monthlyChargeLimitEnabled, monthlyChargeLimitCents, monthlyUsedCents, currency }`.

### `GET /api/v1/oauth/userinfo`

Profile of the managed account, with the same in-band `kind: "error"` convention as `GET /api/v1/oauth/usage`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | query | string | Managed provider name. Default `managed:kimi-code` |

On success, `data` is `{ kind: "ok", userInfo }` or `{ kind: "error", message, status? }`. `userInfo` always carries `userId`, `nickname`, `status`, `region`, `userLevel`, `userLevelName`, `domain`, and `domainName`, and may add `globalId`, `bio`, `avatar`, `username`, `email`, `phone` (`{ countryCode, number }`), `createdTime`, and `lastLoginTime`.

### `GET /api/v1/oauth/region`

Resolves which Kimi region this client belongs to without probing over the network. An OAuth host pinned by environment or config wins first, then the configured OAuth key, then the install-channel marker in `<home>/region`.

When the client is logged out and none of those inputs decides, it infers the region from the device time zone and locale. A successful inference is cached in `<home>/region.json` and invalidated when the login state changes; raw signal values are not uploaded. Missing or conflicting signals fall back to `mainland-cn` for the current process without persisting that fallback, so the next start tries again. Set `KIMI_CODE_REGION_MARKER=off` to disable both the install-channel marker and local inference.

On success, `data` is `{ region }` with `region` one of `mainland-cn` / `global`.

## Remote Control

These endpoints manage the machine-wide Remote Control tunnel (see the [Remote Control guide](../guides/remote-control.md)) and the account's device registry. The tunnel state is per machine; the device registry is per account and lives in the cloud, so device endpoints require a Kimi login and proxy the relay with a server-side session — OAuth credentials never reach the caller.

### `GET /api/v1/remote-control`

Returns the current tunnel status. When the tunnel is off but another live process on this machine holds the single-instance lock, `data.conflict` carries that holder; the lock is re-inspected on every read, so a dead holder clears both `conflict` and the stored `error`.

On success, `data` is `{ enabled, state, url?, device_id?, device_name?, error?, conflict? }` with `state` one of `off` / `starting` / `on` / `stopping` and `conflict` as `{ pid, local_origin, device_id, url, started_at }`.

### `POST /api/v1/remote-control`

Starts or stops the tunnel.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `enabled` | body | boolean | `true` to start the tunnel, `false` to stop it |

On success, `data` is the same status object as `GET /api/v1/remote-control`. Starting while another live process on this machine holds the single-instance lock fails with `REMOTE_CONTROL_ALREADY_RUNNING` (40928), with the lock holder in `details` in the same shape as `conflict`.

### `GET /api/v1/remote-control/devices`

Lists the account's Remote Control devices from the cloud registry.

On success, `data` is `{ devices, max_devices? }`. Each device is `{ device_id, alias, status, platform, client_version, local_base_url, created_at, updated_at, last_remote_access_at }` with `status` one of `online` / `offline`.

### `PATCH /api/v1/remote-control/devices/{id}`

Renames a device.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | Device identifier |
| `alias` | body | string | New display name, trimmed; 1–50 characters |

Blank or over-long aliases fail with `VALIDATION_FAILED` before reaching the cloud. On success, `data` is `{ ok: true }`.

### `POST /api/v1/remote-control/devices/{id}/deactivate`

Takes a device offline in the cloud registry. Offline devices stay listed and do not consume the plan's device quota; a device comes back the next time it turns on Remote Control. When the target is this machine, the local tunnel is stopped first (an in-flight start is cancelled); the request then holds the machine lock while deactivating, so a concurrent enable cannot re-register the device behind a successful response. A holder that does not stop in time fails the request with `INTERNAL_ERROR` instead of reporting success.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | Device identifier |

On success, `data` is `{ ok: true }`.

### `DELETE /api/v1/remote-control/devices/{id}`

Removes a device from the cloud registry: it disappears from the device list and its tunnel, if still connected, is disconnected. Deactivating keeps an offline device listed; deleting removes it entirely. When the target is this machine, the local tunnel is stopped first and the machine lock is held while deleting, so the device cannot re-register behind a successful response.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | Device identifier |

On success, `data` is `{ ok: true }`.

## Config

| Method and path | Description |
| --- | --- |
| `GET /api/v1/config` | Read the global config (secret fields redacted) |
| `POST /api/v1/config` | Merge-patch the config; broadcasts `event.config.changed` |
| `POST /api/v1/client_configs` | Fetch a named client configuration controlled by the Kimi Code service |

### `GET /api/v1/config`

Returns the resolved global configuration — the effective result of `config.toml` plus overlays. Secrets are redacted: each provider reports only `has_api_key`, never the stored key.

On success, `data` is the config object; its fields mirror the top-level domains documented under [Top-level fields](../configuration/config-files.md#top-level-fields):

| Field | Type | Description |
| --- | --- | --- |
| `providers` | object | Map of provider id → `{ type, base_url?, default_model?, api_key_env?, has_api_key }` |
| `default_provider` | string | Global default provider id |
| `default_model` | string | Global default model alias |
| `models` | object | Map of model alias → model record |
| `thinking` | object | Default parameters for Thinking mode |
| `plan_mode` | boolean | Plan mode flag |
| `yolo` | boolean | Derived: `true` when `default_permission_mode` is `yolo` |
| `default_permission_mode` | string | Default permission mode for new sessions |
| `default_plan_mode` | boolean | Whether new sessions start in Plan mode |
| `permission` | object | Initial permission rules |
| `hooks` | array | Lifecycle hooks |
| `services` | object | Built-in external service configuration |
| `merge_all_available_skills` | boolean | Whether to merge Agent Skills from all available directories |
| `extra_skill_dirs` | array | Extra skill search directories |
| `loop_control` | object | Agent loop control parameters |
| `background` | object | Background task runtime parameters |
| `subagent` | object | Subagent configuration |
| `secondary_model` | object | Secondary model pool for subagents |
| `experimental` | object | Experimental flag id → enabled |
| `telemetry` | boolean | Whether anonymous telemetry is enabled |
| `auto_session_title` | boolean | Whether clients may automatically generate session titles |
| `mcp` | object | MCP server configuration |
| `image` | object | Image handling parameters |
| `model_catalog` | object | Model catalog source configuration |
| `builtin_product_skills` | object | Built-in product skill toggles |
| `extra_agent_dirs` | array | Extra agent profile search directories |
| `read` | object | Default `Read` tool parameters |
| `model_overrides` | object | Per-model overrides |
| `identity` | object | Agent identity configuration |
| `github` | object | GitHub integration configuration |
| `swarm` | object | Swarm mode configuration |
| `cron` | object | Scheduled task configuration |
| `token_counting` | object | Token-counting strategy |
| `operation_log` | object | Operation Log retention limits |
| `llm_requester` | object | LLM requester configuration |
| `task` | object | Task runtime configuration |
| `database` | object | Persistence backend configuration |
| `watch` | object | File-watch / hot-reload configuration |
| `disable_feedback_survey` | boolean | Whether the session rating prompt is turned off |
| `raw` | object | Raw parsed `config.toml` content, unmodeled fields included |

### `POST /api/v1/config`

Merge-patches the global configuration: each top-level domain in the body is deep-merged into that domain, and domains absent from the body are left untouched. Setting `yolo` to `true` is shorthand for `default_permission_mode: "yolo"`; a rejected patch (invalid value) returns `40001` with the underlying message. The `secondary_model` domain also accepts `null`, which removes the entire `[secondary_model]` section so subsequently spawned subagents inherit their caller's current model and thinking level.

Domains are written one at a time, in body order, so a multi-domain patch is not atomic. When one domain cannot be persisted — `config.toml` is unreadable or unparsable, the engine refuses to overwrite it, and no further domain is attempted — the response is `50003` instead of `40001`, and `msg` names both sides of the split: `... (applied: planMode, telemetry; failed: models)`. `applied` lists the camelCase domains already written to disk (the caller must decide whether to roll them back), `failed` names the domain whose write aborted. A `40001` therefore means the request itself was rejected before any write, while `50003` means the patch was valid but could not be fully persisted (fix `config.toml` and reload, then retry).

Every config change — a successful update through this endpoint, an external edit of `config.toml`, or a server-side write such as an OAuth login refresh — is broadcast as the global `event.config.changed` event. Changes inside a short window are merged into one event carrying the affected domain names in `changedFields` (camelCase config domains, for example `defaultModel`) and the full current config projection in `config` (same shape as the `GET /api/v1/config` response).

The body is a partial config object. An optional `raw` object may carry the same writable snake_case domains; it is validated and merged into those domains, not stored as a wrapper. Explicit top-level fields win over `raw` fields. All fields below are optional:

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `providers` | body | object | Map of provider id → provider table |
| `default_provider` | body | string | Global default provider id |
| `default_model` | body | string | Global default model alias |
| `models` | body | object | Map of model alias → model record |
| `thinking` | body | object | Default parameters for Thinking mode |
| `plan_mode` | body | boolean | Plan mode flag |
| `yolo` | body | boolean | `true` maps to `default_permission_mode: "yolo"`; `false` is ignored |
| `default_permission_mode` | body | string | `manual` / `yolo` / `auto` |
| `default_plan_mode` | body | boolean | Whether new sessions start in Plan mode |
| `permission` | body | object | Initial permission rules |
| `hooks` | body | array | Lifecycle hooks |
| `services` | body | object | Built-in external service configuration |
| `merge_all_available_skills` | body | boolean | Whether to merge Agent Skills from all available directories |
| `extra_skill_dirs` | body | array | Extra skill search directories |
| `loop_control` | body | object | Agent loop control parameters |
| `background` | body | object | Background task runtime parameters |
| `subagent` | body | object | Subagent configuration |
| `secondary_model` | body | object or null | Secondary model pool for subagents; `null` clears the section and restores caller-model inheritance |
| `experimental` | body | object | Experimental flag id → enabled |
| `telemetry` | body | boolean | Whether anonymous telemetry is enabled |
| `mcp` | body | object | MCP server configuration |
| `image` | body | object | Image handling parameters |
| `model_catalog` | body | object | Model catalog source configuration |
| `builtin_product_skills` | body | object | Built-in product skill toggles |
| `extra_agent_dirs` | body | array | Extra agent profile search directories |
| `read` | body | object | Default `Read` tool parameters |
| `model_overrides` | body | object | Per-model overrides |
| `identity` | body | object | Agent identity configuration |
| `github` | body | object | GitHub integration configuration |
| `swarm` | body | object | Swarm mode configuration |
| `cron` | body | object | Scheduled task configuration |
| `token_counting` | body | object | Token-counting strategy |
| `operation_log` | body | object | Operation Log retention limits |
| `llm_requester` | body | object | LLM requester configuration |
| `task` | body | object | Task runtime configuration |
| `database` | body | object | Persistence backend configuration |
| `watch` | body | object | File-watch / hot-reload configuration |
| `auto_session_title` | body | boolean | Whether clients may automatically generate session titles |
| `disable_feedback_survey` | body | boolean | Whether the session rating prompt is turned off |

Every key above is enumerated: an unknown top-level key is rejected with `40001` rather than silently dropped, so a misspelled domain is reported instead of reporting success. The `raw` wrapper follows the same domain validation; it does not allow unknown keys.

On success, `data` is the full updated config in the same shape as `GET /api/v1/config`.

### `POST /api/v1/client_configs`

Fetches a named client configuration that the Kimi Code service controls remotely — for example whether changing the model asks the user to confirm. The server fetches it from the Kimi Code service of the account's region, or from `KIMI_CODE_BASE_URL` when that is set, and normalizes it to the shape that name expects.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `name` | body | string | **Required.** `model_switch_confirm` is currently the only registered name |

On success, `data` is `{ name, config }`. `config` is `null` for any other name or when the fetch fails, so the client falls back to its built-in behavior. A fetched value never turns into `null`: fields that are missing or malformed take their off defaults, so a malformed `model_switch_confirm`, for example, comes back as `{ enable: false, rules: [] }` instead of failing.

## Models and providers

These endpoints manage the two halves of model configuration — the [providers](../configuration/providers.md) table and the model-alias table of `config.toml` — plus a server-proxied models.dev directory for one-shot imports. A model alias id is the exact configured alias key: aliases created through the provider-management endpoints take the form `provider_id/model` (for example `my-provider/kimi-for-coding`), while a bare model-table key such as `turbo` is used as-is; anywhere the API takes a `model_id`, including the global `default_model`, it means this alias id. An unsupported action on a `:{action}` route returns `40001`.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/models` | List configured model aliases |
| `POST /api/v1/models/{model_id}:set_default` | Set the global default model |
| `GET /api/v1/providers` | List providers |
| `POST /api/v1/providers` | Create a provider (201) |
| `GET /api/v1/providers/{provider_id}` | Read a provider (reveals the stored key) |
| `PUT /api/v1/providers/{provider_id}` | Replace a provider |
| `DELETE /api/v1/providers/{provider_id}` | Delete a provider (204) |
| `POST /api/v1/providers/{provider_id}:refresh` | Refresh one provider's model metadata |
| `POST /api/v1/providers:{action}` | Collection actions: `refresh` / `refresh_oauth` / `import_catalog` / `import_registry` |
| `GET /api/v1/catalog/providers` | Browse the models.dev directory (server-proxied) |
| `GET /api/v1/catalog/providers/{catalog_id}` | Read one directory entry |

### `GET /api/v1/models`

Lists every configured model alias across all providers.

On success, `data.items` is an array of `{ provider, model, display_name?, max_context_size, capabilities?, support_efforts?, default_effort?, upgrade? }`: `model` is the alias id (`provider_id/model` for provider-managed aliases, otherwise the bare key), `provider` the owning provider id, `max_context_size` the context window in tokens, and `capabilities` / `support_efforts` / `default_effort` describe capability flags and Thinking-mode effort support. For custom-registry models, `upgrade` may contain `{ model, migration_markdown, retirement_at? }` to guide users toward a replacement model; placeholders in `migration_markdown` are already replaced with the model ids.

### `POST /api/v1/models/{model_id}:set_default`

Sets the global `default_model` to an existing alias. `model_id` is the exact configured alias key — for a bare key like `turbo` the call is `POST /api/v1/models/turbo:set_default`; URL-encode the id when it contains `/`, as in `POST /api/v1/models/my-provider%2Fkimi-for-coding:set_default`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `model_id` | path | string | **Required.** The exact configured model alias key; URL-encode it when it contains `/` |

On success, `data` is `{ default_model, model }` — the alias now in effect and its catalog item (same shape as a `GET /api/v1/models` item).

- `40001`: malformed or unsupported action suffix in the path
- `40413`: no model alias with that id

### `GET /api/v1/providers`

Lists every configured provider with its credential and model-discovery state, without revealing any key. This is the provider item shape referenced by the other provider endpoints.

On success, `data.items` is an array of:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Provider id |
| `type` | string | Wire protocol: `kimi` / `openai` / `openai_responses` / `anthropic` / `bedrock` / `google-genai` / `vertexai` |
| `base_url` | string | API base URL, when set |
| `default_model` | string | The provider's default model alias, when set |
| `has_api_key` | boolean | Whether a credential is stored |
| `status` | string | `connected` when an API key or cached OAuth token exists, `unconfigured` otherwise (`error` is reserved in the schema) |
| `models` | array | The provider's model alias ids |

### `POST /api/v1/providers`

Creates a provider and its model aliases in one save; the reply is HTTP 201 with the standard envelope. When no global `default_model` is configured at all (fresh setup), it is seeded with the new provider's `default_model` (or first model); an existing default is never modified.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | body | string | **Required.** Provider id — letters, digits, `-`, `_`, and spaces; must start with a letter or digit |
| `type` | body | string | **Required.** Wire protocol: `kimi` / `openai` / `openai_responses` / `anthropic` / `bedrock` / `google-genai` / `vertexai` |
| `api_key` | body | string | API key, stored in `config.toml` |
| `base_url` | body | string | API base URL; must not contain an environment variable placeholder (`${...}`) |
| `default_model` | body | string | The provider's default model; must be one of `models[].model` |
| `models` | body | array | **Required.** At least one entry, no duplicate `model` values; entry shape below |

Each `models[]` entry declares one alias whose id becomes `id/model`:

| Field | Type | Description |
| --- | --- | --- |
| `model` | string | **Required.** Upstream model name |
| `max_context_size` | integer | **Required.** Context window in tokens, ≥ 1 |
| `display_name` | string | Display name |
| `capabilities` | array | Capability flags such as `thinking` or `image_in` |
| `protocol` | string | Wire-protocol override: `anthropic`, `openai`, or `openai_responses`; inferred from the model ID when omitted |
| `max_output_size` | integer | Max output tokens, ≥ 1 |
| `support_efforts` | array | Supported Thinking-mode effort levels |
| `adaptive_thinking` | boolean | Adaptive thinking toggle |

On success, `data` is the created provider item (same shape as a `GET /api/v1/providers` item).

- `40921`: a provider with this `id` already exists

### `GET /api/v1/providers/{provider_id}`

Reads one provider. Unlike the list route, the response reveals the stored `api_key` when one is set, so a local edit form can prefill — keep this in mind when exposing the port.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider_id` | path | string | **Required.** Provider id |

On success, `data` is the provider item plus `api_key` when a key is stored.

- `40412`: provider not found

### `PUT /api/v1/providers/{provider_id}`

Updates a provider in one save: `type` and the model list are rewritten; omitted `base_url` and `default_model` are preserved, while explicit `null` clears them, and the provider's aliases are rebuilt from `models` — aliases no longer listed disappear from `config.toml`, while other providers' aliases are untouched. `api_key` is tri-state: omitted keeps the stored key, `""` clears it, any other value replaces it. Beyond the `new_id` rename migration, the global default pointers are never modified.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider_id` | path | string | **Required.** Current provider id |
| `new_id` | body | string | Rename the provider; the providers key, model aliases, `default_provider`, a `default_model` pointing at an old alias, and the subagent secondary-model pool all migrate. Same id rules as `POST /api/v1/providers` |
| `type` | body | string | **Required.** Wire protocol: `kimi` / `openai` / `openai_responses` / `anthropic` / `bedrock` / `google-genai` / `vertexai` |
| `api_key` | body | string | Tri-state, see above |
| `base_url` | body | string | API base URL; must not contain an environment variable placeholder (`${...}`) |
| `default_model` | body | string | The provider's default model; must be one of `models[].model` |
| `models` | body | array | **Required.** At least one entry, no duplicate `model` values; same entry shape as `POST /api/v1/providers` |

On success, `data` is `{ provider }` with the saved provider item.

- `40001`: a renamed alias id would collide with another provider's alias
- `40003`: provider is OAuth-managed — log out via `POST /api/v1/oauth/logout` instead
- `40412`: provider not found
- `40921`: `new_id` is already taken

### `DELETE /api/v1/providers/{provider_id}`

Deletes a provider and all of its model aliases; the subagent secondary-model pool is cascaded. The global `default_provider` / `default_model` pointers are left untouched, even when they point at the deleted provider — they are the user's settings, not this endpoint's to garbage-collect.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider_id` | path | string | **Required.** Provider id |

On success the server answers 204 with no body — the status line itself reports the delete (see [Response envelope](./server-api.md#response-envelope)).

- `40003`: provider is OAuth-managed — log out via `POST /api/v1/oauth/logout` instead
- `40412`: provider not found

### `POST /api/v1/providers/{provider_id}:refresh`

Re-discovers one provider's model metadata from its upstream source and rewrites the provider's aliases. Providers with a static model source are reported `unchanged` without any network call. When at least one provider's aliases or managed model metadata changes, the server broadcasts the global `event.model_catalog.changed` event.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider_id` | path | string | **Required.** Provider id |

On success, `data` is a refresh report: `changed` is an array of `{ provider_id, provider_name, added, removed }` (added/removed alias counts), `unchanged` is an array of provider ids with no diff, and `failed` is an array of `{ provider, reason }`. When a refresh finds that the registry dropped the current default model and that model had declared an `upgrade` replacement, `data` also carries an optional `retired_default`: `{ from, to, from_display_name }` — the default model has been redirected to `to`, open sessions still bound to `from` have been moved to `to` as well, and `from_display_name` is the dropped model's display name for notices. The same field appears on the `event.model_catalog.changed` event.

- `40001`: malformed or unsupported action suffix in the path
- `40412`: provider not found

### `POST /api/v1/providers:refresh`

Refreshes model metadata for every provider. The body is optional and ignored.

On success, `data` is the same refresh report as `POST /api/v1/providers/{provider_id}:refresh` (`changed` / `unchanged` / `failed`).

### `POST /api/v1/providers:refresh_oauth`

Same refresh as `POST /api/v1/providers:refresh`, limited to OAuth-backed providers. The body is optional and ignored.

On success, `data` is the refresh report (`changed` / `unchanged` / `failed`).

### `POST /api/v1/providers:import_catalog`

Imports one models.dev directory entry as a configured provider; the reply is HTTP 201 with the standard envelope. The wire protocol and endpoint come from the catalog resolution, and every catalogued model is written as an alias. Importing an id that already exists is a refresh — the provider entry and its aliases are rewritten from the catalog, and an omitted `api_key` keeps the stored key. The global default pointers are never modified, except that `default_model` is seeded from the first imported model when none is configured at all.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `catalog_id` | body | string | **Required.** Directory entry id from `GET /api/v1/catalog/providers` |
| `id` | body | string | Override the catalog id as the local provider id. Same id rules as `POST /api/v1/providers` |
| `api_key` | body | string | API key for the imported provider |
| `base_url` | body | string | Override the catalog-resolved endpoint; required when the entry's `needs_base_url` is `true` |

On success, `data` is `{ provider, models_imported }` — the provider item and the number of aliases written.

- `40001`: `catalog_id` missing or another body validation failure
- `40003`: the target provider exists and is OAuth-managed
- `40004`: the entry cannot be imported (rejected, requires a `base_url`, has no importable models, or its id is unusable as a provider id)
- `40417`: no directory entry with that `catalog_id`
- `50004`: the models.dev directory is unavailable

### `POST /api/v1/providers:import_registry`

Imports a models.dev-shaped private registry — an `api.json` URL plus an optional Bearer key — as configured providers; the reply is HTTP 201 with the standard envelope. Every listed provider is written with a `source` record so scheduled refreshes rediscover it. Re-importing the same URL removes providers that disappeared upstream — the URL is the registry's stable identity, so rotating the key is safe. The global default pointers follow the same rules as `:import_catalog`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `url` | body | string | **Required.** URL of the registry's `api.json` |
| `api_key` | body | string | Bearer key for the registry; when omitted, the key from the previous import of the same URL is reused |

On success, `data` is `{ providers, models_imported }` — an array of provider items and the total number of aliases written.

- `40001`: `url` missing or another body validation failure
- `40003`: a listed provider exists and is OAuth-managed
- `40005`: the registry cannot be fetched or parsed, or lists no importable providers

### `GET /api/v1/catalog/providers`

Browses the models.dev directory, proxied by the server with a 10-minute in-memory cache and a built-in snapshot fallback. Items keep the upstream directory order. Entries the server cannot import carry `rejected: true` with a machine-readable `reject_reason`; entries with `needs_base_url: true` require a base URL at import time.

On success, `data.items` is an array of `{ id, name, wire_type, base_url, guessed, needs_base_url, rejected, reject_reason, env_key, models }`: `wire_type` is the resolved protocol (nullable, same enum as a provider `type`), `base_url` is the resolved endpoint (nullable; `null` for entries that need a base URL or were rejected), `guessed` marks a heuristic resolution, `env_key` is the upstream's conventional API-key environment variable (nullable), and `models` is an array of `{ id, name?, max_context_size, capabilities?, reasoning }`.

- `50004`: the directory is unavailable (both the live fetch and the built-in snapshot failed)

### `GET /api/v1/catalog/providers/{catalog_id}`

Reads one models.dev directory entry by catalog id — the same item shape as `GET /api/v1/catalog/providers`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `catalog_id` | path | string | **Required.** Directory entry id |

On success, `data` is the directory entry (same shape as a `GET /api/v1/catalog/providers` item).

- `40417`: no directory entry with that `catalog_id`
- `50004`: the directory is unavailable

## Skills, tools, and MCP

These endpoints expose the skill catalogs a session or workspace sees, the effective agent's tool list, and its MCP servers. Skill activation and MCP restart use the `:{action}` convention; activation is the REST analogue of the `/<skill>` slash command.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/skills` | Per-session skill catalog |
| `GET /api/v1/workspaces/{workspace_id}/skills` | Session-less skill catalog for a workspace |
| `POST /api/v1/sessions/{session_id}/skills/{skill_name}:activate` | Activate a skill (starts a turn) |
| `GET /api/v1/tools` | List tools of the effective agent |
| `GET /api/v1/mcp/servers` | List MCP servers |
| `POST /api/v1/mcp/servers/{mcp_server_id}:restart` | Restart an MCP server |

### `GET /api/v1/sessions/{session_id}/skills`

Lists the skills available to one session, merged from every source (built-in, plugin, extra, user, project) with the session's precedence applied. Reading the catalog resumes the session when it is cold.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |

On success, `data` is `{ skills }` where each item is a skill descriptor `{ name, description, path, source, workspace_dir?, type?, disable_model_invocation? }`: `source` is `project` / `user` / `extra` / `builtin`, `type` classifies the skill (only user-activatable types can be activated), and `disable_model_invocation` hides the skill from the model. `workspace_dir` is the project root for project skills and is omitted for other sources. Same-name skills can appear as multiple variants with distinct `path` values.

- `40401`: session not found (or not activated)

### `GET /api/v1/workspaces/{workspace_id}/skills`

Lists the skill catalog a session in this workspace would see, without creating or resuming a session — the same merge of built-in, plugin, extra, user, and project sources computed for the workspace root.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **Required.** Registered workspace id |

On success, `data` is `{ skills }` with the skill descriptor documented under `GET /api/v1/sessions/{session_id}/skills` above.

- `40410`: workspace not found

### `POST /api/v1/sessions/{session_id}/skills/{skill_name}:activate`

Activates a skill in the session — the REST analogue of the `/<skill>` slash command — starting a turn on the main agent with the skill's content plus `args` and attachments. The endpoint dispatches through one route, `POST /api/v1/sessions/{session_id}/skills/{tail}`: the tail is parsed as `{skill_name}:{action}`, `activate` is the only action, and a bare name or an unknown action fails `40001` (`unsupported action: ...`).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `skill_name` | path | string | **Required.** Name of the skill to activate |
| `path` | body | string | Optional exact `SKILL.md` path from the session catalog, used to select a same-name variant. Must match an entry returned by the catalog |
| `args` | body | string | Free-form arguments handed to the skill, like the text after a slash command |
| `attachments` | body | array | Media parts attached to the activation. Image and video parts carry a `source` object whose `kind` is `url` / `base64` / `file` / `session_media` (same shapes as the prompt content parts); file parts carry the top-level `file_id`, `name`, `media_type`, and `size` |

On success, `data` is `{ activated: true, skill_name }`.

- `40001`: validation failure or unsupported action suffix
- `40401`: session not found (or not activated)
- `40407`: a referenced attachment file does not exist
- `40415`: no skill with that name
- `40912`: the skill exists but its type cannot be activated by the user

### `GET /api/v1/tools`

Lists the tools of the effective agent — the main agent of the session given by `session_id`, or of the most recently created session when the parameter is omitted. When no such session is live in this server process, the list is empty.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | query | string | Session whose main agent to inspect. Default the most recently created session |

On success, `data` is `{ tools }` where each item is `{ name, description, input_schema, source, mcp_server_id?, active? }`: `source` is `builtin` / `skill` / `mcp`, `mcp_server_id` is set on MCP tools (parsed from the `mcp__<server>__<tool>` name), and `active` reports the tool policy's verdict. `input_schema` is currently always `null`.

### `GET /api/v1/mcp/servers`

Lists the MCP servers configured for the effective agent (the most recently created live session's main agent, as in `GET /api/v1/tools`). With no live session, the list is empty.

On success, `data` is `{ servers }` where each item is `{ id, name, transport, status, last_error?, tool_count }`: `transport` is `stdio` / `http` / `sse`, `status` is `connected` / `connecting` / `disconnected` / `error`, and `last_error` carries the failure text when the server is in `error`.

### `POST /api/v1/mcp/servers/{mcp_server_id}:restart`

Reconnects one MCP server of the effective agent. The endpoint dispatches through `POST /api/v1/mcp/servers/{tail}` with `restart` as the only action — a bare server id or an unknown action fails `40001`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `mcp_server_id` | path | string | **Required.** MCP server id (its configured name) |

On success, `data` is `{ restarting: true }`.

- `40001`: missing or unknown action suffix
- `40408`: no MCP server with that id (also reported when no session is live)

## Capabilities and plugins

Capabilities are built-in features with layered readiness — detection steps plus a background install; the current build registers `kimi-cu` (Kimi Computer Use) and `kimi-webbridge` (Kimi Browser Extension). Plugins are installed packages of skills, MCP servers, hooks, and commands. These endpoints report capability status and drive capability installs, and manage the plugin lifecycle from marketplace listing to removal.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/capabilities` | List built-in capabilities with readiness status |
| `GET /api/v1/capabilities/{capability_id}` | Read one capability's status |
| `POST /api/v1/capabilities/{capability_id}:install` | Start a capability install (background; poll GET for progress) |
| `GET /api/v1/plugins` | List installed plugins |
| `POST /api/v1/plugins` | Install a plugin from a local path, zip URL, or GitHub repo |
| `GET /api/v1/plugins/marketplace` | Marketplace catalog merged with live install state |
| `POST /api/v1/plugins/{plugin_id}:{action}` | Plugin actions: `enable` / `disable` / `remove` |

### `GET /api/v1/capabilities`

Lists every registered capability with its readiness status.

On success, `data` is `{ capabilities }` where each item is a capability status object `{ id, pluginId?, displayName, description, supported, state, version?, steps, install }`. `state` is `ready` (every required detection step `ok`) / `partial` (some step `ok`) / `not_installed` / `unsupported` (not available on this platform/architecture); `steps` lists the detection steps as `{ id, state, detail?, optional? }` with `state` one of `ok` / `missing` / `failed`; `install` is the install progress `{ running, step?, percent?, error?, note? }` with `percent` between 0 and 100.

### `GET /api/v1/capabilities/{capability_id}`

Reads one capability's readiness status — the polling counterpart of the `:install` action.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `capability_id` | path | string | **Required.** Capability id |

On success, `data` is the capability status object documented under `GET /api/v1/capabilities` above.

- `40418`: no capability with that id

### `POST /api/v1/capabilities/{capability_id}:install`

Starts installing a capability in the background and returns immediately with the current status (`install.running` is `true`); poll `GET /api/v1/capabilities/{capability_id}` for progress. The endpoint dispatches through `POST /api/v1/capabilities/{tail}` with `install` as the only action — a bare id or an unknown action fails `40001`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `capability_id` | path | string | **Required.** Capability id |

On success, `data` is the capability status object documented under `GET /api/v1/capabilities` above.

- `40001`: missing or unknown action suffix
- `40418`: no capability with that id
- `40924`: an install of this capability is already running
- `40925`: the capability is not supported on this platform/architecture

### `GET /api/v1/plugins`

Lists installed plugins.

On success, `data` is `{ plugins }` where each item is `{ id, displayName, version?, enabled, state, skillCount, mcpServerCount, enabledMcpServerCount, hookCount, commandCount, hasErrors, source, originalSource?, github? }`: `state` is `ok` / `error` (load failures also set `hasErrors`), `source` is `local-path` / `zip-url` / `github`, and `github` carries the provenance `{ owner, repo, ref, installedSha? }` with `ref` `{ kind: branch|tag|sha, value }` for GitHub-sourced plugins.

### `POST /api/v1/plugins`

Installs a plugin and returns its summary.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `source` | body | string | **Required.** Where to install from: an absolute local path, an `http(s)` URL to a zip archive, or a GitHub URL — `https://github.com/<owner>/<repo>`, optionally pinned with `/tree/<branch-or-sha>`, `/releases/tag/<tag>`, or `/commit/<sha>` |

On success, `data` is the plugin summary documented under `GET /api/v1/plugins` above.

- `40001`: validation failure — for example `source` is neither a URL nor an absolute path, or the plugin failed to load
- `40409`: the local path does not exist

### `GET /api/v1/plugins/marketplace`

Lists the plugin marketplace catalog merged with live install state. The catalog is fetched per request (10-second timeout) from the configured marketplace URL; with the default catalog, built-in capabilities missing from the catalog are merged in as rows (with `capabilityId` set) and rows whose capability is unsupported on this platform are dropped.

On success, `data` is `{ entries }` where each item is `{ id, tier, classification?, displayName, description?, cliDescription?, homepage?, keywords?, version?, source, iconUrl?, sha256sum?, filename?, platforms?, defaultLocale?, locale?, billing?, installed?, updateAvailable?, capabilityId? }`: `tier` is `official` / `curated` / `third-party`, `classification` is `official` / `third_party`, `installed` is `{ version?, enabled }` when the plugin is installed, and `updateAvailable` marks rows whose catalog version is newer than the installed one. An entry's `source` feeds the `source` field of `POST /api/v1/plugins`; `defaultLocale` names the language of `description`/`cliDescription`, and `locale` holds the per-language texts.

Entries are filtered by host before they are returned: a catalog entry's `clients` must include `cli` (or be omitted) and its `platforms` must include this daemon's platform (or contain only `cloud`), otherwise the row is left out. The same catalog read is recorded in `$KIMI_CODE_HOME/plugins/availability.json`, which the installed list uses to hide a plugin whose catalog entry no longer targets this host.

Plugin summaries elsewhere on this page also carry `origin` (`marketplace` / `custom` / `unknown`) and an optional `catalogId`.

- `50001`: the marketplace is unreachable or returned an invalid catalog

### `POST /api/v1/plugins/{plugin_id}:enable`

Enables an installed plugin. Plugin actions dispatch through one route, `POST /api/v1/plugins/{tail}`: the tail is parsed as `{plugin_id}:{action}` with `enable` / `disable` / `remove` as the actions, and a bare id or an unknown action fails `40001` (`unsupported action: ...`).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `plugin_id` | path | string | **Required.** Installed plugin id |

On success, `data` is `{ ok: true }`.

- `40001`: missing or unknown action suffix
- `40419`: no installed plugin with that id

### `POST /api/v1/plugins/{plugin_id}:disable`

Disables an installed plugin without removing it; the dispatch contract matches `:enable` above.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `plugin_id` | path | string | **Required.** Installed plugin id |

On success, `data` is `{ ok: true }`.

- `40001`: missing or unknown action suffix
- `40419`: no installed plugin with that id

### `POST /api/v1/plugins/{plugin_id}:remove`

Removes an installed plugin; the dispatch contract matches `:enable` above.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `plugin_id` | path | string | **Required.** Installed plugin id |

On success, `data` is `{ ok: true }`.

- `40001`: missing or unknown action suffix
- `40419`: no installed plugin with that id

## Workspaces

Workspaces are the registered project directories sessions live in. These endpoints manage the registry — list, register, rename, unregister — plus the per-workspace trust state that gates project-level MCP config. Every endpoint that returns a workspace uses the wire shape documented once under [The workspace object](#the-workspace-object).

| Method and path | Description |
| --- | --- |
| `GET /api/v1/workspaces` | List registered workspaces |
| `POST /api/v1/workspaces` | Register a workspace (idempotent on the root path) |
| `PATCH /api/v1/workspaces/{workspace_id}` | Rename |
| `DELETE /api/v1/workspaces/{workspace_id}` | Unregister (keeps on-disk content) |
| `GET /api/v1/workspaces/{workspace_id}/trust` | Read the trust state |
| `POST /api/v1/workspaces/{workspace_id}/trust` | Grant trust |
| `POST /api/v1/workspaces/{workspace_id}/untrust` | Revoke trust |
| `POST /api/v1/workspaces/{workspace_id}/add-dir` | Add an additional directory |

### The workspace object

Every endpoint that returns a workspace uses this wire shape. Registration and rename broadcast the global `event.workspace.created` / `event.workspace.updated` events.

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Workspace id: a `wd_<slug>_<hash12>` string derived from the root path, or a `wm_<uuid>` string for a managed workspace |
| `root` | string | Absolute path of the project directory |
| `name` | string | Display name, 1–100 characters; defaults to the root's base name |
| `kind` | string | `managed` for a workspace created explicitly, `implicit` for one registered by opening a session in it |
| `additional_dirs` | string[] | Source folders registered next to the root |
| `created_at` | string | Registration time, ISO 8601 |
| `last_opened_at` | string | Last time the workspace was opened or re-registered, ISO 8601 |
| `session_count` | integer | Number of sessions in the workspace |

### `GET /api/v1/workspaces`

Lists every registered workspace.

On success, `data` is `{ items }` where each item is [the workspace object](#the-workspace-object).

### `POST /api/v1/workspaces`

Registers a workspace and returns it. Registration is idempotent on the root path: registering an already-registered root returns the existing workspace with only `last_opened_at` refreshed (the stored name is kept), broadcasting `event.workspace.updated` instead of `event.workspace.created`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `root` | body | string | **Required.** Absolute path of an existing directory |
| `name` | body | string | Display name, 1–100 characters. Default the root's base name |
| `additional_dirs` | body | string[] | Source folders to register next to the root, at most 64. Relative entries resolve against `root` |
| `idempotency_key` | body | string | Retry key, 1–200 characters. A repeated request with the same key returns the same workspace, including after a restart |

Supplying `additional_dirs` or `idempotency_key` creates a managed workspace (a `wm_<uuid>` id with `kind: managed`) instead of registering the root implicitly, so a caller can hold several workspaces rooted at the same directory.

On success, `data` is [the workspace object](#the-workspace-object).

- `40001`: `root` is missing or not an absolute path (`details` lists the field)
- `40006`: `additional_dirs` repeats itself or names the root; `msg` is `Duplicate source folder: <actual path>` and `details` is `[{ "path": "additional_dirs.N", "directory": "<resolved absolute path>" }]`
- `40409`: `root` does not exist or is not a directory

### `PATCH /api/v1/workspaces/{workspace_id}`

Renames a workspace — the display name only; the root path never changes.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **Required.** Workspace id |
| `name` | body | string | **Required.** New display name, 1–100 characters |

On success, `data` is [the workspace object](#the-workspace-object).

- `40001`: validation failure (`details` lists each field)
- `40410`: workspace not found

### `DELETE /api/v1/workspaces/{workspace_id}`

Unregisters a workspace. Only the registry entry is removed — the on-disk directory is untouched.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **Required.** Workspace id |

On success, `data` is `{ deleted: true }`.

- `40410`: workspace not found

### `GET /api/v1/workspaces/{workspace_id}/trust`

Reads the workspace trust state. Trust gates whether project-level MCP config loads for the workspace.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **Required.** Workspace id |

On success, `data` is `{ trusted }`.

- `40410`: workspace not found

### `POST /api/v1/workspaces/{workspace_id}/trust`

Marks the workspace trusted, loading its project-level MCP config.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **Required.** Workspace id |

On success, `data` is `{ trusted: true }`.

- `40410`: workspace not found

### `POST /api/v1/workspaces/{workspace_id}/untrust`

Revokes the persisted workspace trust records associated with the current dir set. Unless a process or config override keeps the workspace trusted, its project-level MCP config unloads.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **Required.** Workspace id |

On success, `data` is `{ trusted }`, containing the effective trust state after revocation. It is normally `{ trusted: false }`, but remains `true` when `KIMI_CODE_TRUST_WORKSPACE` or [`[workspace] require_trust = false`](../configuration/config-files.md#workspace-trust) applies.

- `40410`: workspace not found

### `POST /api/v1/workspaces/{workspace_id}/add-dir`

Adds an additional directory to the workspace, with the same semantics as the CLI `--add-dir` flag and the TUI `/add-dir` command. The path accepts absolute paths, relative paths (resolved against the workspace root), and `~` expansion.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **Required.** Workspace id |
| `path` | body | string | **Required.** Directory to add |
| `persist` | body | boolean | Defaults to `true`: appends to `workspace.additional_dir` in `<project root>/.kimi-code/local.toml`. With `false`, the directory only joins the in-memory ephemeral set shared by all sessions of the workspace |

On success, `data` is `{ project_root, config_path, additional_dirs, persisted }`, where `additional_dirs` lists every additional directory (existing ones included) and `persisted` reports whether this call wrote to disk.

- `40001`: validation failure (`details` lists each field), or an engine-side config validation error such as a corrupted project local config
- `40409`: `path` does not exist or is not a directory
- `40410`: workspace not found

## File uploads

| Method and path | Description |
| --- | --- |
| `POST /api/v1/files` | Multipart upload (`file` field, optional `name` and `expires_in_sec`); returns file metadata |
| `GET /api/v1/files/{file_id}` | Download (binary; errors use real HTTP statuses) |
| `DELETE /api/v1/files/{file_id}` | Delete |

### `POST /api/v1/files`

Uploads a file as `multipart/form-data` for later reference (for example as a prompt attachment).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `file` | body | binary | **Required.** The multipart file part |
| `name` | body | string | Stored display name. Default the uploaded filename |
| `expires_in_sec` | body | number | Seconds until the file expires (non-negative). Default never expires |

On success, `data` is the file metadata `{ id, name, media_type, size, created_at, expires_at? }` with `media_type` taken from the upload's content type.

- `40001`: the multipart body has no `file` field

### `GET /api/v1/files/{file_id}`

Downloads an uploaded file. The response is a binary stream that honors range requests but ignores `If-None-Match`; failures use real HTTP statuses — see [Binary and streaming endpoints](#binary-and-streaming-endpoints).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `file_id` | path | string | **Required.** File id from the upload response |

- `40407` (HTTP 404): no file with that id (including an expired file)

### `DELETE /api/v1/files/{file_id}`

Deletes an uploaded file.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `file_id` | path | string | **Required.** File id from the upload response |

On success, `data` is `{ deleted: true }`.

- `40407` (HTTP 404): no file with that id

## GUI store

A server-backed key/value store that mirrors the browser `localStorage` interface, persisted under the server's home directory; the web UI keeps cross-client UI state here. Values are opaque strings — serialization is the caller's job.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/gui/store/length` | Number of stored keys |
| `GET /api/v1/gui/store/getItem` | Read a value by key |
| `POST /api/v1/gui/store/setItem` | Write a value by key |
| `POST /api/v1/gui/store/removeItem` | Delete a value by key |
| `POST /api/v1/gui/store/clear` | Delete all values |

### `GET /api/v1/gui/store/length`

Returns the number of stored keys (mirrors `localStorage.length`). No parameters.

On success, `data` is `{ length }`.

### `GET /api/v1/gui/store/getItem`

Reads one value (mirrors `localStorage.getItem`).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `key` | query | string | **Required.** Key to read, 1–256 characters |

On success, `data` is `{ value }`, the stored string or `null` when the key does not exist.

### `POST /api/v1/gui/store/setItem`

Writes one value (mirrors `localStorage.setItem`).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `key` | body | string | **Required.** Key to write, 1–256 characters |
| `value` | body | string | **Required.** Value to store |

On success, `data` is `null`.

### `POST /api/v1/gui/store/removeItem`

Deletes one value (mirrors `localStorage.removeItem`).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `key` | body | string | **Required.** Key to delete, 1–256 characters |

On success, `data` is `null`.

### `POST /api/v1/gui/store/clear`

Deletes every stored value (mirrors `localStorage.clear`). No parameters.

On success, `data` is `null`.

## Global search and misc

| Method and path | Description |
| --- | --- |
| `POST /api/v1/search` | Cross-session full-text search; `mode` is `terms` (default) or `literal` (exact substring); `page_token` pagination |
| `GET /api/v1/connections` | List live WebSocket connections |
| `GET /api/v2/sessions` | Next-generation session list, see below |
| `POST /api/v2/sessions:archive` | Batch-archive sessions, see below |
| `POST /api/v2/sessions:restore` | Batch-restore archived sessions, see below |
| `/api/v2/mcp/*` | Unified MCP management plane, see below |
| `/api/v1/debug/*` | Reflection debug RPC; mounted only with `--debug-endpoints` on loopback, not a stable protocol |

### `POST /api/v1/search`

Cross-session full-text search over user messages, assistant replies, and session titles, backed by the server's persistent search index. When `container.session_id` names a session live in this server process, the search instead scans that session's in-memory transcript directly, and the response's `source` field (`index` or `live`) reports which path served the page.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `query` | body | string | **Required.** Search text |
| `mode` | body | string | `terms` (default) / `literal` |
| `op` | body | string | Term combiner in `terms` mode: `AND` (default) / `OR` |
| `container` | body | object | Restrict the search to `{ session_id?, agent_id? }` |
| `role` | body | string | Restrict to `user` / `assistant` / `title` hits |
| `start_time` | body | integer | Only hits at or after this time (epoch milliseconds) |
| `end_time` | body | integer | Only hits at or before this time (epoch milliseconds) |
| `sort` | body | string | `score` (default) / `time_desc` / `time_asc`; ignored by `literal` mode, which always returns newest-first |
| `page_size` | body | integer | Hits per page, 1–50. Default `20` |
| `page_token` | body | string | Token from the previous page's response |

In `terms` mode the query is tokenized (ASCII words plus CJK n-grams), deduplicated, and matched against the inverted index with at most 32 terms; `literal` mode is an exact substring search with zero false positives. On success, `data` is `{ items, has_more, page_token?, index_state, source }` where each item is `{ session_id, workspace_id, session_title, agent_id, role, snippet, time, turn?, step_id?, score }`. `index_state` is `{ state, indexed_sessions, total_sessions, documents, stale?, degraded? }` with `state` one of `building` / `ready` / `readonly`; `stale` marks a behind view still catching up, and `degraded` carries the last refresh failure. An over-budget page additionally carries `incomplete`, one of `candidate_cap` / `postings_budget` / `deadline`. Page tokens pin the index generation and the query conditions — a rebuild or a changed query invalidates them.

- `40001`: body validation failure, an unusable query (empty, or more than 32 terms), or an invalid page token

### `GET /api/v1/connections`

Lists the WebSocket clients currently connected to this server, oldest connection first. No parameters.

On success, `data` is `{ connections }` where each item is `{ id, connected_at, remote_address, user_agent, has_client_hello, subscriptions }`: `connected_at` is an ISO 8601 timestamp, `remote_address` and `user_agent` are `null` when unknown, `has_client_hello` reports whether the client sent its handshake frame, and `subscriptions` lists the session ids the connection is subscribed to.

## `GET /api/v2/sessions`

A next-generation session query for list views — filtering, sorting, and field groups all travel in query parameters:

| Parameter | Description |
| --- | --- |
| `workspace.id` | Filter by workspace; repeatable |
| `activity.status` | Filter by activity status: `running` / `approval` / `question` / `failed` / `idle`; repeatable |
| `meta.updated_after` | Only sessions updated after this time (epoch milliseconds) |
| `meta.updated_before` | Only sessions updated before this time (epoch milliseconds) |
| `meta.archived` | `true` / `false` (default) / `all` |
| `meta.has_prompt` | `true` keeps only sessions that carry a user prompt, `false` keeps only empty ones (the `exclude_empty` equivalent of `GET /api/v1/sessions`) |
| `view` | `flat` (default) / `by_workspace`, see below |
| `group.page_size` | Sessions returned per workspace under `view=by_workspace`: 1–100, default 5 (up to 10000 with the `id,archived` projection); rejected without the grouped view (`40001`) |
| `sort` | `meta.updated_at_desc` (default) / `meta.updated_at_asc` / `meta.created_at_desc` |
| `include` | Comma-separated extra field groups; currently only `git` (branch and PR info, deduplicated per environment and working directory and cached for 60 seconds) |
| `fields` | Comma-separated item projection; currently only `id,archived`, trimming each item to `{ id, archived }` (select-all-matching flows). Not combinable with `include=git` (`40001`) |
| `page_size` | 1–100, default 50; up to 10000 with the `id,archived` projection. Under `view=by_workspace` it counts groups per page |
| `page_token` | Pagination token from the previous page |
| `page` | Stateless 1-based page number; mutually exclusive with `page_token` (`40001` when combined) |

Every response item carries the `workspace`, `meta`, and `activity` groups, plus `git` when `include=git` — or just `{ id, archived }` under `fields=id,archived`. The `activity` group also reports `model`: the session's bound model alias while it is live in this process, `null` for cold (not currently loaded) sessions. Every page additionally carries `total`, the size of the filtered set. Listing scans the session index up to a bound — `20000` entries (`100000` under the `id,archived` projection) — before filtering, sorting, and paginating in memory, so `total` counts the scanned window rather than the whole store. When the scan saturates that bound the page carries `scan_truncated: true` (absent otherwise) and the server logs a warning: `total` is then a lower bound on the full matching count, and the reliable escape hatch is narrowing the query conditions (workspace, time range, `meta.has_prompt`). The page token binds the first page's query conditions (including the projection); changing them mid-pagination returns `40922`. `page` mode is a stateless alternative for jumping to arbitrary pages: every request is an independent snapshot, no token is minted, and `next_page_token` is always `null`.

With `view=by_workspace` the same filtered, sorted set is re-projected into per-workspace groups, so an overview client replaces one polling loop per workspace with a single request:

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "groups": [
      {
        "workspace": { "id": "wd_my-app_a1b2c3d4e5f6", "cwd": "/Users/dev/my-app" },
        "sessions": [ { "id": "session_...", "workspace": { "id": "wd_my-app_a1b2c3d4e5f6", "cwd": "/Users/dev/my-app" }, "meta": { "title": "Fix the login page", "last_prompt": "adjust the button spacing", "created_at": 1787000000000, "updated_at": 1787000100000, "archived": false, "archived_at": null }, "activity": { "status": "idle", "model": "kimi-for-coding" } } ],
        "total": 42
      }
    ],
    "total": 7,
    "has_more": true,
    "next_page_token": "eyJ2IjoxLCJmIjoi..."
  },
  "request_id": "req_..."
}
```

Each group carries the workspace's first `group.page_size` sessions under the requested `sort` plus `total`, the workspace's full matching-session count (for a "view all" entry). Only workspaces with at least one matching session appear; groups order by their first session's sort key, ties broken by workspace id. `page` and `page_token` paginate over groups (the outer `total` is the group count), with the same fingerprint binding: the token also covers `view` and the grouping parameters, so flipping them mid-pagination returns `40922`.

## `POST /api/v2/sessions:archive` and `POST /api/v2/sessions:restore`

Batch archive/restore for session-management views. The body is `{ "ids": ["session_..."] }` — non-empty, at most 5000 unique ids (duplicates collapse). Live sessions go through the full lifecycle; cold sessions are patched on disk without being loaded.

Only a body validation failure fails the whole request (`40001`). Otherwise the response is per-item: `data.results` keeps the input order with `{ id, ok }` or `{ id, ok: false, error }` (an unknown id reports `40401` in its own item), plus `succeeded` / `failed` counts.

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "results": [
      { "id": "session_a", "ok": true },
      { "id": "session_b", "ok": false, "error": { "code": 40401, "message": "session session_b does not exist" } }
    ],
    "succeeded": 1,
    "failed": 1
  },
  "request_id": "req_..."
}
```

## MCP management (`/api/v2/mcp`)

The `/api/v2/mcp/*` routes are the server's unified MCP management plane: they manage the MCP server registry itself, independent of any session — global (user-level) CRUD with per-entry validation, connection-test probes, a locator-addressed inspection catalog, per-server auth-status listing, and the full OAuth flow lifecycle.

| Method and path | Description |
| --- | --- |
| `GET /api/v2/mcp/servers` | List every known MCP server |
| `GET /api/v2/mcp/servers/{name}` | Get one server by runtime name |
| `POST /api/v2/mcp/servers` | Add a server to the user-level `mcp.json` |
| `PUT /api/v2/mcp/servers/{name}` | Replace a user-level entry |
| `DELETE /api/v2/mcp/servers/{name}` | Remove a user-level entry |
| `POST /api/v2/mcp/servers:test` | Probe a real connection to one server |
| `POST /api/v2/mcp/servers:inspect` | Locator-addressed catalog with a batched connection probe |
| `GET /api/v2/mcp/auth-statuses` | Per-server OAuth state over the catalog |
| `POST /api/v2/mcp/auth:begin` | Begin an interactive OAuth flow |
| `POST /api/v2/mcp/auth:complete` | Await the browser callback and finish the code exchange |
| `POST /api/v2/mcp/auth:cancel` | Tear down a begun OAuth flow |
| `POST /api/v2/mcp/auth:reset` | Clear a server's stored credentials |

Two addressing schemes appear on this plane. The CRUD routes and `servers:test` take a plain runtime `name`; the inspection and OAuth routes take a **locator** — `{ "source": "global", "name" }` for a file-layer entry or `{ "source": "plugin", "pluginId", "serverName" }` for a plugin-manifest entry — because a plugin entry and a file entry can share one runtime name. Inspection items additionally carry a stable `serverId` wire id: `global:<name>` or `plugin:<pluginId>:<serverName>` (URL-encoded).

Most routes accept an optional `cwd` (a query parameter, or a body field on the `:`-action routes). Without it the catalog covers the user-level file and plugin manifests only; with it, the project-root and project-local layers of that directory join in — but only when the workspace is trusted, otherwise the project layers are skipped. For `servers:test` on a stdio server, `cwd` is also the child process's working directory. Connection probes and OAuth calls wait for the server's configuration to finish loading before acting.

### `GET /api/v2/mcp/servers` and `GET /api/v2/mcp/servers/{name}`

Lists every MCP server the management plane knows about; the second route returns the single entry with that runtime name.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `name` | path | string | **Required (get only).** Runtime name of the server |
| `cwd` | query | string | Include the project layers of this (trusted) directory |

On success, `data` is an array of managed servers (a single object for the get route), each `{ name, config, source, origin, mutable, plugin? }`:

- `source`: `global` (a config-file layer) or `plugin` (a plugin manifest)
- `origin`: where the entry is defined — a file path or a plugin id
- `mutable`: only user-level entries are mutable; plugin and project-layer entries are read-only
- `config`: mutable entries carry the full config so edit UIs can prefill it; read-only entries are redacted to sorted key lists (`envKeys` / `headerKeys`) and never disclose secret values
- `plugin`: `{ id, name }`, present on plugin entries

- `40001`: validation failure
- `40408`: no server with that name

### `POST` / `PUT` / `DELETE /api/v2/mcp/servers`

Global CRUD against the user-level `mcp.json`. The add body is a full server config including `name` — `transport` (`stdio` / `http` / `sse`) discriminates the shape, and each entry is validated before it is written. The update body carries the same config without `name` (the path names the entry); delete takes no body. All three return the refreshed server list in `data`. A write whose name collides with a project-layer entry is rejected as read-only — edit the defining file instead; a same-named plugin entry does not block the write, and the new file entry shadows it.

- `40001`: validation failure, or the target entry is read-only
- `40408`: (update/delete) no server with that name

### `POST /api/v2/mcp/servers:test`

Probes a real connection to one server and never persists anything. Pass either `name` to test a registry entry (plugin and trusted project layers included) or `server` (a full inline config, `name` included) to probe it as-is; passing both or neither fails `40001`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `name` | body | string | Runtime name of a registry entry |
| `server` | body | object | Inline server config to probe as-is |
| `cwd` | body | string | Project layers join the resolution; also the stdio working directory |

On success, `data` is `{ success, output }`: when the connection succeeds, `output` lists the server's available tools; otherwise it carries the failure text.

- `40001`: both or neither target form passed, an invalid inline config, or a runtime name shared by multiple enabled servers
- `40408`: no server with that name

### `POST /api/v2/mcp/servers:inspect`

The locator-addressed catalog (redacted configs) plus a batched real-connection probe of every OAuth candidate.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `targets` | body | array | Locators narrowing the catalog; omitted inspects all servers |
| `cwd` | body | string | Include the project layers of this (trusted) directory |

On success, `data` is an array of inspections, each `{ serverId, locator, runtimeName, canonicalUrl?, origin, config, enabled, editable, authStatus, checkedAt?, error? }`: `canonicalUrl` is the credential URL of a remote server, `config` is the redacted view, and `authStatus` is one of `not-applicable` / `bearer-token` / `oauth-required` / `oauth-authorized` / `oauth-expired` / `unavailable`. A runtime name shared by multiple enabled servers cannot be probed unambiguously and reports `unavailable` with an explanatory `error`. A probe that hits an expired grant may refresh or invalidate the stored credentials.

- `40001`: validation failure
- `40408`: a `targets` locator matches nothing

### `GET /api/v2/mcp/auth-statuses`

Per-server OAuth state over the registry catalog — the lightweight alternative to `servers:inspect` when only the auth dimension is needed.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `cwd` | query | string | Include the project layers of this (trusted) directory |
| `verify` | query | string | `true` probes every OAuth candidate through a real connection; `false` is fully offline (config and stored tokens only); omitted preserves implicit OAuth detection, probing only unpinned remote servers without stored credentials |

On success, `data` is an array of `{ name, authStatus }` with the same `authStatus` enum as `servers:inspect`. Verification probes may refresh or invalidate stored credentials.

### `POST /api/v2/mcp/auth:begin` / `:complete` / `:cancel` / `:reset`

The OAuth flow lifecycle for remote servers. `auth:begin` takes a locator body (plus the optional `cwd` query) and answers `data` `{ status: "authorization-required", flowId, authorizationUrl }` — open the URL in a browser to grant access — or `{ status: "already-authorized" }` when a grant already exists. The target server must use a remote transport (`http` / `sse`) and must not carry a static bearer token; static headers are allowed only when the config explicitly sets `auth: "oauth"`.

`auth:complete` waits for the browser callback of a begun flow and finishes the code exchange. Its body is `{ flowId, timeoutMs? }`: the wait defaults to 15 minutes (`timeoutMs` overrides it), an idle flow expires after 15 minutes regardless, and closing the HTTP connection aborts the wait. `data` is `null` on success.

`auth:cancel` tears down a begun flow (`{ flowId }`) without finishing it; unknown flows are ignored. `auth:reset` takes a locator body and clears the server's stored credentials — the invalidation event reaches live sessions.

- `40001`: validation failure — including an unknown `flowId` on `:complete`, or a server that cannot do OAuth (stdio transport, a static bearer token, or static headers without `auth: "oauth"`) on `:begin`
- `40408`: (`:begin` / `:reset`) the locator matches nothing
- `40929`: the OAuth flow itself failed
