/**
 * `lsp` domain — `LspFeature`: the semantic-navigation capability assembled as
 * one App-scope Feature unit.
 *
 * Contributes the Session-scoped `ILspService` (provider routing) and
 * `ILspStdioProviderService` (config-driven stdio providers) plus the
 * Agent-scoped `lsp` tool through the `features` base-class seams; retracting
 * the unit withdraws all of them across the scope tree. The `lsp` config
 * section (`features/lsp/configSection`) stays on the static import=register
 * channel — user-facing contracts must remain statically discoverable
 * (config manifest) even when the feature unit is retracted. Registered into
 * the feature table at import.
 */

import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import './configSection';
import { ILspService } from './lsp';
import { LspService } from './lspService';
import { ILspStdioProviderService, LspStdioProviderService } from './lspStdioProvider';
import { ILspTool } from './tools/lsp/lsp';
import { LspTool } from './tools/lsp/lspTool';

export class LspFeature extends Feature {
  static override readonly name = 'lsp';

  constructor() {
    super();
    this.contributeService(LifecycleScope.Session, ILspService, LspService);
    this.contributeService(
      LifecycleScope.Session,
      ILspStdioProviderService,
      LspStdioProviderService,
    );
    this.contributeTool(ILspTool, LspTool, {
      name: 'lsp',
      domain: 'lsp',
    });
  }
}

registerFeature(LspFeature);
