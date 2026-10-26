---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kap-server": minor
---

The Ctrl+P prompt rewrite no longer loses the user's data, and its errors say what happened

A pass over the whole rewrite path — engine, TUI panel, SDK and REST action — turned up four ways the feature could damage or misinform, plus a chain of context and error handling that the earlier shape had left disconnected.

**Nothing is replaced by a rewrite that saw less than the whole draft.** The engine used to clamp an over-long draft to its first 8000 characters and rewrite that, so accepting the result wrote a silent truncation back into the input box; the panel diffed against the full text and gave no sign that the tail was gone. The draft limit is now 4000 characters and exceeding it is a `prompt_optimizer.input_too_long` refusal, before any agent is forked. The engine used to derive the output ceiling from the same 8000 constant, so an input near the limit could not fit an output near the limit either; the two limits are now independent.

**A rewrite may no longer drop an attachment.** Image and video placeholders (`[image #1 (640×480)]`) are resolved back into attachments by id when the prompt is sent, so a rewrite that paraphrased or dropped one detached the file without saying anything. The TUI now compares the placeholder ids the store owns before and after, and refuses the rewrite rather than writing it back when one went missing. A `[image #99]` the user typed as ordinary prose is not an attachment and stays untouched.

**Ctrl+C during a rewrite cancels it and keeps the draft.** The controller never held a cancel handle and never passed a signal, and the editor's own Ctrl+C path clears the input box — so the key that reads as "stop" wiped the text and left the request running. The controller now registers a cancel handle and forwards an `AbortSignal` to `optimizePrompt`; Ctrl+C reaches it first.

**REST no longer reports every optimizer failure as `50001`.** The five `prompt_optimizer.*` codes had no wire equivalents, so the REST action collapsed all of them into `INTERNAL_ERROR` and logged an unmapped-code warning. They now have protocol codes (`40933`–`40939`), and the action is bound to the response's `close` event so a disconnecting client aborts the rewrite instead of leaving the throwaway agent running. This changes the response code for existing callers: a disabled optimizer is `40934`, not `50001`.

**`session.optimizePrompt` throws `KimiError`, and its errors are translated.** The SDK called the service without restating engine errors, so an `Error2` crossed the RPC boundary as-is; `isKimiError` is false for it, so the TUI's formatter fell back to the raw English message and the ten `prompt_optimizer.*` locale entries were unreachable. The call is now wrapped in `restateEngineError`, the same convention the rest of the SDK follows, which fixes both the error class and the localized copy.

**A rewrite now has a deadline.** A provider that hung left the editor marked "rewriting prompt…" and the in-flight guard held forever, so every later Ctrl+P answered "already in progress". The engine aborts the fork after 90 seconds and reports `prompt_optimizer.timeout` (retryable). The in-flight guard also no longer collapses callers without a `sessionKey` onto the empty key, where two different sessions used to lock each other out.

**The conversation now actually reaches the model.** The TUI collected recent user turns, capped each at 400 characters, and sent them — and the engine read only their length, using it as an `inheritedTurnLimit` that could not differ from the default it replaced. So the text never entered the prompt and the 400-character cap was dead code. Caller-supplied turns are now rendered into the prompt as a labelled block, the fork inherits no history for those calls, and the engine caps both the turn count and each turn's width, so the TUI and the engine agree by construction rather than by coincidence. Calls that send no turns keep the old fork-window behaviour.

**A rewrite that comes back too long is retried once instead of failing outright.** The model is asked to compress its previous answer, keeping every requirement; only a second over-limit answer raises `prompt_optimizer.output_too_long`. The rewrite is never truncated to fit — a half-sentence written into the input box is worse than an error.

**The draft is fenced and declared data.** Since the rewrite output goes back into the composer and is then sent as the user's own prompt, an instruction hidden in a draft would be laundered into higher apparent authority. The engine now wraps the draft in `<draft>` tags, states in the system prompt that everything between them is data rather than a directive, and escapes a draft that contains the closing tag itself so the fence cannot be broken from inside. The same prompt now also forbids headings, bullet lists (unless the draft is one), and any mention of the working directory or of the rewriting pass.

**Ctrl+P says the feature is off instead of failing.** The TUI kept the binding wired regardless of the `prompt_optimizer` flag, so pressing it with the experiment disabled produced an engine error. The controller now checks the flag first and says how to enable it, the shortcut's analytics record whether the flag was on, and `/help` renders Ctrl-P dimmed as "off" rather than advertising a key that only errors.

**Panel and telemetry.** The panel's chrome budget was 9 rows against a real frame of up to 12, so a tall preview could push the accept/discard choices off a short terminal; the budget now matches, and the expanded row cap is large enough that Ctrl+O always shows more even when wrapping was the limit (the notice says so). A rewrite identical to the draft now says the draft is already clear instead of returning silently, an empty result is no longer treated as success, and the analytics carry `code` on failure plus draft and rewrite sizes and elapsed time on accept.
