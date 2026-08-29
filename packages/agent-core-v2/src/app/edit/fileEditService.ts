import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { tryNativeEdit } from '#/_base/native-tools';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFileSystem } from '#/os/backends/host/hostFsService';

import { EditService } from './editService';
import { type FileEditInput, type FileEditResult, IFileEditService } from './fileEdit';
import { TextModel } from './textModel';

export class FileEditService implements IFileEditService {
  declare readonly _serviceBrand: undefined;

  private readonly editor: EditService;

  constructor(@IHostFileSystem private readonly fs: IHostFileSystem) {
    this.editor = new EditService();
  }

  async edit(input: FileEditInput, fs: IHostFileSystem = this.fs): Promise<FileEditResult> {
    // Native fast path: the Rust engine performs the read/edit/write as one
    // hop (CRLF model view, unique-match rules, write-back in the detected
    // line-ending style). It operates on the real disk directly, so it is
    // only used when both the injected service fs and the runtime fs are
    // the host backend — injected fakes (tests, virtual/remote backends)
    // keep the TS path.
    if (fs instanceof HostFileSystem && this.fs instanceof HostFileSystem) {
      const native = await tryNativeEdit(
        input.path,
        input.old_string,
        input.new_string,
        input.replace_all,
      );
      if (native !== undefined) {
        if (native.success) return { ok: true, count: native.replacements };
        // Native error copy embeds the disk path; display the user's path.
        const error =
          input.displayPath === input.path || native.error === undefined
            ? (native.error ?? 'Edit failed')
            : native.error.replaceAll(input.path, input.displayPath);
        return { ok: false, error };
      }
    }

    try {
      const raw = await fs.readText(input.path, { errors: 'strict' });
      const model = new TextModel(raw);
      const result = this.editor.apply(model, {
        path: input.displayPath,
        old_string: input.old_string,
        new_string: input.new_string,
        replace_all: input.replace_all,
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      await fs.writeText(input.path, result.rawContent);
      return { ok: true, count: result.count };
    } catch (error) {
      const code = (unwrapErrorCause(error) as { code?: unknown } | null)?.code;
      if (code === 'EISDIR') {
        return { ok: false, error: `${input.displayPath} is not a file.` };
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IFileEditService,
  FileEditService,
  ScopeActivation.OnScopeCreated,
  'edit',
);
