import { readFile } from 'node:fs/promises';

import { parseCode } from '../code';
import type { MemoryCode } from '../types';

export async function loadCodeFile(path: string, defaults: MemoryCode): Promise<MemoryCode> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return defaults;
  }
  return parseCode(content, defaults);
}
