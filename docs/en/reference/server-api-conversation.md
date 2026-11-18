# Sessions and conversations

This page describes `/api/v1/ws`. REST endpoints are documented in [Session endpoints](./server-api-sessions.md); authentication and shared conventions are in [Server API](./server-api.md).

## Connect

Connect to `ws://<host>:<port>/api/v1/ws`, authenticating the upgrade request. No `client_hello` or `server_hello` handshake is required or emitted.

The server sends `ping` every 10000 ms by default; answer with `pong`. Two silent intervals close the connection with code `1001` (`heartbeat timeout`). Any inbound frame counts as activity. Heartbeats use a monotonic clock; after an event-loop stall longer than 1.25 intervals the server grants a fresh response window, and processes queued input before disconnecting.

## Control frames

All requests are flat JSON objects. Fields sit beside `type`, not inside `payload`:

```json
{"type":"subscribe","request_id":"sub-1","session_id":"session_…","agent_ids":["main"]}
```

Replies are `{ "type": "response", "request_id", "code", "msg"? }`. Code `0` means success. A recognized command without a nonempty `request_id` closes the socket with code `1008`; malformed command fields return `40001`. Unknown frame types are ignored.

| Type | Fields beyond type/request_id | Effect |
| --- | --- | --- |
| `subscribe` | `session_id, agent_ids?` | Subscribe to the conversation projection; defaults to `main` when transcript options are absent |
| `unsubscribe` | `session_id, agent_ids?` | Remove selected agents; omitting agent_ids removes the session subscription |
| `subscribe` | `session_id, transcript, transcript_since?` | Subscribe to the retained transcript protocol described below |
| `task.watch` | `session_id, agent_id, task_id, since_offset?, tail_bytes?` | Subscribe to one task's output |
| `task.unwatch` | `session_id, agent_id, task_id` | Stop watching its output |
| `task.stop` | `session_id, agent_id, task_id` | Stop a task |
| `task.background` | `session_id, agent_id, task_id` | Release the foreground caller while the task continues |

`subscribe_v2`, `unsubscribe_v2`, nested payload commands, and `ack` are not this protocol. Subscribe/unsubscribe commands are serialized per connection. Successful subscription responses precede initial conversation and pending-interaction frames. Clients may clear pending interactions on that response and then rebuild them from subsequent frames.

Task responses may additionally contain `task`. Commands for the same task are serialized. A successful watch responds first, sends the last `tail_bytes` bytes (default 32 KiB, maximum 1 MiB, restricted by `since_offset`), then live `task.output` frames. Ended tasks remain watchable. Errors include `40401` (session), `40406` (task), `40941` (cannot background), `50003` (output unreadable).

## Conversation projection

Conversation frames carry `session_id`, `agent_id`, and `event_created_at`. The initial `turns` frame contains `{ turns, has_more }`; older pages use `GET /api/v1/sessions/{session_id}/agents/{agent_id}/turns?before_ordinal=…&page_size=…`.

| Frame | Additional fields |
| --- | --- |
| `turn.started`, `turn.ended` | `turn` header |
| `turn.updated` | `turn_id, step?, retry?` |
| `item.started`, `item.ended` | `turn_id, item` |
| `item.updated` | `turn_id, item_id, set` |
| `item.delta` | `turn_id, item_id, field, delta`; field is text/input_text/output |
| `item.removed` | `turn_id, item_id` |
| `turns.removed` | `turn_ids` |
| `turns.failed` | `code, msg` |
| `notice` | `level, title, detail?, code?` |

Apply deltas to the named item, and replace it with the final `item.ended` item rather than appending its text again. Events arriving during initial page loading are buffered until that page is sent. A failed page sends `turns.failed` and releases the listener; unsubscribe or close invalidates pending delivery.

The projection is derived from recorded events, not the current model context. Turns preserve recorded `turn_number`, timestamps, steps and usage; items preserve step identities, reasoning timing, media and tool notes. Context compaction adds a system item without deleting earlier visible history. Retry removes the abandoned attempt's text by its step ID, including when the execution engine assigns the next attempt a new step number. Clear and undo remove their corresponding history. Legacy messages without step metadata remain unnumbered rather than receiving fabricated steps.

Tool calls use stages `input`, `awaiting_approval`, and `executing`. Optional `interaction_id`, `task_id`, and `agent_refs` come from recorded associations, never parsed from prose. Progress updates include official `fields` (`status`, `statusReplace`, `progress`) and the fork's `progress` extension. Task associations survive replay. Missing turns and agents have distinct error codes: `40422` and `40421` respectively.

## Agent, task and interaction frames

The server also sends full-value flat frames `{ type, session_id, agent_id, event_created_at, … }`:

- `agent`: `status: idle|running`, `compacting`, optional model/thinking/permission_mode, and boolean plan_mode/swarm_mode/tower_mode. Compaction start, completion and cancellation refresh `compacting`.
- `usage`: `context_tokens, max_context_tokens?`, coalesced during rapid updates.
- `goal`: optional goal with objective, status, completion_criterion, turns_used, tokens_used and wall_clock_ms.
- `todo`: `items: [{title,status}]`.
- `task.list`, `task`: current task inventory and updates. `task.output` is sent only to task watchers.

`interaction` carries `interaction_id`, `kind: approval|question`, `status: pending|ended`, optional outcome/ended_at/tool_call_id, `request`, and optional `response`. Pending interactions are resent after subscription succeeds. Respond via `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}`. Approval outcomes are approved/rejected/cancelled; question outcomes are answered/dismissed/cancelled.

Global lifecycle events remain envelope-shaped `{type,seq,session_id?,timestamp,payload,…}` and go to every connection: session metadata/activity, workspace, configuration and model-catalog updates. Conversation subscriptions suppress legacy turn envelopes for those agents; do not interpret the legacy envelope's `turn.started` as a conversation header.

## Reconnect and recovery

Subscriptions do not survive disconnects. Reconnect and send flat `subscribe` again; each requested agent receives a fresh `turns` page plus agent/task state and pending interactions. Replace the local baseline and apply subsequent item frames. The durable conversation is shared by live delivery and cold restoration.

## Transcript protocol

The fork retains Operation Log/transcript clients through `subscribe` with `transcript` grades `off|turn|block|delta` (`"*"` is the default grade). They receive `transcript.reset` and `transcript.ops`, with per-agent sequence numbers. Use `transcript_since` on reconnect; if the operation journal cannot cover a gap, refresh the baseline. REST counterparts are `GET …/transcript` and `GET …/transcript/ops?since_seq=…`. This is separate from the official conversation projection, not a replacement for its turn/item frames.
