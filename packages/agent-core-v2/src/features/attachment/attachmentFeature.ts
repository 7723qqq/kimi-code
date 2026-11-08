import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import './configSection';
import { AttachmentService } from './attachmentService';
import { IAttachmentService } from './types';

export class AttachmentFeature extends Feature {
  static override readonly name = 'attachment';

  constructor() {
    super();
    this.contributeService(LifecycleScope.App, IAttachmentService, AttachmentService);
  }
}

registerFeature(AttachmentFeature);
