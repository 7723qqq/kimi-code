/**
 * `codeRuntime` domain — `CodeRuntimeFeature`: the code-execution capability
 * assembled as one App-scope Feature unit.
 *
 * Contributes the `run_code` agent tool through the `features` base-class
 * seams; retracting the unit withdraws the tool across the scope tree. The
 * executor itself is stateless (one worker per run), so the feature carries
 * no services. Registered into the feature table at import.
 */

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
