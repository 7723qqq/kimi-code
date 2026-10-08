import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let defaultRoot: string | undefined;

export function privateRoot(): string {
  defaultRoot ??= mkdtempSync(join(tmpdir(), 'kimi-attachment-'));
  return defaultRoot;
}
