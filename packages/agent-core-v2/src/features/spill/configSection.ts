import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const SPILL_SECTION = 'spill';

export const SpillConfigSchema = z.object({
  root: z.string().optional(),
});

registerConfigSection(SPILL_SECTION, SpillConfigSchema, {
  defaultValue: { root: undefined },
});
