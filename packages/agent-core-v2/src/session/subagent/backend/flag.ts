/**
 * `subagent` domain — registers the `subagent-backends` experimental flag.
 *
 * Gates the external subagent backends (claude-code / codex / acp) behind an
 * experiment: they spawn external CLIs that may not be installed, so the
 * `backend` parameter of the `Agent` tool is stripped while the flag is off.
 */

import { registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SUBAGENT_BACKENDS_FLAG_ID = 'subagent-backends';
export const SUBAGENT_BACKENDS_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SUBAGENT_BACKENDS';

registerFlagDefinition({
  id: SUBAGENT_BACKENDS_FLAG_ID,
  title: 'External subagent backends',
  description:
    'Enables the claude-code / codex / acp backends for the Agent tool, which spawn external agent CLIs instead of in-process subagents.',
  env: SUBAGENT_BACKENDS_FLAG_ENV,
  default: false,
  surface: 'core',
});
