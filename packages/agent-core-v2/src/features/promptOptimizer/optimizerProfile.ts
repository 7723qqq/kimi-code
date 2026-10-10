import { registerAgentProfile } from '#/app/agentProfileCatalog/contribution';

import {
  PROMPT_OPTIMIZER_PROFILE_NAME,
  PROMPT_OPTIMIZER_SYSTEM_PROMPT,
  PROMPT_OPTIMIZER_TOOLS,
} from './promptOptimizer';

registerAgentProfile({
  name: PROMPT_OPTIMIZER_PROFILE_NAME,
  description: 'Rewrites a drafted prompt without acting on it.',
  tools: PROMPT_OPTIMIZER_TOOLS,
  systemPrompt: () => PROMPT_OPTIMIZER_SYSTEM_PROMPT,
});
