/**
 * `lsp` domain — `ILspService` implementation.
 *
 * Routes semantic queries to the provider registered for the request file's
 * final extension. Provider registration is atomic: an id or extension
 * conflict rejects the whole registration before any effect lands, and the
 * returned disposer withdraws the provider's id and extensions together.
 * Queries without a covering provider fail loud with `LSP_UNAVAILABLE`.
 * Bound at Session scope — contributed by `LspFeature`.
 */

import { extname } from 'pathe';

import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { Error2, ErrorCodes } from '#/errors';

import {
  type ILspService as ILspServiceType,
  type LspProvider,
  type LspQueryRequest,
  type LspQueryResult,
} from './lsp';

export class LspService extends Service implements ILspServiceType {
  declare readonly _serviceBrand: undefined;

  private readonly providers = new Map<string, LspProvider>();
  private readonly extensionToProvider = new Map<string, string>();

  registerProvider(provider: LspProvider): IDisposable {
    const extensions = Object.keys(provider.extensionToLanguage);
    if (this.providers.has(provider.id)) {
      throw new Error2(
        ErrorCodes.LSP_CONFLICT,
        `an LSP provider with id "${provider.id}" is already registered`,
      );
    }
    for (const extension of extensions) {
      const owner = this.extensionToProvider.get(extension);
      if (owner !== undefined && owner !== provider.id) {
        throw new Error2(
          ErrorCodes.LSP_CONFLICT,
          `LSP provider "${owner}" already covers extension "${extension}"`,
        );
      }
    }

    this.providers.set(provider.id, provider);
    for (const extension of extensions) {
      this.extensionToProvider.set(extension, provider.id);
    }
    return toDisposable(() => {
      this.providers.delete(provider.id);
      for (const [extension, owner] of this.extensionToProvider) {
        if (owner === provider.id) {
          this.extensionToProvider.delete(extension);
        }
      }
    });
  }

  async query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult> {
    const extension = finalExtension(request.filePath);
    const providerId = this.extensionToProvider.get(extension);
    if (providerId === undefined) {
      throw new Error2(
        ErrorCodes.LSP_UNAVAILABLE,
        `no LSP provider is configured for extension "${extension}" (file: ${request.filePath}). ` +
          'Configure one in the [lsp] config section, e.g. `servers.typescript = { command = "typescript-language-server", args = ["--stdio"], extensionToLanguage = { ts = "typescript" } }`.',
      );
    }
    const provider = this.providers.get(providerId);
    if (provider === undefined) {
      throw new Error2(
        ErrorCodes.LSP_UNAVAILABLE,
        `LSP provider "${providerId}" is registered for extension "${extension}" but missing from the provider table`,
      );
    }
    const languageId = provider.extensionToLanguage[extension];
    if (languageId === undefined) {
      throw new Error2(
        ErrorCodes.LSP_UNAVAILABLE,
        `LSP provider "${providerId}" covers extension "${extension}" but does not map it to a language id`,
      );
    }
    return provider.query({ ...request, languageId }, signal);
  }
}

export function finalExtension(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  return extension.startsWith('.') ? extension.slice(1) : extension;
}
