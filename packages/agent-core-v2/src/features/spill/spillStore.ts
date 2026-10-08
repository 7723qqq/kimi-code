import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let defaultRoot: string | undefined;

export function privateRoot(): string {
  defaultRoot ??= mkdtempSync(join(tmpdir(), 'kimi-spill-'));
  return defaultRoot;
}

export function encodeSegment(raw: string): string {
  if (raw.length === 0) return '~';
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    // eslint-disable-next-line unicorn/prefer-code-point -- UTF-16 code units are the injective encoding domain; code points would merge surrogate pairs.
    const code = raw.charCodeAt(i);
    // eslint-disable-next-line unicorn/prefer-code-point -- see above; escape must mirror the charCodeAt read.
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    }
  }
  return out;
}

export function sessionDir(root: string, sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
  return join(root, `session-${hash}`);
}

export interface SaveTextOptions {

  readonly root: string;

  readonly sessionId: string;

  readonly suggestedName: string;

  readonly content: string;
}

export interface SavedText {
  readonly path: string;
  readonly bytes: number;
}

export async function saveTextFile(options: SaveTextOptions): Promise<SavedText> {
  const dir = sessionDir(options.root, options.sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const safeName = encodeSegment(options.suggestedName);
  const path = join(dir, `${randomBytes(6).toString('hex')}-${safeName}`);
  const bytes = Buffer.byteLength(options.content, 'utf8');
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(options.content);
  } finally {
    await handle.close();
  }
  return { path, bytes };
}
