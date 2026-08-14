/**
 * `spill` domain — `SpillService` implementation (Session scope).
 *
 * Writes spilled artifacts through the DI-free `spillStore` mechanics under
 * the configured `[spill] root` (or the lazy 0700 private temp root), and
 * serves reads back by locator. Locators are backend-produced absolute paths;
 * `readText` refuses any locator outside the configured root so a tampered
 * locator cannot read an arbitrary file.
 *
 * Ported from deepseek-harness `spill/spill-local` (MIT).
 */

import { readFile } from 'node:fs/promises';

import { Service } from '#/_base/di/service';
import { IConfigService } from '#/app/config/config';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { t } from '@moonshot-ai/kimi-i18n';

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
    if (!isWithinRoot(locator, root)) return null;
    try {
      return await readFile(locator, 'utf8');
    } catch {
      // Absent artifact (or an unreadable one) reads as missing; the caller
      // degrades to the inline truncated output.
      return null;
    }
  }
}

function isWithinRoot(path: string, root: string): boolean {
  const normalizedPath = path.replaceAll('\\', '/');
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/+$/, '');
  if (normalizedRoot === '') return false;
  return (
    normalizedPath.startsWith(`${normalizedRoot}/`) ||
    normalizedPath === normalizedRoot
  );
}
