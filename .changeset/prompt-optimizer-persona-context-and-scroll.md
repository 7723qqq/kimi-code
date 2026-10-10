---
'@moonshot-ai/kimi-code': minor
'@moonshot-ai/kimi-code-sdk': minor
---

Ctrl+P rewrites in the draft's own voice, with a scrollable preview

The rewrite used to run as a fork of the main agent, which inherits the coding
agent's system prompt and its whole conversation. So the model that was asked to
"rewrite the user's draft" was reading a prompt built for editing files and
running commands, then a second copy of the recent conversation was appended in
text. A Chinese draft could come back in English, a one-line draft could come
back as a paragraph, and the two copies of the history pushed the actual draft
further from the model's attention.

Rewrites now run under their own `promptOptimizer` profile whose system prompt is
the rewriting instruction itself, with no coding-agent persona layered above it.
The instruction states what the rewrite must preserve: the draft's language, its
intent and scope, and its length — a one-line draft stays a one-line draft — and
it returns a draft that is already clear unchanged rather than padding it. It
also forbids adding requirements the user did not imply, which is the failure
mode that would make such a feature actively harmful.

The conversation is no longer fed twice. `fork()` keeps copying history — that is
what a fork is for — but it now takes an `inheritedHistory.maxUserTurns` window,
and the optimizer asks for the most recent turns only. `optimizePrompt`'s
`recentTurns` argument and the REST `recent_turns` field keep their existing
meaning and keep working; they now size that window instead of being pasted into
the prompt, so the engine's `PROMPT_OPTIMIZER_MAX_CONTEXT_TURNS` is the single
authority for how much context is considered rather than a constant nothing read.

The rewrite preview scrolls. Previously the panel rendered every diff row it
built and the terminal clipped whatever did not fit, so on a long rewrite the part
you could not see was simply unreachable. It now renders a window: Up/Down scroll
by a row, PageUp/PageDown by a page, Home/End jump to the ends, and the mouse
wheel scrolls. A `showing X-Y of Z` line reports the window. Because Up/Down now
scroll, the accept/discard choice moves to Left/Right and Tab (Tab already worked).

Pressing Ctrl+P on an empty input box now says a prompt is needed instead of
appearing to do nothing.

The optimizer's child may now call Read, Glob and Grep to resolve a file or module
the draft names. Everything else — writes, edits, shell, delegation — is still
denied, both by the profile's tool list and by the runtime veto, so the child
cannot change anything even if a tool slips past the list.

Compatibility: `session.optimizePrompt` and the REST `POST
/api/v1/sessions/{id}:optimize` action accept the same inputs as before. Passed
`recentTurns`/`recent_turns` still narrows how much conversation the rewrite sees.
The preview panel's Up/Down keys now scroll rather than move the selection;
Left/Right and Tab move it, so a keyboard-only accept is unchanged.
