import { IGitMemoryService } from '#/features/gitMemory/gitMemoryService';
import type { ExecutableToolResult } from '#/tool/toolContract';

export async function withFileMemory(
  result: ExecutableToolResult,
  path: string,
  service: IGitMemoryService | undefined,
): Promise<ExecutableToolResult> {
  if (result.isError === true || service === undefined) return result;
  let block: string;
  try {
    block = await service.fileBlock(path);
  } catch {
    return result;
  }
  if (block.length === 0) return result;
  const output = result.output;
  if (typeof output === 'string') {
    return { ...result, output: `${output}\n${block}` };
  }
  return { ...result, output: [...output, { type: 'text', text: `\n${block}` }] };
}
