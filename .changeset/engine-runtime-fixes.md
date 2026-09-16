---
"@moonshot-ai/kimi-code": patch
---

Five fixes found by driving the real engine rather than the test suite.

A turn's assistant message could be dropped from the history, leaving its tool results orphaned — the provider then rejected every later request with `tool result's tool id(...) not found` and the session could not be continued. The turn loop moved its per-turn reminders to the end of the message list, which shifted the index the session folded the turn result by. Reminders now stay where they are appended, and a compaction anchors its continuation before them instead of re-appending the whole set.

Reading a file that does not exist reported `tool "Read" is host-owned and not yet wired on the native harness` instead of naming the path: the native read declined the call, and a declined call is forwarded to a host that has no file-tool runtime. A missing path, an unreadable file and a binary file are now tool errors with the wording v2 uses.

`EnterPlanMode` reported success while `ExitPlanMode` refused to run: the plan state was written to the engine's own store and read back from the host, so the two never met. The host now serves the plan write through the same path `/plan` uses, and reports the plan id and path on the read so the model is told which file to write.

The workspace AGENTS.md reminder was re-injected on every turn — the dedup flag lived on a provider rebuilt each turn. It now reads the paths an earlier reminder already named, the way v2 reads them off the last injection's disclosure.

The default-approve list had drifted to the read-only file tools, so `TodoList`, `EnterPlanMode`, `ExitPlanMode`, `ReadMediaFile`, `Agent`, `Skill`, `AskUserQuestion` and the goal and task readers all asked for approval where v2 approves them outright.
