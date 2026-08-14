/**
 * `attachment` domain — default attachment root: a private (0700)
 * per-process directory under the OS tmpdir, created lazily.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let defaultRoot: string | undefined;

/** The lazily-created private attachment root. */
export function privateRoot(): string {
  defaultRoot ??= mkdtempSync(join(tmpdir(), 'kimi-attachment-'));
  return defaultRoot;
}
