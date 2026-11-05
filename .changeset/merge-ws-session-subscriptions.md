---
"@moonshot-ai/kimi-code": minor
---

The WebSocket session subscription is now one path. `subscribe` / `unsubscribe` are gone and `subscribe_v2` is the only session subscription, carrying transcript streams and interactions; a reconnecting client resubscribes and receives a fresh `transcript.reset` instead of replaying from a cursor. Global events such as `event.session.work_changed` are pushed to every connection once the socket is open, without subscribing to a session first.

Removed with it: the `seq` / `epoch` / `volatile` envelope fields, `server_hello.max_event_buffer_size`, the `resync_required` frame, the session `last_seq` field, and `GET /api/v1/sessions/{session_id}/snapshot`. Read the main agent's state from the `agent`, `usage`, `goal` and `todo` frames and the transcript from the `transcript.*` frames instead.
