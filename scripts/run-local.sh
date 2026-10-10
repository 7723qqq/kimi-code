#!/usr/bin/env bash
#
# Start the CLI from a fresh bundle.
#
# Why not `bun run dev:cli`: that path executes `src/main.ts` directly, and Bun
# 1.4.2 does not resolve `package.json` `imports` wildcards (`"#/*": "./src/*.ts"`),
# so the first `#/` import inside any package aborts with
# "Cannot find module '#/kimi-harness'". Node resolves those correctly and tsx
# proved it, but `main.ts` hard-exits on a non-Bun runtime, so the source path
# cannot be used under either runtime. Bundling sidesteps resolution entirely
# (tsdown inlines every `#/` specifier), and the bundle step takes ~2s.
#
# Usage:
#   scripts/run-local.sh [--watch] [--verbose] [-- kimi args...]
#
#   --watch     rebuild and re-run whenever a source file changes
#   --verbose   print each build/run step
#   --          everything after is passed to kimi
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/apps/kimi-code"
ENTRY="$APP_DIR/dist/main.mjs"

WATCH=0
VERBOSE=0
CLI_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --watch) WATCH=1; shift ;;
    --verbose) VERBOSE=1; shift ;;
    --) shift; CLI_ARGS=("$@"); break ;;
    *) CLI_ARGS+=("$1"); shift ;;
  esac
done

log() { [ "$VERBOSE" -eq 1 ] && printf '\033[2m[run-local]\033[0m %s\n' "$*" >&2 || true; }

require_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    printf 'error: bun is required (https://bun.sh)\n' >&2
    exit 1
  fi
}

# Cheap change fingerprint over the sources that feed the bundle.
#
# Compares a hash of (path, mtime, size) for every source file rather than only
# the newest mtime: a bare max-mtime baseline misses a change whenever some
# other file already carries a later timestamp (which happens as soon as the
# build itself touches anything under packages/), and it also cannot see a
# deletion. `cksum` over `find -printf` is portable and costs ~40ms here.
source_fingerprint() {
  find "$REPO_ROOT/apps/kimi-code/src" \
       "$REPO_ROOT/packages" \
       -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.md' -o -name '*.json' \) \
       -not -path '*/node_modules/*' \
       -not -path '*/dist/*' \
       -not -path '*/dist-native/*' \
       -not -path '*/.tmp-api-extractor/*' \
       -not -path '*/.contract-types-tmp/*' \
       -not -path '*/test/*' \
       -printf '%p %T@ %s\n' 2>/dev/null \
    | LC_ALL=C sort | cksum
}

# Newest mtime under the same roots, used to decide whether the bundle is stale.
newest_source_mtime() {
  find "$REPO_ROOT/apps/kimi-code/src" \
       "$REPO_ROOT/packages" \
       -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.md' -o -name '*.json' \) \
       -not -path '*/node_modules/*' \
       -not -path '*/dist/*' \
       -not -path '*/dist-native/*' \
       -not -path '*/.tmp-api-extractor/*' \
       -not -path '*/.contract-types-tmp/*' \
       -not -path '*/test/*' \
       -printf '%T@\n' 2>/dev/null | sort -rn | head -1
}

needs_build() {
  [ -f "$ENTRY" ] || return 0
  local src_mtime entry_mtime
  src_mtime="$(newest_source_mtime)"
  entry_mtime="$(stat -c %Y "$ENTRY" 2>/dev/null || echo 0)"
  # Both in seconds; rebuild when any source is at least as new as the bundle.
  [ -n "$src_mtime" ] || return 0
  awk -v s="$src_mtime" -v e="$entry_mtime" 'BEGIN { exit !(s > e) }'
}

build() {
  log "bundling (tsdown)…"
  ( cd "$APP_DIR" && bunx tsdown >/dev/null 2>&1 )
  log "bundle ready: $ENTRY"
}

run_once() {
  log "running: bun $ENTRY ${CLI_ARGS[*]:-}"
  exec bun "$ENTRY" "${CLI_ARGS[@]}"
}

require_bun

if [ "$WATCH" -eq 1 ]; then
  # Rebuild + rerun on change. The child replaces this process, so a change
  # sends us around the loop again with a fresh bundle.
  while true; do
    build || { printf 'build failed; waiting for changes…\n' >&2; }
    if [ -f "$ENTRY" ]; then
      log "running: bun $ENTRY ${CLI_ARGS[*]:-}"
      bun "$ENTRY" "${CLI_ARGS[@]}" || true
    fi
    printf '\033[2m[run-local]\033[0m watching for changes… (ctrl-c to stop)\n' >&2
    # Compare the whole-tree fingerprint, not just the newest mtime: the build
    # itself refreshes timestamps under packages/, so a max-mtime baseline can
    # sit above a real edit and never notice it.
    watched_fingerprint="$(source_fingerprint)"
    while :; do
      sleep 1
      [ "$(source_fingerprint)" != "$watched_fingerprint" ] && break
    done
    printf '\033[2m[run-local]\033[0m change detected, rebuilding…\n' >&2
  done
fi

if needs_build; then
  build
else
  log "bundle is up to date (pass --watch to rebuild on change)"
fi

run_once
