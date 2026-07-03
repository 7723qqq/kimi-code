/**
 * `edit` domain — {@link FileEditService}, the os-backed edit adapter.
 *
 * Reads a file through the os `hostFs` domain (`IHostFileSystem`), runs the
 * pure edit logic ({@link TextModel} + {@link EditService}), and writes the
 * re-materialized content back. Returns the tool-facing `ExecutableToolResult`
 * so {@link EditTool} stays a thin Agent entry (path resolution, permission,
 * display).
 */

import type { ExecutableToolResult } from '#/agent/tool';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { EditService } from './editService';
import { TextModel } from './textModel';

export interface FileEditInput {
  /** Absolute, access-checked path to read and write. */
  readonly path: string;
  /** User-facing path used in messages. */
  readonly displayPath: string;
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all: boolean;
}

export class FileEditService {
  private readonly editor: EditService;

  constructor(
    private readonly fs: IHostFileSystem,
    editor: EditService = new EditService(),
  ) {
    this.editor = editor;
  }

  async edit(input: FileEditInput): Promise<ExecutableToolResult> {
    try {
      const raw = await this.fs.readText(input.path);
      const model = new TextModel(raw);
      const result = this.editor.apply(model, {
        path: input.displayPath,
        old_string: input.old_string,
        new_string: input.new_string,
        replace_all: input.replace_all,
      });
      if (!result.ok) {
        return { isError: true, output: result.error };
      }
      await this.fs.writeText(input.path, result.rawContent);
      const word = result.count === 1 ? 'occurrence' : 'occurrences';
      return { output: `Replaced ${String(result.count)} ${word} in ${input.displayPath}` };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'EISDIR') {
        return { isError: true, output: `${input.displayPath} is not a file.` };
      }
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
