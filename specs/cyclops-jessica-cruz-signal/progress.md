# Web protocol alignment progress

Plan: implementation-plan.md. Baseline HEAD: ba1f054931; pre-existing dirty changes retained. No commit or push performed.

## Outcome and boundary

The official conversation migration is implemented: the existing machine engine's dispatcher owns the durable read model; live and restored conversations no longer rebuild from the trimmed model context. Operation Log/transcript routes remain separate and supported. The pinned dist-web is unchanged from f082f04a09 (`assets/index-Y30h7qWu.js`).

This is not certification of every Web feature. `client-compatibility.md` inventories all 128 methods of the pinned main API client and its socket commands. Rows not individually exercised retain an explicit unresolved client-mapping status even where subsystem regression tests passed. External OAuth, remote-control accounts, marketplace downloads and OS application launching were not exercised. Lazy-loaded features outside that API class are not claimed exhaustive.

## Implemented

- Participant replay lifecycle, opt-in mutable staging, custom undo, one final frozen publication after rehydration, recovery after failure, and late-disposal handling.
- Existing nonmutable participants keep their holder object usable; publication freezes a cloned value, not that holder.
- Initial restore gates live dispatch only when mutable participants exist. The gate opens before restore hooks; ordinary initial restores retain their existing immediate dispatch behavior.
- Recorded steps, turn numbers, timestamps, usage, reasoning timing, legacy content timing, tool notes/media, approvals, subagent refs and task links.
- Existing indexed tool lookup retained and reindexed after undo/retry; context-only authoritative rebuilding removed.
- Machine retry numbers differ from upstream: abandoned text is removed by recorded step ID rather than requiring a repeated step number.
- Official tool fields and agent compacting state added while retaining the fork's progress/transcript extensions.
- Session-scoped subscription response barrier, stale-generation/page buffering tests, close/unsubscribe cleanup, failed initial-page reporting and listener release.
- Turn-not-found remains 40422, distinct from agent-not-found 40421.
- Bilingual protocol docs corrected from obsolete subscribe_v2/ack/server_hello wording. Ledger #4663/#4730/#4772/#4789/#4893 and PLAYBOOK now describe the actual consumer and evidence.

## Evidence

Failures were reproduced before the corresponding fixes: missing record fold export, mutable publication during failed replay, subscription seed before response, machine retry retaining abandoned text, and unhandled initial-page rejection. Independent review found two additional concurrency defects (unrelated-session frame loss and live publication during initial rehydration); both were fixed, given regression tests and rechecked by the same reviewer with no remaining serious finding.

Focused dispatcher tests: 39 pass, including 1k/4k/8k record windows that require one staging object, one commit, unchanged old snapshots and frozen final arrays. Dispatcher plus undo previously passed together after the production fixes. Final fold/file-history focused tests: 24 pass. Transcript contract e2e: 12 pass; its two obsolete count-based undo calls now obtain and submit the actual turn_id. Plan-service timeout diagnosis: 30 pass in isolation.

The core package runner exited successfully after its documented isolated diagnostic reruns. The pooled pass reported 9095 pass / 102 skip / 3 fail (task reconciliation and two plan timeouts); six files were classified FLAKY(contention) by the runner and passed alone. This is not a claim of a clean no-flake pooled run. The plan file was also explicitly rerun alone (30 pass). An earlier single archive immediate-read failure did not reproduce in the final kap suite and is not claimed fixed.

Final kap package result including the added record cases: 1432 pass / 14 platform skip / 0 fail (1446 tests, 71 files). Core and kap typechecks, server build, final CLI build and smoke, docs build, comment-free/import boundaries, locale keys/placeholders/t-call coverage/prose gate, and structural orphan-export/text-as-protocol/stale-artifact/gate-wiring checks passed. Scoped oxlint reported 0 errors with existing warnings; not claimed warning-free.

## Actual official browser

REA launched isolated Edge/Chromium 157.0.4341.60 profiles against `startServer` with a local deterministic SSE provider and fixed test authentication. Every selected successful scenario reports owned-browser cleanup. No real provider credentials or user config were used.

`browser-verification.json` contains selected observations (not a complete authenticated REA bundle) for:

- Partial text visibly present before provider completion.
- Cold/reconnected history, including the retry defect reproduced from a real stream and corrected after restart.
- Approval visible, recovered after a browser reconnect, approved through the UI, real Bash output visible.
- Cancellation rendering Manually stopped.
- Fork retaining source history; undo removing the selected history and returning text to the composer.
- Compaction initiated by the real REST route while observing the page (not a claimed compactSession UI click); compacting state visible, then cleared, with earlier history retained. See compaction-browser.png.
- Real Write and per-turn file diff. The official client requested changes and start/end content with turn_number=2, matching the recorded Write turn. See file-history-browser.png.
- Captured socket order: response before task.list/agent/usage/goal/todo/turns; compacting=false in the restored agent frame.

Selected console captures contain no page-error; errors were expected pre-token 401 probes. UI-cancelled trust requests and unfinished background requests remain reported as such, not certified absent errors across every possible journey.

REA's static JavaScript worker failed on an unsupported --max-old-space-size flag; no valid semantic graph was produced. Direct AST/text inspection of the bundle was used instead, and no REA/system config was changed. Browser skill invocations initially hit a nesting limit; REA's owned browser scenario route supplied the actual UI evidence.

## Fixed-fixture replay measurement

Same current recorded-event fold and 1k/4k/8k four-record turn fixtures, Bun 1.4.4 on this host. Compared per-record Immer immutable updates against the staged mutable path; final JSON was identical in each case. One sample per size, not a statistical performance guarantee or an old context-rebuild end-to-end baseline:

| Records | Immutable per record | Staged mutable |
| --- | --- | --- |
| 1000 | 32.09 ms | 7.60 ms |
| 4000 | 166.45 ms | 6.51 ms |
| 8000 | 556.58 ms | 12.84 ms |

## Cleanup and final checks

Owned fixture servers have been stopped through their control route. No listener remains on the ten fixture ports used by this task. `.tmp/web-protocol-alignment` (89 files, 21,699,741 bytes) was moved to the Windows Recycle Bin and its absence verified. This removed the temporary fixture, configuration/home, model control server, source references, full capture export and benchmark/generator scripts. Selected JSON observations and two browser screenshots remain in this spec directory as acceptance artifacts. REA retained investigation state was reset (43 records); no target or browser process was retained. Pre-existing untracked WorkBuddy directories and unrelated dirty changes are preserved.

Final readback checks: git diff --check succeeded; dist-web still matches f082f04a09; scoped lint has zero errors (warnings are not claimed resolved). Both owning package typechecks and the final server build passed. No new task-owned scratch files remain in git status. The acceptance contract is complete for the recorded-conversation migration and explicitly scoped audit; the unresolved exact-client/external-integration matrix rows remain a follow-up, not an implied claim of full Web equivalence.


## Official-client gap repair — 2026-11-17

Implemented the G01–G20 repair set documented in client-compatibility.md without changing dist-web. Two choices were explicitly confirmed by the user: normalize Host UTF-16 content to UTF-8 for both preview and download, and implement in-place session cwd migration rather than rejecting it. The latter keeps the session ID/history, moves its storage namespace, updates the index and rebuilds local bindings under lifecycle serialization and session/quiescence leases. Tests cover the moved execution directory, retained history, cold resume, rejected busy/quiesced sessions, rename failure and post-rename persistence failure rollback. Remote host-cwd migration remains an explicit validation error rather than silently changing a remote execution directory.

Evidence for this repair set:

- Engine owning package: `bun run test -- --parallel=1`, 9127 pass / 102 capability-platform skips / 0 fail, 544 files. Final affected engine files after follow-up edits: 221 pass / 0 fail across session manager, archive, plugin and workspace-fs tests.
- Server affected-file batch: 464 pass / 2 platform skips / 0 fail across nine files. Later goal/download/Socket boundary selection: 8 pass / 0 fail. Final server package command exited 0 after its built-in isolated diagnostic rerun: initial 1453 pass / 14 skips / 1 failure; sessions.test.ts passed in isolation. The intermittent `prepares the read model at boot and serves immediate reads` archive-list assertion also appeared before this repair set (recorded above); it is not claimed fixed or counted as a no-flake green package run.
- Core and server typechecks passed. Server and CLI builds passed; bundled CLI `--version` returned 2.6.2. Scoped oxlint: 0 errors, 141 warnings, not warning-free. No-comments, deep-import boundary and diff whitespace checks passed. Structural gate-wiring, orphan-exports and text-as-protocol checks passed individually.
- Official bundle in Ego browser: authenticated via the real token dialog; selected the managed project and stub model; sent a message and observed its response; refreshed and observed the restored user and assistant messages; opened TOML and UTF-16 Chinese previews; clicked the real Download menu and saved utf16.txt from the bare session download URL without injecting an Authorization header into navigation. A browser fetch of Host UTF-16 returned status 200, text/plain and the expected Chinese text. Screenshot: alignment-browser.png. Browser notification permission was handled by the user before control resumed.
- This is selected end-to-end coverage using a local deterministic model, not certification of external OAuth/cloud services, OS editor launches or every one of the 128 client methods through UI clicks. Prompt response replay is bounded and process-local, not durable across a server restart.

The Ego task space was closed. The fixture server and fake model exited normally via their control file; connection probes confirmed no listeners on ports 65253 and 65254. No real user configuration or provider credentials were used. Existing unrelated worktree edits were preserved; no commit or push was made.

Final follow-up: transcript-contract real HTTP/WebSocket e2e 12 pass / 0 fail; node-sdk consumer typecheck passed; final docs build passed. `.tmp/web-alignment-final` (74 files, 212978 bytes) was recycled and its absence verified. Security-auditor, gen-changesets and verification-before-completion skill invocations were refused by the skill runtime's nested-depth cap; no bypass was attempted. The existing manual security/diff review, tests and gates above are the evidence, not a claim that those refused skills ran. No new changeset was generated by a refused workflow.

## Native Windows build and deployment — 2026-11-17

User explicitly requested an EXE build and system deployment. Used the repository's `bun run build:native:bun:release`, producing the unsigned Windows x64 binary at `apps/kimi-code/dist-native/bin/win32-x64/kimi.exe` (245.9 MiB). `bun run test:native:smoke` passed, including native assets, MiniDb/search workers, plugin entry, exec-server and SSH askpass. Installed at `C:/Users/Administrator/.kimi-code/bin/kimi.exe`; retained the old executable and checksum as `kimi-backup-20261117-094510.exe` and its `.sha256`. No existing process was stopped. The exec-side platform helper already matched the new build and was not overwritten.

Build and installed SHA-256 both equal `aa20d13743e9b03341966aea35eb6467cb286f303bd6022c93dfd396f6d8e0de`. Installed `kimi --version` returned 2.6.2, `kimi --help` worked, and the installed binary passed a fresh isolated native-asset/MiniDb/search-worker smoke. No staging executable remained. Existing running sessions continue using the old mapped executable until restarted. No version bump, commit, push, system environment change or real user config edit was performed.
