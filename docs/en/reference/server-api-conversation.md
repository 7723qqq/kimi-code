# Sessions and conversations

This page describes the WebSocket protocol at `/api/v1/ws`: connecting, the heartbeat, control frames, event frames, reconnect behavior, and the transcript protocol. REST endpoints for sessions and messages are in [Session endpoints](./server-api-sessions.md); shared conventions are in [Server API](./server-api.md).

## Connect

The only endpoint is `ws://<host>:<port>/api/v1/ws`; authentication happens at the upgrade request (see [Authentication](./server-api.md#authentication)). Once connected, the server immediately sends `server_hello`:

```json
{
  "type": "server_hello",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "payload": {
    "ws_connection_id": "conn_01JZX4...",
    "protocol_version": 2,
    "heartbeat_ms": 10000,
    "max_event_buffer_size": 1000,
    "capabilities": { "event_batching": false, "compression": false }
  }
}
```

The server sends a `ping` frame every `heartbeat_ms` (10000 ms by default) and the client must answer with a `pong`. If no inbound frame arrives within two heartbeat intervals — about 20 seconds — the server closes the connection with code `1001` and reason `heartbeat timeout`. Reconnection is still the client's job.

To avoid disconnecting healthy connections, the server also does the following. Clients do not need to do anything:

- **System time does not matter**: the server times heartbeats on a monotonic clock (a clock that only moves forward and is not affected by changes to the system time), so changing the system time or waking the machine from sleep does not make a connection time out.
- **Restart the clock after the server itself stalls**: while the server process is stalled it cannot send `ping`, so the client has nothing to answer. When the server resumes and finds more than 12.5 seconds (1.25 times the default interval) between two checks, it treats this as its own stall: instead of disconnecting, it sends a new `ping` and gives the client another 20 seconds to answer.
- **Read messages that already arrived before disconnecting**: a `pong` the client sent while the server was stalled may not have been read yet. Before disconnecting, the server processes messages that have already arrived and checks again; if the client answered, the connection stays open.

## Control frames

Clients send JSON frames `{ "type", "id"?, "payload" }`; every request frame gets an acknowledgement `{ "type": "ack", "id", "code", "msg", "payload" }`, where `code` 0 means success.

| Frame | payload | Description |
| --- | --- | --- |
| `subscribe_v2` | `{ session_id, transcript, transcript_since? }` | Subscribe to a session (the only session subscription): its transcript streams and interactions; `transcript` sets per-agent grades |
| `unsubscribe_v2` | `{ session_id, agent_ids? }` | Detach transcript streams; omitting `agent_ids`, or detaching the last agent, drops the whole session subscription |
| `client_hello` | `{ client_id }` | Handshake frame; other fields are ignored |
| `task.watch` | flat: `{ request_id, session_id, agent_id, task_id, since_offset?, tail_bytes? }` | Stream one task's output to this connection, no session subscription needed; `agent_id` is the agent that owns the task (the `agent_id` of its `task` frame), `since_offset` resumes after output the client already has, and `tail_bytes` caps the size of the first chunk |
| `task.unwatch` | flat: `{ request_id, session_id, agent_id, task_id }` | Stop streaming that task's output |
| `task.stop` | flat: `{ request_id, session_id, agent_id, task_id }` | Stop a task; an ended task just replies with its state |
| `task.background` | flat: `{ request_id, session_id, agent_id, task_id }` | Stop the starting tool call from waiting so the task keeps running in the background; a task already in the background or ended just replies with its state, and a task its caller cannot stop waiting for, such as an AgentSwarm member, fails with `40941` |

`task.watch`, `task.unwatch`, `task.stop`, and `task.background` are flat: their fields sit next to `type` instead of under `payload`, `request_id` replaces `id`, and the reply is `{ "type": "response", "request_id", "code", "msg"?, "task"? }` instead of an ack; a frame without a readable `request_id` closes the socket with code 1008. On success, `task.watch`, `task.stop`, and `task.background` carry the task's current state in `task` (the `task` frame shape below, without `type`, `session_id`, `agent_id`, and `event_created_at`). Requests for the same task are handled one at a time in arrival order, so a `task.unwatch` sent while a `task.watch` is still pending takes effect after it; different tasks, and other control frames, never wait on each other. A successful `task.watch` replies with code 0, then sends the last `tail_bytes` of output (32 KiB by default, at most 1 MiB; only the part after `since_offset` when it falls inside that window) as one `task.output` frame, with empty `text` when there is nothing to send, followed by live output; ended tasks can be watched too. Errors: `40001` malformed frame (including an out-of-range `tail_bytes`), `40401` session not found, `40406` the agent has no such task, `40941` the task cannot be moved to the background (its reply still carries the task state), `50001` internal error, `50003` output unreadable.

## Events

Event frames look like `{ "type", "seq", "epoch"?, "volatile"?, "offset"?, "session_id"?, "timestamp", "payload" }`, where `type` is the event type itself. Two delivery scopes:

- **Global events**: sent to every established connection, no subscription needed — `session.meta.updated`, `event.session.created`, `event.session.archived`, `event.session.restored`, `event.session.work_changed`, `event.session.status_changed`, `event.workspace.*`, `event.config.*`, `event.model_catalog.*`.
- **Session frames**: sent only to connections subscribed to that session with `subscribe_v2` — `transcript.reset` / `transcript.ops` (see [Transcript protocol](#transcript-protocol)), `task.list`, `task`, `agent`, `usage`, `goal`, `todo`, and `interaction`. `task.output` goes only to connections watching that task with `task.watch`.

| Family | Main events |
| --- | --- |
| Turns | `turn.started`, `turn.ended`, `turn.step.started` / `completed` / `interrupted` / `retrying` |
| Streaming text | `assistant.delta`, `thinking.delta` (carry `offset` for alignment) |
| Tool calls | `tool.call.started`, `tool.call.delta`, `tool.progress`, `tool.result` |
| Interactions | `interaction` |
| Subagents | `subagent.spawned` / `started` / `suspended` / `completed` / `failed` / `cancelled` |
| Background | `task.started` / `terminated`, `shell.started` / `output` / `completed` |
| Misc | `compaction.*`, `skill.activated`, `goal.updated`, `prompt.*`, `error`, `warning` |

Several global lifecycle events keep a cross-workspace overview fresh without polling per workspace. `event.session.archived` fires on both the live and the cold archive path; its envelope `session_id` is the global watermark `__global__` and the real session id rides in the payload: `{ "type": "event.session.archived", "workspace_id": "wd_...", "sessionId": "session_..." }` (payload keys `workspace_id` / `sessionId`). `event.session.restored` fires when an archived session is restored, on the same paths and with the same envelope and payload keys. `event.workspace.created` / `updated` carry the full workspace object (`{ id, root, name, created_at, last_opened_at, session_count }` — an `updated` also fires when a session creation touches the workspace), and `event.workspace.deleted` carries `{ "workspace_id", "root" }`. These events only cover changes made inside this server process; changes from other processes (for example a CLI writing to the same home) surface through the index reconciliation (about a minute), so overview clients should keep a low-frequency fallback poll. There is no session-deleted event.

Events also split into durable and volatile: durable events carry a strictly increasing `seq`, are journaled, and can be replayed; volatile events (the `*.delta` family, `tool.progress`, `shell.*`, and similar) are marked `volatile: true` and never replayed. When consuming a volatile text stream, compare `offset` (the cumulative character offset within the turn) against your locally accumulated text: below the local length means a duplicate frame; above means a gap that needs snapshot recovery.

An agent's own state is synced by four more flat frames, each carrying the full value and replacing the client copy; like the task frames they are never replayed. When a connection starts receiving an agent (the same rule as `task.list`), it first gets the current `agent`, `usage` (when the agent has a model context), `goal` (main agent only), and `todo` frames, and after that each frame again whenever its value changes; an agent that joins the session later announces itself with the same frames. Subscribing to a session creates its main agent if it does not exist yet, so the main agent's frames always follow the subscription. All four are `{ type, session_id, agent_id, event_created_at, ... }`:

- `agent`: `{ status: "idle" | "running", model?, thinking?, permission_mode?, plan_mode, swarm_mode, tower_mode }`. `status` follows the agent's turns, and the frame for a turn's start or end is sent after the `transcript.ops` batch of that same turn change. The three mode fields are booleans.
- `usage`: `{ context_tokens, max_context_tokens? }`. Only the latest value matters, so while the context grows the server sends it at most a few times per second.
- `goal`: `{ goal? }`, where `goal` is omitted when the session has none, or is `{ objective, status: "active" | "paused" | "blocked" | "complete", completion_criterion?, turns_used, tokens_used, wall_clock_ms }`.
- `todo`: `{ items: [{ title, status: "pending" | "in_progress" | "done" }] }`, read from the agent's todo store, so it follows undo and survives a restart.

Approvals and questions from every agent in the session, sub-agents included, arrive as the `interaction` frame. Unlike other events it is flat — no `seq`, `timestamp`, or `payload` wrapper — and it is never journaled or replayed: `{ type: "interaction", session_id, agent_id, event_created_at, interaction_id, kind: "approval" | "question", status: "pending" | "ended", outcome?, ended_at?, tool_call_id?, request, response? }`. `outcome` is `approved` / `rejected` / `cancelled` for approvals and `answered` / `dismissed` / `cancelled` for questions. An approval's `request` is `{ tool_name, action, tool_input_display?, expires_at }`, where `expires_at` is 24 hours after the request; a question's is `{ questions }`, holding 1–4 items `{ id, question, header?, body?, options, multi_select?, allow_other?, other_label?, other_description? }`, each with 2–4 `options` of `{ id, label, description? }`. The server sends the session's pending interactions right after each successful `client_hello` / `subscribe` / `subscribe_v2` ack, so clients should drop their pending list for that session on the ack and rebuild it from the frames that follow. Respond through [`POST /api/v1/sessions/{session_id}/interactions/{interaction_id}`](./server-api-sessions.md#post-api-v1-sessions-session-id-interactions-interaction-id).

## Reconnect and recovery

After reconnecting, resubscribe with `subscribe_v2`; the server answers with a fresh `transcript.reset` for each agent you ask for, so local state is rebuilt from that baseline instead of replayed from a cursor. Global push events resume as soon as the socket is open.

## Transcript protocol

`subscribe_v2`'s `transcript` field sets a per-agent grade: `off` / `turn` / `block` / `delta` (the `"*"` key sets the default grade), with higher grades pushing finer detail. An agent with a non-`off` grade receives two frame types: `transcript.reset` (a baseline snapshot; history pages in over REST) and `transcript.ops` (incremental op batches with a per-agent strictly increasing `seq`). The agent's legacy events are suppressed on that connection and carried by transcript frames instead. After a disconnect, resume with `transcript_since`; when the server's op journal cannot cover the gap (REST catch-up returns `complete: false`), do a full refresh. The REST counterparts are `GET .../transcript` (turn-paged) and `GET .../transcript/ops?since_seq=` (op-batch catch-up). Subscriptions do not survive a disconnect: after reconnecting, send `subscribe_v2` again for each session, and every agent's `task.list`, `agent`, `usage`, `goal`, and `todo` frames are sent again.
