/**
 * Pure XML builder for the macOS LaunchAgent plist that supervises
 * `kimi server run`.
 *
 * Kept separate from `launchd.ts` so the plist text is testable without any
 * shell-out to `launchctl`. Mirrors the shape of
 * `../openclaw/src/daemon/launchd-plist.ts:buildLaunchAgentPlist`.
 */

// launchd defaults to a 10s spawn throttle. Keep the explicit default so crash
// loops back off; explicit kickstart restarts still take effect immediately.
export const LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS = 10;
export const LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS = 20;
/** launchd renders Umask as a decimal integer. 0o077 = 63 (owner-only files). */
export const LAUNCH_AGENT_UMASK_DECIMAL = 0o077;
export const LAUNCH_AGENT_PROCESS_TYPE = 'Interactive';
export const LAUNCH_AGENT_STDIN_PATH = '/dev/null';

export interface BuildLaunchAgentPlistInput {
  label: string;
  /** Optional comment line embedded in the plist for human discoverability. */
  comment?: string;
  /** Argv of the supervised process. First element is the absolute program path. */
  programArguments: readonly string[];
  /** Absolute path the supervised process runs under. */
  workingDirectory?: string;
  /** Absolute path where launchd redirects the supervised process's stdout. */
  stdoutPath: string;
  /** Absolute path where launchd redirects the supervised process's stderr. */
  stderrPath: string;
  /** Optional environment overrides for the supervised process. */
  environment?: Readonly<Record<string, string>>;
}

const plistEscape = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

function renderEnvDict(env?: Readonly<Record<string, string>>): string {
  if (!env) return '';
  const entries = Object.entries(env);
  if (entries.length === 0) return '';
  const inner = entries
    .map(
      ([k, v]) =>
        `\n      <key>${plistEscape(k)}</key>\n      <string>${plistEscape(v)}</string>`,
    )
    .join('');
  return `\n    <key>EnvironmentVariables</key>\n    <dict>${inner}\n    </dict>`;
}

/** Build the plist XML text. Deterministic — only depends on the input. */
export function buildLaunchAgentPlist(input: BuildLaunchAgentPlistInput): string {
  const argsXml = input.programArguments
    .map((arg) => `\n      <string>${plistEscape(arg)}</string>`)
    .join('');
  const workingDirXml = input.workingDirectory
    ? `\n    <key>WorkingDirectory</key>\n    <string>${plistEscape(input.workingDirectory)}</string>`
    : '';
  const commentXml = input.comment?.trim()
    ? `\n    <key>Comment</key>\n    <string>${plistEscape(input.comment.trim())}</string>`
    : '';
  const envXml = renderEnvDict(input.environment);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${plistEscape(input.label)}</string>${commentXml}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ExitTimeOut</key>
    <integer>${LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS}</integer>
    <key>ProcessType</key>
    <string>${LAUNCH_AGENT_PROCESS_TYPE}</string>
    <key>ThrottleInterval</key>
    <integer>${LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS}</integer>
    <key>Umask</key>
    <integer>${LAUNCH_AGENT_UMASK_DECIMAL}</integer>
    <key>ProgramArguments</key>
    <array>${argsXml}
    </array>${workingDirXml}
    <key>StandardInPath</key>
    <string>${plistEscape(LAUNCH_AGENT_STDIN_PATH)}</string>
    <key>StandardOutPath</key>
    <string>${plistEscape(input.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${plistEscape(input.stderrPath)}</string>${envXml}
  </dict>
</plist>
`;
}
