import { readFile, realpath } from 'node:fs/promises';

import { t } from '@moonshot-ai/kimi-i18n';

import { Service } from '#/_base/di/service';
import { IConfigService } from '#/app/config/config';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { SpillLocator, type ISpillService, type SpillRef, type SaveTextSpill } from './spill';
import { privateRoot, saveTextFile } from './spillStore';

/** Configured `[spill]` section shape. */
export interface SpillConfig {
  /** Absolute spill root; defaults to a private per-process temp directory. */
  readonly root?: string;
}

export class SpillService extends Service implements ISpillService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService private readonly configService: IConfigService,
    @ISessionContext private readonly session: ISessionContext,
  ) {
    super();
  }

  private spillRoot(): string {
    return this.configService.get<SpillConfig>('spill')?.root ?? privateRoot();
  }

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const saved = await saveTextFile({
      root: this.spillRoot(),
      sessionId: input.owner.sessionId,
      suggestedName: input.suggestedName,
      content: input.content,
    });
    const hint = t('toolsV2.spill.retrievalHint', { path: saved.path });
    return { locator: SpillLocator(saved.path), bytes: saved.bytes, retrievalHint: hint };
  }

  async readText(locator: ReturnType<typeof SpillLocator>): Promise<string | null> {
    const root = this.spillRoot();
    let resolvedLocator: string;
    let resolvedRoot: string;
    try {
      resolvedLocator = await realpath(locator);
      resolvedRoot = await realpath(root);
    } catch {
      return null;
    }
    if (!isWithinRoot(resolvedLocator, resolvedRoot)) return null;
    try {
      return await readFile(resolvedLocator, 'utf8');
    } catch {
      return null;
    }
  }
}

function isWithinRoot(path: string, root: string): boolean {
  const normalizedPath = path.replaceAll('\\', '/').replace(/\/+$/, '');
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/+$/, '');
  if (normalizedRoot === '') return false;
  if (process.platform === 'win32') {
    const lowerPath = normalizedPath.toLowerCase();
    const lowerRoot = normalizedRoot.toLowerCase();
    return lowerPath === lowerRoot || lowerPath.startsWith(`${lowerRoot}/`);
  }
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}
