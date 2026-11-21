#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LOG="$ROOT/specs/mantis-scarlet-witch-green-arrow/audit/g2-tests-v2.log"
: > "$LOG"
run() {
  local pkg="$1" file="$2" name="$3"
  echo "=== $name" | tee -a "$LOG"
  ( cd "$ROOT/$pkg" && bun test --isolate --test-name-pattern "$name" "$file" ) >>"$LOG" 2>&1
  local code=$?
  echo "exit=$code" | tee -a "$LOG"
}
run packages/agent-core-v2 test/agent/profile/binding.test.ts "keeps declared tools separate from the live overlay until an explicit snapshot bind"
run packages/agent-core-v2 test/tool/tool.test.ts "treats timeoutMs=0 as no deadline for background subagents and preserves the metadata"
run packages/agent-core-v2 test/state/eventDispatcher.test.ts "supports opt-in mutableReplay on durable participants"
run packages/agent-core-v2 test/agent/task/taskManager.test.ts "wait with a zero timeout returns an already-completed snapshot"
run packages/node-sdk test/sdk-rpc-client-v2.test.ts "resumes an occupied session read-only and keeps prompt writes locked"
run packages/core test/llm/bedrock.test.ts "keeps token lifecycle, routing, and Anthropic authentication provider-local"
run packages/agent-core-v2 test/os/backends/node-local/tools/bash.test.ts "runs through runner.spawn, injects cwd, noninteractive env, and closes stdin"
run packages/kap-server test/search/searchRoute.test.ts "serves literal mode through the wire"
run packages/kap-server test/sessionList.test.ts "drops the legacy /api/v2/sessions routes"
