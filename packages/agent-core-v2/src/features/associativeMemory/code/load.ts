import { parseCode } from '../code';
import type { MemoryCode } from '../types';

export async function loadCodeFile(path: string, defaults: MemoryCode): Promise<MemoryCode> {
  let content: string;
  try {
    content = await Bun.file(path).text();
  } catch {
    return defaults;
  }
  return parseCode(content, defaults);
}
