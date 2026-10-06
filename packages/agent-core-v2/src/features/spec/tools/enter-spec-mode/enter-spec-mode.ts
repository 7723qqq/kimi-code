import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const EnterSpecModeInputSchema = z.object({}).strict();
export type EnterSpecModeInput = z.infer<typeof EnterSpecModeInputSchema>;

export interface IEnterSpecModeTool extends AgentTool<EnterSpecModeInput> {
  readonly _serviceBrand: undefined;
}
export const IEnterSpecModeTool = createDecorator<IEnterSpecModeTool>('enterSpecModeTool');
