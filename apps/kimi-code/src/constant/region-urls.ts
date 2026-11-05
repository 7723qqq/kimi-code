/**
 * Region-derived URLs for the current deployment (.com vs .ai). Split from
 * `constant/app.ts`: resolving the region profile pulls the region/config
 * stack, so this module must only load on the dispatch layer, never in the
 * CLI entry graph.
 */

import { currentKimiProfile } from '#/utils/region';

// Sign-up / sign-in page offered to signed-out users so they can create an
// account and submit feedback through the authenticated channel next time.
export function kimiCodeSignupUrl(): string {
  return `${currentKimiProfile().siteBase}/code`;
}

// CDN source of truth: all version checks and native install scripts pull from here.
// The off-session endpoints derive from the current region profile so a
// global login points at the .ai deployment; they are resolved per call so
// a region switch (login/logout + refreshKimiRegion) takes effect immediately.
export function kimiCodeCdnBase(): string {
  return currentKimiProfile().cdnBase;
}
export function kimiCodeCdnLatestUrl(): string {
  return `${kimiCodeCdnBase()}/latest`;
}
// Rollout manifest consumed by update checks; the plain-text `/latest` above
// stays unchanged forever — already-shipped clients hard-fail on non-semver
// bodies, and the CDN install scripts read it for fresh installs.
export function kimiCodeCdnLatestJsonUrl(): string {
  return `${kimiCodeCdnBase()}/latest.json`;
}
// Canary channel pointer, same wire shape as `latest.json`. Only a client on
// the canary channel reads it; stable never requests it.
export function kimiCodeCdnCanaryChannelUrl(): string {
  return `${kimiCodeCdnBase()}/channels/canary.json`;
}
// Per-release native artifacts: `/binaries/<version>/manifest.json` +
// `/binaries/<version>/kimi-code-<target>[.exe]` — the bare platform binary
// (same layout install.ps1 consumes).
export function kimiCodeCdnBinariesBase(): string {
  return `${kimiCodeCdnBase()}/binaries`;
}
// The CLI-side default catalog derives from the current region profile; the
// env override takes priority at the call site.
export function kimiCodePluginMarketplaceUrl(): string {
  return `${kimiCodeCdnBase()}/plugins/marketplace.json`;
}
export function kimiCodeInstallShUrl(): string {
  return `${kimiCodeCdnBase()}/install.sh`;
}
export function kimiCodeInstallPs1Url(): string {
  return `${kimiCodeCdnBase()}/install.ps1`;
}
// Official download page, referenced by prompt copy that steers users away
// from third-party install sources.
export function kimiCodeOfficialInstallUrl(): string {
  return `${currentKimiProfile().siteBase}/code`;
}

// Native install commands, split by platform. Use these for prompt copy and spawn calls only; do not assemble the strings elsewhere.
export function nativeInstallCommandUnix(): string {
  return `curl -fsSL ${kimiCodeInstallShUrl()} | bash`;
}
export function nativeInstallCommandWin(): string {
  return `irm ${kimiCodeInstallPs1Url()} | iex`;
}
