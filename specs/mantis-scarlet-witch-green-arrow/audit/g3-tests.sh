#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LOG="$ROOT/specs/mantis-scarlet-witch-green-arrow/audit/g3-tests.log"
: > "$LOG"
run() {
  local pkg="$1" file="$2" name="$3"
  echo "=== $name" | tee -a "$LOG"
  ( cd "$ROOT/$pkg" && bun test --isolate --test-name-pattern "$name" "$file" ) >>"$LOG" 2>&1
  local code=$?
  echo "exit=$code" | tee -a "$LOG"
}
run apps/kimi-code test/tui/components/messages/thinking.test.ts "sweeps the live title only on animation frames and stops requesting frames on finalize"
run apps/kimi-code test/tui/utils/transcript-projection.test.ts "keeps an MCP authenticate call out of the groups in compact"
run apps/kimi-code test/tui/controllers/prompt-prediction.test.ts "accepts and submits ghost text while cancelling stale requests precisely"
run apps/kimi-code test/tui/kimi-tui-message-flow.test.ts "keeps mixed normal, worker and cron turns aligned through live trimming"
run apps/kimi-code test/tui/commands/follow-up-preferences.test.ts "opens from /settings and saves the picked value"
run apps/kimi-code test/tui/tasks-browser.test.ts "keeps an API-only foreground task through an event-free repaint"
run apps/kimi-code test/tui/components/dialogs/feedback-input-dialog.test.ts "supports Shift-Enter and editing an earlier line"
