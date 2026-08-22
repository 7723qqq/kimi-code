import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const LSP_FLAG_ID = 'lsp';
export const LSP_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_LSP';

export const lspFlag: FlagDefinitionInput = {
  id: LSP_FLAG_ID,
  title: 'LSP tool',
  description:
    'Expose the lsp tool for go-to-definition, find-references, implementation, and hover queries through language servers configured in the [lsp] config section.',
  env: LSP_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(lspFlag);
