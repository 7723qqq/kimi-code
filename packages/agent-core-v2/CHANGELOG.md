# @moonshot-ai/agent-core-v2

## 0.1.0

### Minor Changes

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Track the agent's live phase (idle, running, streaming, tool call, retrying, awaiting approval, interrupted, ended) as a single model field driven by the existing turn events, and carry it on the status update channel for downstream consumers.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Persist v2 wire records natively in the v1 record vocabulary and remove the persist-time rewrite layer: ops now write v1-shaped records directly (todo updates persist as `tools.update_store`, `turn.prompt` carries only `input`/`origin`, `usage.record` drops request context, `plan_mode.enter` carries only the plan id), live-only state (runtime phase, task/cron registries, context size, skill activations, runtime permission rules) is declared `persist: false` instead of being stripped at write time, and the swarm-mode exit reminder removal replays from the `swarm_mode.exit` record itself. This fixes resumed sessions losing the todo list, drifting turn counters after retries, and removed reminders reappearing after resume.

### Patch Changes

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Fix the v2 AskUserQuestion flow: answers now come back keyed by question text with option labels as values, aborting a turn or stopping a background question dismisses the pending question instead of leaking it, and duplicate question texts or option labels are rejected before the question is shown. The pending-question wire shape no longer carries a synthetic expires_at field.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Fix the production build by resolving internal module imports directly instead of through directory re-exports.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Reorganize the agent execution environment into separate filesystem, process and tool domains.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Reroute the blob store backend from the host filesystem to the pluggable storage layer, so server-only deployments no longer require a local filesystem implementation.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Route FetchURL through the managed Kimi fetch service when the Kimi provider is logged in, with automatic fallback to local fetching on failure, and forward the host identity headers with the request.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Hide image-compression captions from user-visible history: captions that prompt ingestion places inside a user message are rerouted through hidden system reminders (and stripped from session titles), while the model still receives the full note. ReadMediaFile is now registered in production whenever the bound model supports image or video input, re-registering on model switches.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Align v2 media reads with v1: the ReadMediaFile summary moves to the tool result's note side channel so raw `<system>` markup never renders in UIs, image dimensions are reported in the decoded EXIF-rotated space so portrait photos get correct coordinate guidance, the downscale cap rises from 2000px to 3000px with a gentler byte-budget fallback, and image compression and crop telemetry is reported for media reads.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Fix the managed OAuth device-code login getting aborted when an unrelated provider refresh fires during the login flow.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Harden plugin management: degrade sessions gracefully when plugin state fails to load, clean up temp dirs and roll back the managed copy on failed installs, restore managed endpoint env for stdio plugin MCP servers, and make update checks concurrent with per-repo failure isolation.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Forward the host identity headers (User-Agent and device identity) with WebSearch requests, matching v1.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Align v2 engine telemetry with the v1 wire format: rename `tool_call_dedupe_detected` to `tool_call_dedup_detected`, carry mode/protocol tags on turn events, emit `turn_ended` unconditionally with interrupt reasons, add alias/protocol/input token fields to `api_error`, tag `tool_call` with `dup_type`, rename compaction usage fields to `input_tokens`/`output_tokens`, and add `context_projection_repaired`, `session_started`, and `session_load_failed` events.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Report `video_upload` telemetry for ReadMediaFile video uploads — outcome, byte size, mime type, duration, and model/protocol tags; a failing telemetry sink never affects the upload.

- Updated dependencies [[`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6)]:
  - @moonshot-ai/protocol@0.4.0
