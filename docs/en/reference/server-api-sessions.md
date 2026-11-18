# Session endpoints

This page lists the REST endpoints that create, read, and modify sessions, run session actions, and read messages, transcripts, prompts, and interactions. For the WebSocket side, see [Sessions and conversations](./server-api-conversation.md); for shared conventions such as authentication, the response envelope, error codes, and pagination, see [Server API](./server-api.md).

## Sessions

These endpoints create, list, and inspect sessions, drive session-level actions (fork, compact, undo, and friends), and read per-session rollups. Most of them return a session in the wire shape documented once under [The session object](#the-session-object); non-CRUD operations use the [`:{action}` convention](./server-api.md#action-paths).

| Method and path | Description |
| --- | --- |
| `POST /api/v1/sessions` | Create a session (requires `workspace_id` or `metadata.cwd`) |
| `GET /api/v1/sessions` | List sessions; cursor pagination with filters such as `busy` and `archived_only` |
| `GET /api/v1/sessions/{session_id}` | Read one session |
| `GET /api/v1/sessions/{session_id}/profile` | Read the session profile |
| `POST /api/v1/sessions/{session_id}/profile` | Update title, metadata, agent config |
| `POST /api/v1/sessions/{session_id}/title/generate` | Generate a title via the managed `chat_title` tool |
| `POST /api/v1/sessions/{session_id}:{action}` | Session actions: `fork` / `compact` / `undo` / `abort` / `btw` / `archive` / `restore` |
| `GET /api/v1/sessions/{session_id}/children` | List child sessions |
| `POST /api/v1/sessions/{session_id}/children` | Create a child session (fork with a tag) |
| `GET /api/v1/sessions/{session_id}/goal` | Current goal snapshot (`null` when none) |
| `PATCH /api/v1/sessions/{session_id}/goal` | Edit the current goal's objective in place |
| `GET /api/v1/sessions/{session_id}/warnings` | Session-level warnings |
| `GET /api/v1/sessions/{session_id}/runtime` | Read the main agent's runtime binding |
| `POST /api/v1/sessions/{session_id}/runtime` | Switch the main agent's runtime binding |
| `POST /api/v1/sessions/{session_id}/export` | Export the session with diagnostics (zip stream, not enveloped) |
| `GET /api/v1/sessions/{session_id}/media/{file_id}` | Download prompt media by file id (binary) |

### The session object

Every endpoint that returns a session uses this wire shape. The live facts (`busy`, `main_turn_active`, `pending_interaction`, `last_turn_reason`) are resolved from the session's activity aggregate: a session that is not loaded in this server process (a cold session) always reports not-busy with no pending interaction. A few fields are placeholders in the current projection — this is noted per field.

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Session id (`session_...`) |
| `workspace_id` | string | Owning workspace id |
| `title` | string | Session title; `""` when untitled |
| `created_at` / `updated_at` | string | Creation and last-update times, ISO 8601 |
| `archived` | boolean | Whether the session is archived (hidden from the default session list) |
| `archived_at` | string | Archive time, ISO 8601; present only when archived |
| `busy` | boolean | Any agent has an active turn or background task |
| `main_turn_active` | boolean | The main agent has an active turn |
| `pending_interaction` | string | `none` / `approval` / `question` — an unanswered interaction is waiting |
| `last_turn_reason` | string | Main agent's latest turn outcome: `completed` / `cancelled` / `failed` |
| `last_prompt` | string | Most recent user prompt text, when present |
| `metadata` | object | Custom metadata; always carries `cwd` (the session's working directory) |
| `agent_config` | object | Projected as `{ model }`; `model` is the main agent's current model when the session is loaded in this server process and its main agent has one — as in the creation response unless no model was available — and `""` otherwise |
| `usage` | object | Token rollup `{ input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, context_tokens, context_limit?, total_cost_usd?, turn_count? }`; currently always zeros. The live context size comes with each agent's `usage` frame over the WebSocket (see [Events](./server-api-conversation.md#events)) |
| `permission_rules` | array | Session permission rules; currently always `[]` |
| `message_count` | integer | Message count; currently always `0` |

### `POST /api/v1/sessions`

Creates a session and returns it. The target directory comes from `workspace_id` (an already-registered workspace) or from `metadata.cwd` (the workspace is registered on first use); passing both requires them to agree. Creation broadcasts the global `event.session.created` event.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | body | string | **Required** when `metadata.cwd` is absent. Registered workspace id; the session is created at that workspace's root |
| `metadata` | body | object | Custom metadata. `metadata.cwd` is the working directory and is **required** when `workspace_id` is absent; with both given, it must equal the workspace root. Other keys are kept as the session's custom metadata, except the reserved keys `goal`, `parent_session_id`, and `child_session_kind`, which are dropped |
| `title` | body | string | Initial title (at least 1 character); the session is untitled otherwise |
| `agent_config` | body | object | Partial main-agent config, with the same fields as `POST /api/v1/sessions/{session_id}/profile` plus `profile`, applied before the session is returned. When it cannot be applied, the session is not created and the error is returned. `tower_mode: true` is rejected (`40001`): entering Tower mode changes the repository and cannot be undone if creation fails, so enable it through `POST /api/v1/sessions/{session_id}/profile` once the session exists |

The main agent is bound when the session is created: `agent_config.profile` picks the agent profile (default `agent`), `agent_config.model` the model (default: the server's current default model), and `agent_config.thinking` is checked against that model in the same bind. The profile cannot change afterwards, and later changes to the default model do not affect the session. When no model is available — no default model is configured or it does not resolve — the session is created without a model, unless `agent_config` sets `profile` or `thinking`.

On success, `data` is [the session object](#the-session-object) of the new session.

- `40001`: neither `workspace_id` nor `metadata.cwd` given, `metadata.cwd` does not match the workspace root, or `agent_config` sets `tower_mode: true` (`details` lists the field); also when `agent_config.model` is not configured, `agent_config.profile` names an unknown agent profile, or the model does not support `agent_config.thinking`
- `40113`: no model is available while `agent_config` sets `profile` or `thinking`
- `40409`: the working directory does not exist or is not a directory
- `40410`: no registered workspace with that `workspace_id`
- `40913`–`40918`, `40920`: `agent_config` could not be applied because of a goal error

### `GET /api/v1/sessions`

Lists sessions across workspaces, newest `updated_at` first. Cursor pagination follows [Pagination](./server-api.md#pagination), with one twist: without `page_size` (and without `archived_only`) the response is a single unpaginated window whose `has_more` is always `false`, so pass `page_size` to actually page.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `before_id` | query | string | Only sessions older than this id; mutually exclusive with `after_id` |
| `after_id` | query | string | Only sessions newer than this id; mutually exclusive with `before_id` |
| `page_size` | query | integer | 1–100. When paging applies, the default is `20`; see the note above for the unpaginated default behavior |
| `busy` | query | boolean | Keep only busy (or only idle) sessions |
| `include_archive` | query | boolean | Include archived sessions alongside live ones. Default `false` |
| `archived_only` | query | boolean | Keep only archived sessions; mutually exclusive with `include_archive`; implies cursor paging even without `page_size` |
| `exclude_empty` | query | boolean | Drop sessions that carry no user prompt |
| `workspace_id` | query | string | Restrict to one workspace (aliases are resolved) |

On success, `data` is `{ items, has_more }` where each item is [the session object](#the-session-object).

- `40001`: validation failure — for example `before_id` combined with `after_id`, or `archived_only` combined with `include_archive`
- `40410`: unknown `workspace_id`

### `GET /api/v1/sessions/{session_id}`

Reads one session from the index. Live facts are included when the session is loaded in this process; a cold session reports not-busy with its last persisted turn outcome.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |

On success, `data` is [the session object](#the-session-object).

- `40401`: session not found, or its workspace can no longer be resolved

### `GET /api/v1/sessions/{session_id}/profile`

Reads the session profile — the same wire payload as `GET /api/v1/sessions/{session_id}`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |

On success, `data` is [the session object](#the-session-object).

- `40401`: session not found

### `POST /api/v1/sessions/{session_id}/profile`

Updates the session's profile: title, custom metadata, and the main agent's config. A title set here becomes a custom title, which wins over generated titles; setting one broadcasts the global `session.meta.updated` event.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `title` | body | string | New title (at least 1 character); becomes a custom title |
| `metadata` | body | object | Merges custom metadata. A different `cwd` moves an idle local session to that directory while preserving its ID and history; queued/running work, pending interactions, or scheduled tasks reject the move with `40901`. The reserved keys `goal`, `parent_session_id`, and `child_session_kind` cannot be overwritten |
| `agent_config` | body | object | Partial main-agent config; fields below, all optional |

Each `agent_config` field is applied immediately to the main agent:

| Field | Type | Description |
| --- | --- | --- |
| `model` | string | Model alias id; an empty string is ignored |
| `thinking` | string | Thinking-mode effort level |
| `permission_mode` | string | `manual` / `yolo` / `auto` |
| `plan_mode` | boolean | Enter or exit Plan mode |
| `swarm_mode` | boolean | Enter or exit swarm mode |
| `hello_world_mode` | boolean | Enter or exit hello-world mode |
| `goal_objective` | string | Create a goal with this objective |
| `goal_control` | string | `pause` / `resume` / `cancel` the current goal |

The schema also accepts a top-level `permission_rules` array, but the update route currently does not apply it.

On success, `data` is the updated [session object](#the-session-object).

- `40001`: `model` is not configured, the model does not support `thinking`, or `agent_config.profile` is given, since the agent profile is chosen only when the session is created
- `40113`: `thinking` is set without `model` while the session has no model
- `40401`: session not found

### `POST /api/v1/sessions/{session_id}/title/generate`

Generates a title from the session's prompts through the managed provider's `chat_title` tool and applies it, broadcasting `session.meta.updated`. Generation requires the managed OAuth login; without `force`, a session that already has a custom or generated title is reported unavailable instead of being overwritten.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `force` | body | boolean | Regenerate even when a custom or generated title exists. Default `false` |
| `source` | body | string | Title input: `user_prompts` (default) / `first_turn` / `digest` |

On success, `data` is `{ title }` — the title now applied to the session.

- `40401`: session not found
- `40923`: generation unavailable — the flag is off, there is no managed OAuth login or no prompt content yet, an existing title without `force`, or the backend request failed

### `POST /api/v1/sessions/{session_id}:{action}`

Session actions are dispatched through one route: the path tail is parsed as `{session_id}:{action}`, the body is validated against the action's schema, and a missing or unknown action fails `40001` (`unsupported action: ...`). Every action resolves the session first, so all of them can return `40401` for an unknown session. The supported actions are documented one by one below.

### `POST /api/v1/sessions/{session_id}:fork`

Copies the session — its transcript, agent state, and files — into a new session in the same workspace, and broadcasts `event.session.created`. The source keeps running. If a turn is active, the fork retains the last completed turn before it and the active turn's user prompt as a prompt-only `cancelled` turn; active assistant output, tool activity, queued input, and later events are excluded.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `title` | body | string | Title for the fork (at least 1 character). Default `Fork: <source title>` |
| `metadata` | body | object | Custom metadata for the fork |
| `turn_index` | body | integer | Persistent engine `turnId` to fork through, including that turn. Gaps are allowed. Must be a non-negative safe integer and already complete |

On success, `data` is [the session object](#the-session-object) of the new session.

- `40001`: `turn_index` is invalid, does not exist, or selects the active turn
- `40901`: another session history operation is in progress

### `POST /api/v1/sessions/{session_id}:compact`

Starts a manual full compaction of the main agent's context. The call returns immediately; progress and completion are delivered as the `compaction.*` WebSocket events.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `instruction` | body | string | Extra guidance for the compaction summary; a blank value is ignored |

On success, `data` is an empty object.

- `40910`: a turn or another context change is active, or the history has nothing to compact

### `POST /api/v1/sessions/{session_id}:undo`

Rewinds the conversation to before the specified turn and reconciles the derived session state.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `turn_id` | body | string | Required ID from the agent's conversation turns |
| `agent_id` | body | string | Agent to undo; defaults to the main agent |

On success, `data` is `{ removed_turn_ids }`, containing the removed turn IDs. The old `count` and `page_size` request fields are no longer used.

- `40422`: the turn was not found; this replaces the conflicting `40421` value, which remains reserved for an agent not found
- `40901`: a turn is active or a compaction is running — wait for it to finish, then retry
- `40911`: the selected turn cannot be undone, for example because it has no user-input anchor

### `POST /api/v1/sessions/{session_id}:abort`

Cancels the main agent's running turn — the programmatic equivalent of the user aborting the turn in the TUI.

On success, `data` is `{ aborted: true }`.

### `POST /api/v1/sessions/{session_id}:btw`

Starts a "by the way" side conversation: forks the main agent into a child agent whose tool calls are limited to the read-only tools `Read`, `Grep`, and `Glob`, so quick side questions run in isolation without touching the working context. Requires a usable model configuration.

On success, `data` is `{ agent_id }` — the id of the new child agent.

### `POST /api/v1/sessions/{session_id}:archive`

Marks the session archived: it disappears from the default session list (it stays listed with `include_archive` or `archived_only`), and the server broadcasts the global `event.session.archived` event.

On success, `data` is `{ archived: true }`.

### `POST /api/v1/sessions/{session_id}:restore`

Un-archives the session and resumes it. When the session was archived, the server broadcasts the global `event.session.restored` event.

On success, `data` is [the session object](#the-session-object) with `archived: false`.

### `POST /api/v1/sessions/{session_id}:reload`

Reloads the session with the latest on-disk configuration: re-reads `config.toml` and plugins, reloads the workspace skill and subagent catalogs, then closes and resumes the session from disk. The main agent is also notified of external changes to AGENTS.md files, skills, and subagent profiles or models via system reminders.

On success, `data` is [the session object](#the-session-object).

- `40901`: the session has an active turn and cannot be reloaded

### `POST /api/v1/sessions/{session_id}:takeover`

Removes the lock another Kimi Code process holds on the session, so a request that failed with `40931` can be retried. Use it only when that process is gone and left its lock behind: if it is still running, both processes write to the session until it goes idle, and the session history can interleave.

On success, `data` is `{ taken_over: true }`.

- `40401`: session not found

### `GET /api/v1/sessions/{session_id}/children`

Lists the session's children — the sessions created through `POST /api/v1/sessions/{session_id}/children`. Cursor pagination follows [Pagination](./server-api.md#pagination).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `before_id` | query | string | Only children older than this id; mutually exclusive with `after_id` |
| `after_id` | query | string | Only children newer than this id; mutually exclusive with `before_id` |
| `page_size` | query | integer | 1–100. Default `100` |
| `busy` | query | boolean | Keep only busy (or only idle) children |

On success, `data` is `{ items, has_more }` where each item is [the session object](#the-session-object).

- `40401`: session not found

### `POST /api/v1/sessions/{session_id}/children`

Creates a child session: a fork of this session recorded as its child, so it shows up under `GET /api/v1/sessions/{session_id}/children`. Running sources use the same completed-turn boundary and prompt-only `cancelled` active turn as `:fork`; child creation does not accept a historical `turn_index`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `title` | body | string | Title for the child (at least 1 character). Default `Child: <source title>` |
| `metadata` | body | object | Custom metadata for the child |

On success, `data` is [the session object](#the-session-object) of the new session, and the server broadcasts `event.session.created`.

- `40901`: another session history operation is in progress

### `GET /api/v1/sessions/{session_id}/goal`

Reads the session's current goal snapshot, or `null` when no goal is active. Note that this payload uses camelCase keys, unlike most of this API.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |

On success, `data` is `null` or `{ goalId, objective, completionCriterion?, status, turnsUsed, tokensUsed, wallClockMs, budget, terminalReason? }`, where `status` is `active` / `paused` / `blocked` / `complete` and `budget` reports the token, turn, and wall-clock budgets together with the remaining amounts and per-budget reached flags (each nullable when no such budget is set).

- `40401`: session not found

### `PATCH /api/v1/sessions/{session_id}/goal`

Replaces the objective of the current goal without changing its `goalId`, status, progress, or budget. Works on active, paused, and blocked goals. A running turn is not interrupted; the agent receives the new objective on its next turn. Connected clients are notified through the `goal.updated` event.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `objective` | body | string | **Required.** New objective; surrounding whitespace is trimmed |

On success, `data` is the updated goal snapshot, in the same camelCase shape as `GET /api/v1/sessions/{session_id}/goal`.

- `40401`: session not found
- `40914`: no current goal
- `40915`: the goal is complete
- `40917`: the objective is empty
- `40918`: the objective exceeds 4000 characters

### `GET /api/v1/sessions/{session_id}/warnings`

Reads session-level warnings. The current producer is the oversized `AGENTS.md` check (`agents-md-oversized`), so the list is empty for most sessions.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |

On success, `data` is `{ warnings }`, each entry `{ code, message, severity }` with `severity` one of `info` / `warning` / `error`.

- `40401`: session not found

### `GET /api/v1/sessions/{session_id}/runtime`

Reads the main agent's runtime binding — which runtime the session's agent loop runs on.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |

On success, `data` is `{ workspace_id, runtime_id }`.

- `40401`: session not found

### `POST /api/v1/sessions/{session_id}/runtime`

Switches the main agent's runtime binding.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `runtime_id` | body | string | **Required.** Target runtime id |

On success, `data` is the new binding `{ workspace_id, runtime_id }`.

- `40420`: no runtime with that `runtime_id`
- `40926`: the runtime exists but is unavailable

### `POST /api/v1/sessions/{session_id}/export`

Exports the session together with diagnostic logs as a zip attachment (`kimi-session-<id>.zip`). The response is a binary stream, not a JSON envelope — capabilities and failure semantics are covered under [Binary and streaming endpoints](./server-api-files.md#binary-and-streaming-endpoints).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `web_log` | body | string | Client log text to include in the archive, at most 256 KB UTF-8 |
| `desktop` | body | boolean | Also include the desktop host's log. Default `false` |

### `GET /api/v1/sessions/{session_id}/media/{file_id}`

Downloads a prompt media file (an image or other attachment referenced by the session's prompts) by file id; an id not yet committed to the session falls back to the staged uploads. The response is binary with `Range` support (206 on ranged requests) — see [Binary and streaming endpoints](./server-api-files.md#binary-and-streaming-endpoints) for the shared conventions; unlike the enveloped endpoints there, a missing session or file answers with a real 404 status carrying an envelope body.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `file_id` | path | string | **Required.** Media file id |

### Session cron, environment, file history, and rating

Session-scoped companions to the tools of the same name; the three `cron` endpoints are the REST analogue of the `CronCreate` / `CronList` / `CronDelete` tools.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/cron` | List the cron tasks scheduled for a session |
| `POST /api/v1/sessions/{session_id}/cron` | Schedule a cron task for a session |
| `DELETE /api/v1/sessions/{session_id}/cron/{task_id}` | Remove a cron task from a session |
| `GET /api/v1/sessions/{session_id}/environment` | Get the main agent's environment binding |
| `GET /api/v1/sessions/{session_id}/environments` | List the environments available to the session |
| `GET /api/v1/sessions/{session_id}/file-history/changes` | List one turn's file changes from the turn-level file history |
| `GET /api/v1/sessions/{session_id}/file-history/content` | A file's content as captured at a turn's file-history checkpoint |
| `POST /api/v1/sessions/{session_id}/rating` | Evaluate the latest completed transcript turn, or report a displayed rating and its final answer |

`POST /api/v1/client_configs` is not session-scoped: it fetches a named cloud-controlled client configuration (for example `model_switch_confirm`) and answers `{ name, config: null }` for a name that is not registered.

## Messages and transcript

The `messages` endpoints page the main agent's flattened message history, while the `transcript` endpoints serve the structured per-agent transcript — turns, interactions, attachments — that the WebSocket [Transcript protocol](./server-api-conversation.md#transcript-protocol) streams live. Use these endpoints for history paging and catch-up, and the WebSocket subscription for the live tail.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/messages` | Page messages (`before_id` / `after_id` / `role`) |
| `GET /api/v1/sessions/{session_id}/messages/{message_id}` | Read one message |
| `GET /api/v1/sessions/{session_id}/transcript` | Turn-paged transcript (requires `agent_id`); global state rides along unpaginated |
| `GET /api/v1/sessions/{session_id}/transcript/ops` | Op-batch catch-up (`since_seq`); `complete: false` means a full refresh is needed |
| `GET /api/v1/sessions/{session_id}/transcript/user-messages` | Turn-opening user inputs, unpaginated |
| `GET /api/v1/sessions/{session_id}/transcript/plan` | ExitPlanMode plan content, path, and review outcome |

### `GET /api/v1/sessions/{session_id}/messages`

Pages the main agent's message history — the flattened context transcript — newest first. Cursor pagination follows [Pagination](./server-api.md#pagination); reading the history resumes the session when it is cold.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `before_id` | query | string | Only messages older than this message id; mutually exclusive with `after_id` |
| `after_id` | query | string | Only messages newer than this message id; mutually exclusive with `before_id` |
| `page_size` | query | integer | 1–100. Default `50` |
| `role` | query | string | Keep only one role: `user` / `assistant` / `tool` / `system`. The filter applies after the page is sliced, so a filtered page can hold fewer than `page_size` items while `has_more` is still `true` — keep paging until `has_more` is `false` |

On success, `data` is `{ items, has_more }` where each item is a message object `{ id, session_id, role, content, created_at, prompt_id?, parent_message_id?, metadata? }`; `content` is an array of content parts in the wire format documented under [Prompts](#prompts) (`text`, `tool_use`, `tool_result`, `image`, `video`, `file`, `thinking`).

- `40001`: validation failure — for example `before_id` combined with `after_id`
- `40401`: session not found

### `GET /api/v1/sessions/{session_id}/messages/{message_id}`

Reads one message from the same history by id.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `message_id` | path | string | **Required.** Message id |

On success, `data` is the message object in the item shape documented under `GET /api/v1/sessions/{session_id}/messages` above.

- `40401`: session not found
- `40403`: no message with that id in this session

### `GET /api/v1/sessions/{session_id}/transcript`

Returns one page of an agent's structured transcript: turns (with their steps and frames) plus the markers between them. Live sessions answer from the in-memory store (the requested agent's persisted history is backfilled first); cold sessions rebuild the agent from the persisted wire records. This is the history half of the transcript surface — the live streaming half is the [Transcript protocol](./server-api-conversation.md#transcript-protocol) subscription.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `agent_id` | query | string | **Required.** Agent whose transcript to read; must be a plain agent id (letters, digits, `.`, `_`, `-` — no path separators) |
| `before_turn` | query | string | Only turns older than this turn id; mutually exclusive with `after_turn` |
| `after_turn` | query | string | Only turns newer than this turn id; mutually exclusive with `before_turn` |
| `page_size` | query | integer | 1–100 turns. Default `20` |

The page unit is the turn: without a cursor the newest page is returned, and `has_more` reports that older turns remain. On success, `data` is `{ agent_id, items, has_more, interactions, attachments, agents, pending_interactions, seq? }` — `items` is the paged turn slice, `interactions` / `attachments` / `agents` / `pending_interactions` are global agent state that ships unpaginated with every response, and `seq` is the agent's op-batch watermark for resuming the stream (live sessions only). Tasks, the agent's status and settings, context usage, the goal, and the todo list are not part of the transcript; they arrive as the WebSocket `task`, `agent`, `usage`, `goal`, and `todo` frames (see [Events](./server-api-conversation.md#events)).

- `40001`: validation failure — `before_turn` combined with `after_turn`, or a non-plain `agent_id`
- `40401`: session not found

### `GET /api/v1/sessions/{session_id}/transcript/ops`

Serves point-to-point catch-up from the server's op journal: the journaled op batches with `seq > since_seq` for one agent, oldest first. It is the REST counterpart of the `transcript_since` resume cursor described in [Transcript protocol](./server-api-conversation.md#transcript-protocol) and shares the same bounded journal, so the same fallback rule applies.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `agent_id` | query | string | **Required.** Agent id (plain id, same constraint as the transcript endpoint) |
| `since_seq` | query | integer | **Required.** The caller's last applied op-batch seq, minimum `0`; batches above it are returned |

On success, `data` is `{ agent_id, batches, latest_seq, complete }`, each batch `{ seq, ops }`. `complete: true` means every batch up to `latest_seq` is present; `complete: false` means the journal no longer reaches back to `since_seq` (or the session is not live at all), and the caller must fall back to a full `GET .../transcript` refresh.

- `40001`: validation failure
- `40401`: session not found

### `GET /api/v1/sessions/{session_id}/transcript/user-messages`

Lists every turn-opening input of the session, grouped per agent and unpaginated: real user text, user-slash skill and plugin commands, and cron prompts — distinguishable via `origin` — plus attachment-only prompts projected with an empty `prompt`. Attachment entities referenced by the listed messages ride along (metadata only, never bytes).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `agent_id` | query | string | Read one agent only (plain id). Default reads every rostered agent |

On success, `data` is `{ agents }` where each entry is `{ agent_id, messages, attachments }`; a message is `{ turn_id, ordinal, state, origin, prompt, attachment_ids?, started_at? }` with `state` the turn state (`queued` / `running` / `completed` / `failed` / `cancelled`).

- `40001`: validation failure — a non-plain `agent_id`
- `40401`: session not found

### `GET /api/v1/sessions/{session_id}/transcript/plan`

Reads the plan information of an agent's `ExitPlanMode` tool calls — plan content, plan file path, offered options, and the review outcome — in timeline order. Content is projected from the first available fact: the linked approval interaction (interactive reviews), the live tool frame's display (auto mode), or the tool result output text; each entry records which one in `source`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `agent_id` | query | string | **Required.** Agent id (plain id) |
| `tool_call_id` | query | string | Narrow the read to one `ExitPlanMode` call; absent lists every call with recoverable plan content |

On success, `data` is `{ agent_id, plans }` where each plan is `{ tool_call_id, turn_id, source, plan, path?, options?, review? }`: `source` is `interaction` / `display` / `output`, `options` are the review choices as `{ label, description? }`, and `review` (present only for interactive reviews) is `{ state, selected_option?, feedback? }` with `state` one of `pending` / `approved` / `rejected` / `cancelled`.

- `40001`: validation failure
- `40401`: session not found
- `40416`: `tool_call_id` given, but no `ExitPlanMode` call with that id exists

## Prompts

A prompt is one unit of user input: submitting one enqueues it on the session's main agent (or a named agent), a queued prompt can be steered into the active turn, and a running prompt can be aborted. Turn progress itself streams over the WebSocket [events](./server-api-conversation.md#events), not these endpoints.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/prompts` | Active and queued prompts |
| `POST /api/v1/sessions/{session_id}/prompts` | Submit a prompt (content-part array, optional model / permission-mode overrides) |
| `POST /api/v1/sessions/{session_id}/steer` | Steer message content directly into the active turn |
| `POST /api/v1/sessions/{session_id}/prompts:steer` | Steer queued prompts into the active turn |
| `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:abort` | Abort a running prompt |
| `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:steer` | Steer one queued prompt |

### `GET /api/v1/sessions/{session_id}/prompts`

Reads the main agent's prompt queue snapshot.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |

On success, `data` is `{ active, queued }`: `active` is the running prompt (`null` when idle) and `queued` lists the pending prompts in order. A prompt is `{ prompt_id, user_message_id, status, content, created_at }` with `status` one of `running` / `queued` / `blocked` / `failed` and `content` in the content-part format accepted by `POST /api/v1/sessions/{session_id}/prompts`.

- `40401`: session not found

### `POST /api/v1/sessions/{session_id}/prompts`

Submits a user prompt to the session. Media references are validated first, then the optional overrides are applied to the target agent — `model`, `thinking`, `permission_mode`, and `disabled_tools` — and the prompt is enqueued; the response returns as soon as the prompt is accepted, without waiting for the turn. With `skills`, the prompt runs as a bundled skill activation instead of a plain user prompt.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `content` | body | array | **Required.** Non-empty array of content parts; variants below |
| `agent_id` | body | string | Target agent. Default the main agent |
| `prompt_id` | body | string | Client-chosen prompt id; may be combined with `skills`. Identical concurrent requests share one submission, and successful responses are replayed for up to 10 minutes (bounded to 1024 requests per server). A different body or delivery route using that ID fails `40927`; replay is not durable across a server restart |
| `skills` | body | array | Bundled skill activations, at least 1 entry of `{ name, path?, args? }`; every skill must exist and be user-activatable. `path` selects a same-name variant from the session catalog |
| `model` | body | string | Model alias to switch the agent to |
| `thinking` | body | string | Thinking-mode effort level |
| `permission_mode` | body | string | `manual` / `yolo` / `auto` |
| `disabled_tools` | body | array | Tool names to disable for the session |

`metadata` is preserved with the prompt. `swarm_mode` is applied to the target agent; `plan_mode`, `goal_objective`, and `goal_control` are applied before enqueueing and require the main agent. Each `content` part is an object discriminated by `type`:

| Part | Fields | Description |
| --- | --- | --- |
| `text` | `text` | Plain text |
| `image` / `video` | `source` | Media input; `source` is one of `{ kind: "url", url, id? }`, `{ kind: "base64", media_type, data }`, `{ kind: "file", file_id }` (an upload from `POST /api/v1/files`), or `{ kind: "session_media", file_id }` (media already committed to this session) |
| `file` | `file_id`, `name`, `media_type`, `size` | A file attachment uploaded through `POST /api/v1/files` |

The schema also accepts the `tool_use`, `tool_result`, and `thinking` parts of the shared message format, but they are not meaningful in a user prompt. Unknown or mis-kinded `file_id` references are rejected before the prompt is created and before any override is applied.

On success, `data` is the accepted prompt `{ prompt_id, user_message_id, status, content, created_at }`.

- `40001`: validation failure — for example an unknown `model`, a `thinking` level the model does not support, or a `profile` field, since the agent profile is chosen only when the session is created
- `40110`: no provider configured yet — finish login first
- `40111`: the resolved provider has no credential (`details.provider_id`)
- `40112`: the provider's credential was rejected (`details.provider_id`)
- `40113`: the model could not be resolved (`details.model_id` / `details.provider_id` when known), or `thinking` is set without `model` while the session has no model
- `40401`: session not found
- `40407`: a referenced `file_id` does not exist (or does not match the part's media kind)
- `40415`: a `skills` entry names an unknown skill
- `40912`: the skill exists but cannot be activated by the user
- `40927`: `prompt_id` belongs to a different request, or its replay response is no longer retained

### `POST /api/v1/sessions/{session_id}/steer`

Directly steers message content into the active turn in one request, without a separate submit-then-steer round trip. The body accepts the same fields as `POST /api/v1/sessions/{session_id}/prompts`, including `content`, `agent_id`, `prompt_id`, `skills`, `model`, `thinking`, `permission_mode`, and `disabled_tools`. Media references and bundled skills use the same validation and preparation path as prompt submission.

On success, `data` is the accepted prompt in the same shape as `POST /api/v1/sessions/{session_id}/prompts`. Errors are the same as prompt submission, including validation, media, environment, and idempotency failures.

### `POST /api/v1/sessions/{session_id}/prompts:steer`

Steers queued prompts into the active turn, so the running turn consumes them immediately instead of finishing first.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `prompt_ids` | body | array | **Required.** Non-empty array of queued prompt ids |

On success, `data` is `{ steered: true, prompt_ids }`.

- `40001`: validation failure
- `40401`: session not found
- `40402`: a listed prompt id is not in the queue

### `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:abort`

Aborts a running prompt. This endpoint and `:steer` below dispatch through one route, `POST /api/v1/sessions/{session_id}/prompts/{tail}`: the tail is parsed as `{prompt_id}:{action}`, and a missing or unknown action fails `40001` (`unsupported action: ...`).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `prompt_id` | path | string | **Required.** Prompt id |

On success, `data` is `{ aborted: true }`.

- `40401`: session not found
- `40402`: no prompt with that id
- `40903`: the prompt already completed; `data` carries `{ aborted: false }`

### `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:steer`

Steers one queued prompt into the active turn — the single-prompt form of `POST /api/v1/sessions/{session_id}/prompts:steer`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `prompt_id` | path | string | **Required.** Queued prompt id |

On success, `data` is `{ steered: true, prompt_ids: [prompt_id] }`.

- `40401`: session not found
- `40402`: no queued prompt with that id

## Approvals and questions

Approvals and questions are the session's two pending-interaction kinds: an approval asks permission for a tool call, a question asks for structured input with labeled options. Over the WebSocket, every change arrives as an `interaction` event (see [Events](./server-api-conversation.md#events)), and one endpoint responds to either kind.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}` | Respond to an approval or a question |

### `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}`

Responds to a pending approval or question. The body's `kind` must match the interaction's kind; the response for a sub-agent's interaction is routed back to that agent, so no `agent_id` is needed. Clients should close the card on the `interaction` event with `status: "ended"` rather than on this response, so every client watching the session closes it together.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `interaction_id` | path | string | **Required.** The event's `interaction_id` |
| `kind` | body | string | **Required.** `approval` / `question` |

With `kind: "approval"`:

| Parameter | Type | Description |
| --- | --- | --- |
| `decision` | string | **Required.** `approved` / `rejected` / `cancelled` |
| `scope` | string | With `approved`, `session` (the only value) also remembers the approval rule for the rest of the session |
| `feedback` | string | Free-form feedback handed back to the agent |
| `selected_label` | string | The label of the chosen option, when the request offered labeled choices (for example a plan review) |

With `kind: "question"`, send exactly one of `answers` and `dismissed`:

| Parameter | Type | Description |
| --- | --- | --- |
| `answers` | object | Map of question item id (`q_0`, …) to an answer object; variants below |
| `dismissed` | `true` | Dismiss the question without answering it |
| `method` | string | How the answer was produced: `enter` / `space` / `number_key` / `click` |
| `note` | string | Free-form note attached to the response |

Each answer is an object discriminated by `kind`:

| Kind | Fields | Description |
| --- | --- | --- |
| `single` | `option_id` | One chosen option |
| `multi` | `option_ids` | Several chosen options (at least 1) |
| `other` | `text` | A free-text answer |
| `multi_with_other` | `option_ids`, `other_text` | Options plus free text |
| `skipped` | — | The item was skipped |

On success, `data` is `{ outcome, ended_at }`, where `outcome` is `approved` / `rejected` / `cancelled` for approvals and `answered` / `dismissed` for questions.

- `40001`: validation failure (`details` lists each field), or `kind` does not match the interaction
- `40401`: session not found
- `40404`: no interaction with that id in the session
- `40902`: the interaction has already ended — answered by another client, or cancelled because its turn ended or its agent closed
