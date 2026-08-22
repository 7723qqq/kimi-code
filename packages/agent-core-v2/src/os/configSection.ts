import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const SHELL_SECTION = 'shell';

export const ShellPreferenceSchema = z.enum(['auto', 'bash', 'powershell', 'pwsh', 'cmd']);

export type ShellPreference = z.infer<typeof ShellPreferenceSchema>;

export const ShellConfigSchema = z.object({
  preference: ShellPreferenceSchema.optional(),
});

export type ShellConfig = z.infer<typeof ShellConfigSchema>;

registerConfigSection(SHELL_SECTION, ShellConfigSchema);
