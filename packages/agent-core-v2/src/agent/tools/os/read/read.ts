import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const MAX_LINES: number = 1000;
export const MAX_LINE_LENGTH: number = 2000;
export const MAX_BYTES: number = 100 * 1024;

/**
 * Largest file the Read tool transcodes from UTF-16 in memory. Unlike the
 * streaming UTF-8 path, transcoding needs the whole file decoded at once;
 * 10 MiB mirrors kap-server's `FS_READ_MAX_BYTES`.
 */
export const TRANSCODE_MAX_BYTES: number = 10 * 1024 * 1024;

const PositiveLineOffsetSchema = z.number().int().min(1);
const TailLineOffsetSchema = z.number().int().min(-MAX_LINES).max(-1);

export const ReadInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to a file. Text files are read as text; image and video files are sent to the model ' +
        'as multimodal content (requires a model with the matching vision capability). ' +
        'Relative paths resolve against the working directory; a path outside the working directory ' +
        'must be absolute. Directories are not supported; use `ls` via Bash for a known directory, ' +
        'or Glob for pattern search.',
    ),
  line_offset: z
    .union([PositiveLineOffsetSchema, TailLineOffsetSchema])
    .optional()
    .describe(
      `The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file; the absolute value cannot exceed ${String(MAX_LINES)}.`,
    ),
  n_lines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `The number of lines to read; the tool also applies its internal cap. Omit to read up to the internal cap of ${String(MAX_LINES)} lines. Text files only.`,
    ),
  region: z
    .object({
      x: z.number().int().min(0).describe('Left edge of the crop, in original-image pixels.'),
      y: z.number().int().min(0).describe('Top edge of the crop, in original-image pixels.'),
      width: z.number().int().min(1).describe('Crop width, in original-image pixels.'),
      height: z.number().int().min(1).describe('Crop height, in original-image pixels.'),
    })
    .optional()
    .describe(
      'Images only: view just this rectangle of the image (original-image pixel coordinates). ' +
        'Use after a downsampled full view to inspect fine detail — a region within the size ' +
        'limits is delivered at full fidelity.',
    ),
  full_resolution: z
    .boolean()
    .optional()
    .describe(
      'Images only: skip the default downscaling and view at native resolution. Fails with an ' +
        'explicit error when the payload would exceed the per-image byte limit; use region for ' +
        'files that large.',
    ),
});

export const ReadOutputSchema = z.object({
  content: z.string(),
  lineCount: z.number().int().nonnegative(),
});

export type ReadInput = z.infer<typeof ReadInputSchema>;
export type ReadOutput = z.infer<typeof ReadOutputSchema>;

export interface IReadTool extends AgentTool<ReadInput> {
  readonly _serviceBrand: undefined;
}
export const IReadTool = createDecorator<IReadTool>('readTool');
