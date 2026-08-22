import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import './configSection';
import { LSP_FLAG_ID } from './flag';
import { ILspService } from './lsp';
import { LspService } from './lspService';
import { ILspStdioProviderService, LspStdioProviderService } from './lspStdioProvider';
import { ILspTool } from './tools/lsp/lsp';
import { LspTool } from './tools/lsp/lspTool';

export class LspFeature extends Feature {
  static override readonly name = 'lsp';

  constructor(@IFlagService flags: IFlagService) {
    super();
    if (!flags.enabled(LSP_FLAG_ID)) return;
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
