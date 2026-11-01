---
"@moonshot-ai/kimi-code": patch
---

Localize the workspace-directory startup notice, the video-too-large paste error, the migration failure reasons, and the headless `kimi migrate` output, in both English and Chinese.

`check-no-hardcoded-prose` now scans all of `apps/kimi-code/src` instead of only `tui`, `cli`, and `session-import`, so hardcoded copy in `utils/`, `native/`, `migration/`, and the root entry files is caught instead of passing every gate. The widened scan also records the developer diagnostics it finds for the first time (`native/` manifest errors, `feedback/` upload failures, `open-url` spawn errors); they stay English by design and now carry a ledger entry, so the count is visible and can only shrink.
