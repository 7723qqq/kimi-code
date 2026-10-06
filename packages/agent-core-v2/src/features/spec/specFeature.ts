import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { IAgentSpecService } from './spec';
import { AgentSpecService } from './specService';
import { IEnterSpecModeTool } from './tools/enter-spec-mode/enter-spec-mode';
import { EnterSpecModeTool } from './tools/enter-spec-mode/enterSpecModeTool';
import { IExitSpecModeTool } from './tools/exit-spec-mode/exit-spec-mode';
import { ExitSpecModeTool } from './tools/exit-spec-mode/exitSpecModeTool';

export class SpecFeature extends Feature {
  static override readonly name = 'spec';

  constructor() {
    super();
    this.contributeAgentService(IAgentSpecService, AgentSpecService);
    this.contributeTool(IEnterSpecModeTool, EnterSpecModeTool, {
      name: 'EnterSpecMode',
      domain: 'spec',
    });
    this.contributeTool(IExitSpecModeTool, ExitSpecModeTool, {
      name: 'ExitSpecMode',
      domain: 'spec',
    });
  }
}

registerFeature(SpecFeature);
