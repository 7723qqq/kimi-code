/**
 * `attachment` domain — `AttachmentFeature`: content-addressed attachment
 * storage assembled as one App-scope Feature unit.
 *
 * Contributes the `[attachment]` config section and the App-scope
 * `IAttachmentService` through the `features` base-class seams; retracting
 * the unit withdraws both. Registered into the feature table at import.
 */

import { z } from 'zod';

import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { AttachmentService } from './attachmentService';
import { IAttachmentService } from './types';

const ATTACHMENT_SECTION = 'attachment';

const AttachmentConfigSchema = z.object({
  root: z.string().optional(),
  limits: z
    .object({
      maxImageBytes: z.number().int().positive().optional(),
      maxImagePixels: z.number().int().positive().optional(),
    })
    .optional(),
});

export class AttachmentFeature extends Feature {
  static override readonly name = 'attachment';

  constructor() {
    super();
    this.contributeConfig(ATTACHMENT_SECTION, AttachmentConfigSchema, {
      defaultValue: { root: undefined },
    });
    this.contributeService(LifecycleScope.App, IAttachmentService, AttachmentService);
  }
}

registerFeature(AttachmentFeature);
