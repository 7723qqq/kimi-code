/**
 * `hostEnvironment` domain — shell preference config section.
 *
 * Owns the `[shell]` configuration section: `preference` selects which shell
 * the Bash tool spawns on Windows. `auto` (the default) keeps the probe
 * priority (KIMI_SHELL_PATH → pwsh → powershell → Git Bash → cmd); an
 * explicit value pins the shell regardless of what the probe would pick.
 * `KIMI_SHELL_PATH` still wins over the config when both are set.
 *
 * Self-registered at module load via `registerConfigSection`.
 */

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
