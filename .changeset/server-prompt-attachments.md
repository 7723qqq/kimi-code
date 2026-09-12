---
'@moonshot-ai/kimi-code': minor
---

Accept prompt attachments on the local server's `POST /api/v1/sessions/{id}/prompts`. The new plural route parses the protocol `content: MessageContent[]` submission, resolves uploaded `f_` blobs (and server-local `path` parts) into native media blocks (image / audio / video, with a text fallback for other files), and hands them to the engine as the turn's opening user message — previously uploaded files could be referenced but never reached the model. `GET /prompts` answers the active/queued envelope, `prompts/{id}:abort` cancels the running turn, and `prompts:steer` reports the prompt-not-found state (the native server runs a turn synchronously, so nothing is queued).
