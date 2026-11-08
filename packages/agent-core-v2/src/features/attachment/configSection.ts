import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const ATTACHMENT_SECTION = 'attachment';

export const AttachmentConfigSchema = z.object({
  root: z.string().optional(),
  limits: z
    .object({
      maxImageBytes: z.number().int().positive().optional(),
      maxImagePixels: z.number().int().positive().optional(),
    })
    .optional(),
});

export type AttachmentConfig = z.infer<typeof AttachmentConfigSchema>;

registerConfigSection(ATTACHMENT_SECTION, AttachmentConfigSchema, {
  defaultValue: { root: undefined },
});
