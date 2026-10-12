---
'@moonshot-ai/kimi-code': patch
---

Stop an interrupted provider edit from deleting the provider it was editing

A provider edit is a pair of writes: the old record is removed — only that call
can drop the aliases a rename or a shrunk model list leaves behind — and the
patch that replaces it is applied. On the v2 engine `setConfig` persists one
domain at a time, so a process that exited, or an error that surfaced, between
the two calls left `config.toml` with the provider and every one of its aliases
gone and the edited version never written.

`/provider` → edit, `/provider` → add → known, `kimi provider update` and
`kimi provider catalog add` now fold the removal into the patch and land the
whole result in ONE section replace, the same shape `/login`'s provider refresh
already uses. A host that cannot replace sections keeps the two-call pairing,
each call atomic on its own; both shapes are pinned by a test to leave an
identical config, so which host you are on changes how many writes land and
never what the file ends up saying.

**Behaviour change**: on the v2 engine a catalog re-import now really clears
`default_model` when the alias it pointed at no longer exists. The old code
resolved that value and handed it to `setConfig`, which skips an `undefined`
domain — so the stale pointer stayed on disk and the next launch started on a
default model that does not resolve. Clearing it is what the code already meant
to do. `[thinking]` is not named by the one-write path, which reaches the same
outcome as the old restore without pinning a value that came from another config
layer.
