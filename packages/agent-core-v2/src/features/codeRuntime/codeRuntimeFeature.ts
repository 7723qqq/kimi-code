import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { IRunCodeTool } from './codeRuntime';
import { RunCodeTool } from './runCodeTool';

export class CodeRuntimeFeature extends Feature {
  static override readonly name = 'codeRuntime';

  constructor() {
    super();
    this.contributeTool(IRunCodeTool, RunCodeTool, { name: 'run_code', domain: 'codeRuntime' });
  }
}

registerFeature(CodeRuntimeFeature);
