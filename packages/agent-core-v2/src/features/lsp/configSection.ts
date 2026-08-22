import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const LSP_SECTION = 'lsp';

export const LspServerConfigSchema = z.object({
  command: z
    .string()
    .describe('Command that starts the language server over stdio (resolved on PATH).'),
  args: z
    .array(z.string())
    .optional()
    .describe('Extra arguments passed to the command, e.g. ["--stdio"].'),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe('Extra environment variables merged into the server process.'),
  extensionToLanguage: z
    .record(z.string(), z.string())
    .describe(
      'File extension (without dot) to LSP languageId mapping, e.g. { ts = "typescript" }.',
    ),
  initializationOptions: z
    .unknown()
    .optional()
    .describe('Arbitrary options forwarded in the initialize request.'),
  shutdownTimeoutMs: z
    .number()
    .optional()
    .describe('Grace period for the shutdown request before force-killing (default 5000).'),
  killGraceMs: z
    .number()
    .optional()
    .describe('Grace period after SIGTERM before SIGKILL (default 2000).'),
  cancelGraceMs: z
    .number()
    .optional()
    .describe(
      'Grace period after a cancelled request before the server process is killed (default 2000).',
    ),
});

export const LspConfigSchema = z.object({
  servers: z
    .record(z.string(), LspServerConfigSchema)
    .optional()
    .describe('Language server table keyed by provider id.'),
});

export type LspConfig = z.infer<typeof LspConfigSchema>;
export type LspServerConfig = z.infer<typeof LspServerConfigSchema>;

registerConfigSection(LSP_SECTION, LspConfigSchema, { defaultValue: {} });
