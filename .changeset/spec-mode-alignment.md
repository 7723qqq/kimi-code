---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Align spec mode's behaviour with what its prompts promise, and repair the hosts it left broken.

Spec mode additions
- Spec mode never turned on live in the TUI: the status-event handler patched plan, swarm and tower mode but dropped `specMode`, so a spec started by the model itself left the indicator stale until the next session sync.
- The status line shows the spec stage (`spec:specify`, `spec:plan`, `spec:tasks`, `spec:implement`), and `SessionStatus` gained an optional `specStage`.
- `SpecSnapshot` gained an optional `progress`, so the spec's `progress.md` working note can actually be read by a host. It never gates completion.
- Entering spec mode could leave the mode recorded as active after reporting failure: the rollback flag was set after the last fallible statement, so it never fired.
- The reentry reminder no longer claims earlier documents are present, which was untrue when the directory simply already existed.

Hosts spec mode had broken
- `apps/vscode` did not compile: both switches over the tool-display kind lacked a `spec_review` case. Both now cover it and keep their exhaustiveness gate, so a kind added later is a build error rather than a silent fallback.
- `apps/vis` was missing the four spec wire records, which the web renderer's exhaustive map is designed to catch. The records are now carried through, and `specOps` is exported from the package entry point like its plan counterpart.
- `packages/acp-server` treated a spec review as an ordinary prompt, so an ACP client could not express "Revise" and was offered an "approve for this session" action the spec flow does not define. Spec reviews now get the same option set and option-id namespace as plan reviews.

Documentation
- Spec mode had no user-facing entry despite `/spec` being always available. `docs/*/reference/tools.md` now documents `EnterSpecMode` / `ExitSpecMode`, the write guard, the three required documents and the `progress.md` note, and `docs/*/reference/slash-commands.md` documents `/spec [on|off]`.
- The root `typecheck` script now includes `apps/kimi-web`, and both `CONTRIBUTING` files state exactly what it covers and what it does not.
