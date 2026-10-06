import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export interface ExitSpecModeOption {
  label: string;
  description: string;
}

export interface ExitSpecModeInput {
  options?: readonly ExitSpecModeOption[] | undefined;
}

const RESERVED_OPTION_LABELS = new Set(
  ['Approve', 'Reject', 'Reject and Exit', 'Revise'].map(normalizeOptionLabel),
);

const ExitSpecModeOptionSchema = z
  .object({
    label: z
      .string()
      .min(1)
      .max(80)
      .describe(
        'Short name for this option (1-8 words). Append "(Recommended)" if you recommend this option.',
      ),
    description: z
      .string()
      .default('')
      .describe('Brief summary of this approach and its trade-offs.'),
  })
  .strict();

export const ExitSpecModeInputSchema: z.ZodType<ExitSpecModeInput> = z
  .object({
    options: z
      .array(ExitSpecModeOptionSchema)
      .min(1)
      .max(3)
      .refine(hasUniqueOptionLabels, 'Option labels must be unique.')
      .refine(hasNoReservedOptionLabels, 'Option labels must not use reserved approval labels.')
      .optional()
      .describe(
        'When the design document leaves a genuine choice between approaches, list them here so the user can pick which one to execute. Provide up to 3 options; 2-3 distinct approaches work best. Each option must correspond to an approach the design document actually describes. Do not use "Reject", "Revise", "Approve", or "Reject and Exit" as labels.',
      ),
  })
  .strict();

export interface IExitSpecModeTool extends AgentTool<ExitSpecModeInput> {
  readonly _serviceBrand: undefined;
}
export const IExitSpecModeTool = createDecorator<IExitSpecModeTool>('exitSpecModeTool');

function hasUniqueOptionLabels(options: readonly ExitSpecModeOption[]): boolean {
  const labels = new Set<string>();
  for (const option of options) {
    const label = normalizeOptionLabel(option.label);
    if (labels.has(label)) return false;
    labels.add(label);
  }
  return true;
}

function hasNoReservedOptionLabels(options: readonly ExitSpecModeOption[]): boolean {
  return options.every((option) => !RESERVED_OPTION_LABELS.has(normalizeOptionLabel(option.label)));
}

function normalizeOptionLabel(label: string): string {
  return label.trim().toLowerCase();
}
