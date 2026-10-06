import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import './flag';
import { ISessionPromptOptimizerService, PROMPT_OPTIMIZER_FLAG_ID } from './promptOptimizer';
import { SessionPromptOptimizerService } from './promptOptimizerService';

export class PromptOptimizerFeature extends Feature {
  static override readonly name = 'promptOptimizer';

  constructor(@IFlagService flags: IFlagService) {
    super();
    if (!flags.enabled(PROMPT_OPTIMIZER_FLAG_ID)) return;
    this.contributeService(
      LifecycleScope.Session,
      ISessionPromptOptimizerService,
      SessionPromptOptimizerService,
    );
  }
}

registerFeature(PromptOptimizerFeature);
