/**
 * GlobTool tests for the v2 fileTools domain.
 *
 * Ported from v1 (`packages/agent-core/test/tools/glob.test.ts`) and adapted
 * to the v2 constructor `(fs, kaos, workspace)`. Self-contained: builds minimal
 * fake `ISessionAgentFileSystem` (map/spied `glob` + `stat` + `readdir` + `withCwd`)
 * and `IKaos` inline so the tool can be exercised without the composition root.
 *
 * v2 `ISessionAgentFileSystem.glob(pattern)` searches from `fs.cwd` and returns a
 * collected array (no per-root async generator), so the v1 `(root, pattern)`
 * call assertions become `withCwd(root)` + `glob(pattern)` pairs. v2
 * `AgentFileStat` carries no mtime, so the mtime-sort test is adapted to
 * assert walk order instead.
 */

import { describe, expect, it, vi } from 'vitest';

import { PathSecurityError, type PathClass } from '../../src/_base/tools/policies/path-access';
import type { WorkspaceConfig } from '../../src/_base/tools/support/workspace';
import type { AgentFileStat, ISessionAgentFileSystem } from '../../src/agentFs';
import {
  expandBraces,
  type GlobInput,
  GlobInputSchema,
  GlobTool,
  MAX_MATCHES,
} from '../../src/fileTools/tools/glob';
import type { IKaos } from '../../src/kaos';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../src/tool';

const signal = new AbortController().signal;
const workspace: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: ['/extra'] };

function fileStat(size = 0): AgentFileStat {
  return { isFile: true, isDirectory: false, size };
}

function dirStat(size = 0): AgentFileStat {
  return { isFile: false, isDirectory: true, size };
}

function createTestKaos(opts: { home?: string; pathClass?: PathClass } = {}): IKaos {
  return {
    pathClass: () => opts.pathClass ?? 'posix',
    gethome: () => opts.home ?? '/home/test',
  } as unknown as IKaos;
}

/**
 * Fake fs with spied `glob` / `stat` / `readdir` / `withCwd`. `withCwd` returns
 * a derived fs that shares the same spied IO mocks but carries the new `cwd`,
 * mirroring the real `SessionAgentFileSystem.withCwd` semantics. The base fs's
 * `withCwd` is exposed so tests can assert the resolved search root.
 */
function createSpiedGlobFs(opts: {
  cwd?: string;
  glob?: ReturnType<typeof vi.fn>;
  stat?: ReturnType<typeof vi.fn>;
  readdir?: ReturnType<typeof vi.fn>;
} = {}) {
  const glob = opts.glob ?? vi.fn(async (): Promise<readonly string[]> => []);
  const stat = opts.stat ?? vi.fn(async (): Promise<AgentFileStat> => fileStat());
  const readdir = opts.readdir ?? vi.fn(async (): Promise<readonly string[]> => []);

  function build(cwd: string): { fs: ISessionAgentFileSystem; withCwd: ReturnType<typeof vi.fn> } {
    const withCwd = vi.fn((nextCwd: string) => build(nextCwd).fs);
    const fs = { cwd, glob, stat, readdir, withCwd } as unknown as ISessionAgentFileSystem;
    return { fs, withCwd };
  }

  const { fs, withCwd } = build(opts.cwd ?? '/workspace');
  return { fs, glob, stat, readdir, withCwd };
}

function isPromiseLike(value: ToolExecution | Promise<ToolExecution>): value is Promise<ToolExecution> {
  return typeof (value as Promise<ToolExecution>).then === 'function';
}

async function execute(tool: GlobTool, args: GlobInput): Promise<ExecutableToolResult> {
  let execution: ToolExecution;
  try {
    const resolved = tool.resolveExecution(args);
    execution = isPromiseLike(resolved) ? await resolved : resolved;
  } catch (error) {
    const output =
      error instanceof PathSecurityError
        ? error.message
        : `Tool "${tool.name}" failed to resolve execution: ${
            error instanceof Error ? error.message : String(error)
          }`;
    return { isError: true, output };
  }
  if (execution.isError === true) return execution;
  const ctx: ExecutableToolContext = {
    turnId: '0',
    toolCallId: 'call_glob',
    signal,
  };
  return execution.execute(ctx);
}

function toolContentString(result: ExecutableToolResult): string {
  const c = result.output;
  if (typeof c !== 'string') {
    throw new TypeError(`expected string content, got ${typeof c}`);
  }
  return c;
}

describe('GlobTool', () => {
  it('exposes current metadata and schema', () => {
    const { fs } = createSpiedGlobFs();
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    expect(tool.name).toBe('Glob');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { pattern: { type: 'string' } },
    });
    expect(GlobInputSchema.safeParse({ pattern: 'src/**/*.ts' }).success).toBe(true);
    expect(GlobInputSchema.safeParse({ pattern: '*.js', path: '/src' }).success).toBe(true);
  });

  it('exposes the include_dirs default in its JSON Schema without making it required', () => {
    const { fs } = createSpiedGlobFs();
    const tool = new GlobTool(fs, createTestKaos(), workspace);
    const schema = tool.parameters as {
      properties: { include_dirs: { default?: unknown } };
      required?: string[];
    };

    // The default must be structurally visible to the model, not only
    // described in prose, so it survives without an explicit argument.
    expect(schema.properties.include_dirs.default).toBe(true);
    // A default value must not promote include_dirs into `required`.
    expect(schema.required ?? []).not.toContain('include_dirs');
  });

  it('injects the Windows path hint into the description on a win32 backend', () => {
    const { fs } = createSpiedGlobFs();
    const tool = new GlobTool(fs, createTestKaos({ pathClass: 'win32' }), workspace);

    expect(tool.description).toContain('Windows');
    expect(tool.description).toContain('forward slashes');
    expect(tool.description).toContain('Bash');
  });

  it('omits the Windows path hint from the description on a non-Windows backend', () => {
    const { fs } = createSpiedGlobFs();
    const tool = new GlobTool(fs, createTestKaos({ pathClass: 'posix' }), workspace);

    expect(tool.description).not.toContain('forward slashes');
  });

  it('returns matching paths in walk order, relative to an explicit search root', async () => {
    // v1 sorted by mtime; v2 `AgentFileStat` carries no mtime, so the
    // result order is the glob yield order.
    const glob = vi.fn(async () => ['/workspace/src/old.ts', '/workspace/src/new.ts']);
    const { fs, withCwd } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: 'src/**/*.ts', path: '/workspace' });

    expect(result.output).toBe('src/old.ts\nsrc/new.ts');
    expect(withCwd).toHaveBeenCalledWith('/workspace');
    expect(glob).toHaveBeenCalledWith('src/**/*.ts');
  });

  it('uses the backend path class when displaying paths relative to a windows root', async () => {
    const glob = vi.fn(async () => ['C:\\workspace\\src\\old.ts']);
    const { fs, withCwd } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos({ pathClass: 'win32' }), {
      workspaceDir: 'C:\\workspace',
      additionalDirs: [],
    });

    const result = await execute(tool, { pattern: 'src/**/*.ts', path: 'C:\\WORKSPACE' });

    expect(result.output).toBe('src/old.ts');
    expect(withCwd).toHaveBeenCalledWith('C:/WORKSPACE');
    expect(glob).toHaveBeenCalledWith('src/**/*.ts');
  });

  it('walks pure-wildcard patterns instead of rejecting them, capping at MAX_MATCHES', async () => {
    // Previously rejected up-front; now the 100-match cap is the only
    // safety. Verifies the pattern reaches the filesystem and the cap fires.
    const paths = Array.from({ length: MAX_MATCHES + 5 }, (_, i) => `/workspace/${String(i)}.ts`);
    const glob = vi.fn(async () => paths);
    const { fs, withCwd } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: '**' });

    expect(result.isError).toBeFalsy();
    expect(withCwd).toHaveBeenCalledWith('/workspace');
    expect(glob).toHaveBeenCalledWith('**');
    expect(result.output).toContain(`[Truncated at ${String(MAX_MATCHES)} matches`);
  });

  it('expands brace patterns into multiple sub-pattern walks and dedups paths', async () => {
    // `*.{ts,tsx}` → two glob calls with `*.ts` and `*.tsx`. Shared hits
    // are deduped so the same file does not appear twice.
    const glob = vi.fn(async (pattern: string): Promise<readonly string[]> => {
      if (pattern === '*.ts') return ['/workspace/a.ts', '/workspace/shared.ts'];
      if (pattern === '*.tsx') return ['/workspace/shared.tsx', '/workspace/shared.ts'];
      return [];
    });
    const { fs, withCwd } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: '*.{ts,tsx}' });

    expect(result.isError).toBeFalsy();
    expect(withCwd).toHaveBeenCalledWith('/workspace');
    expect(glob).toHaveBeenCalledWith('*.ts');
    expect(glob).toHaveBeenCalledWith('*.tsx');
    const output = toolContentString(result);
    const lines = output.split('\n').filter((l) => l.endsWith('.ts') || l.endsWith('.tsx'));
    expect(lines).toContain('a.ts');
    expect(lines).toContain('shared.ts');
    expect(lines).toContain('shared.tsx');
    // Dedup: shared.ts appears only once even though both sub-patterns yielded it.
    expect(lines.filter((l) => l === 'shared.ts')).toHaveLength(1);
  });

  it('collapses redundant separators after brace expansion', async () => {
    // `src//*.{ts,tsx}` → expandBraces → `src//*.ts` / `src//*.tsx` →
    // normalize → `src/*.ts` / `src/*.tsx`.
    const glob = vi.fn(async (pattern: string): Promise<readonly string[]> => {
      if (pattern === 'src/*.ts') return ['/workspace/src/a.ts'];
      if (pattern === 'src/*.tsx') return ['/workspace/src/b.tsx'];
      return [];
    });
    const { fs } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: 'src//*.{ts,tsx}' });

    expect(result.isError).toBeFalsy();
    expect(glob).toHaveBeenCalledWith('src/*.ts');
    expect(glob).toHaveBeenCalledWith('src/*.tsx');
  });

  it('removes a leading ./ after brace expansion', async () => {
    // `./src/*.{ts,tsx}` → expandBraces → `./src/*.ts` / `./src/*.tsx` →
    // normalize → `src/*.ts` / `src/*.tsx`.
    const glob = vi.fn(async (pattern: string): Promise<readonly string[]> => {
      if (pattern === 'src/*.ts') return ['/workspace/src/a.ts'];
      if (pattern === 'src/*.tsx') return ['/workspace/src/b.tsx'];
      return [];
    });
    const { fs } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: './src/*.{ts,tsx}' });

    expect(result.isError).toBeFalsy();
    expect(glob).toHaveBeenCalledWith('src/*.ts');
    expect(glob).toHaveBeenCalledWith('src/*.tsx');
  });

  it('normalizes `..` inside a brace alternative without collapsing across the braces', async () => {
    // `src/{foo/../bar,baz}/*.ts` must first split on the brace group,
    // *then* normalize each alternative — otherwise pathe collapses
    // `foo/../bar,baz}` together and the whole brace structure is lost.
    const glob = vi.fn(async (pattern: string): Promise<readonly string[]> => {
      if (pattern === 'src/bar/*.ts') return ['/workspace/src/bar/a.ts'];
      if (pattern === 'src/baz/*.ts') return ['/workspace/src/baz/b.ts'];
      return [];
    });
    const { fs } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: 'src/{foo/../bar,baz}/*.ts' });

    expect(result.isError).toBeFalsy();
    expect(glob).toHaveBeenCalledWith('src/bar/*.ts');
    expect(glob).toHaveBeenCalledWith('src/baz/*.ts');
  });

  it('preserves backslash-escaped glob metacharacters end-to-end', async () => {
    // `\{a,b\}.ts` opts out of brace expansion (the user wants to match a
    // file literally named `{a,b}.ts`). glob must receive the pattern
    // unchanged — running pathe.normalize over it would rewrite the escape
    // backslashes into path separators and break the intent.
    const glob = vi.fn(async (pattern: string): Promise<readonly string[]> => {
      if (pattern === '\\{a,b\\}.ts') return ['/workspace/{a,b}.ts'];
      return [];
    });
    const { fs, withCwd } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: '\\{a,b\\}.ts' });

    expect(result.isError).toBeFalsy();
    expect(withCwd).toHaveBeenCalledWith('/workspace');
    expect(glob).toHaveBeenCalledWith('\\{a,b\\}.ts');
    // And it must *not* have been called with any brace-expanded form.
    expect(glob).not.toHaveBeenCalledWith(expect.stringContaining('/'));
  });

  it('searches only the current workspace when path is omitted', async () => {
    const glob = vi.fn(async () => ['/workspace/a.ts', '/workspace/shared.ts']);
    const { fs, withCwd } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: '*.ts' });

    expect(glob).toHaveBeenCalledTimes(1);
    expect(withCwd).toHaveBeenCalledWith('/workspace');
    expect(glob).toHaveBeenCalledWith('*.ts');
    expect(result.output).toBe('a.ts\nshared.ts');
  });

  it('can search an additional directory when path is explicit', async () => {
    const glob = vi.fn(async () => ['/extra/pkg/a.ts']);
    const { fs, withCwd } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: 'pkg/**/*.ts', path: '/extra' });

    expect(result.output).toBe('/extra/pkg/a.ts');
    expect(glob).toHaveBeenCalledTimes(1);
    expect(withCwd).toHaveBeenCalledWith('/extra');
    expect(glob).toHaveBeenCalledWith('pkg/**/*.ts');
  });

  it('filters directories when include_dirs is false', async () => {
    const glob = vi.fn(async () => ['/workspace/src', '/workspace/src/a.ts']);
    const stat = vi
      .fn()
      .mockResolvedValueOnce(dirStat(2))
      .mockResolvedValueOnce(fileStat(1));
    const { fs } = createSpiedGlobFs({ glob, stat });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, {
      pattern: 'src*',
      path: '/workspace',
      include_dirs: false,
    });

    expect(result.output).toBe('src/a.ts');
  });

  it('caps returned matches and surfaces the truncation header', async () => {
    const paths = Array.from({ length: MAX_MATCHES + 1 }, (_, i) => `/workspace/${String(i)}.ts`);
    const glob = vi.fn(async () => paths);
    const { fs } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await execute(tool, { pattern: '*.ts' });

    expect(result.output).toContain(
      `[Truncated at ${String(MAX_MATCHES)} matches — ${String(MAX_MATCHES)} matched so far, use a more specific pattern]`,
    );
    expect(result.output).toContain('0.ts');
    expect(result.output).not.toContain(`${String(MAX_MATCHES)}.ts`);
  });

  describe('skills / additional dirs', () => {
    const skillsWorkspace: WorkspaceConfig = {
      workspaceDir: '/workspace',
      additionalDirs: ['/skills'],
    };

    it('searches inside a registered additionalDir entry', async () => {
      const glob = vi.fn(async () => ['/skills/read_content.py', '/skills/utils.py']);
      const { fs, withCwd } = createSpiedGlobFs({ glob });
      const tool = new GlobTool(fs, createTestKaos(), skillsWorkspace);

      const result = await execute(tool, { pattern: '*.py', path: '/skills' });

      expect(result.output).toContain('/skills/read_content.py');
      expect(result.output).toContain('/skills/utils.py');
      expect(withCwd).toHaveBeenCalledWith('/skills');
      expect(glob).toHaveBeenCalledWith('*.py');
    });

    it('searches inside a subdirectory of an additionalDir entry', async () => {
      const glob = vi.fn(async () => ['/skills/feishu/scripts/read_content.py']);
      const { fs, withCwd } = createSpiedGlobFs({ glob });
      const tool = new GlobTool(fs, createTestKaos(), skillsWorkspace);

      const result = await execute(tool, {
        pattern: '*.py',
        path: '/skills/feishu/scripts',
      });

      expect(result.output).toContain('/skills/feishu/scripts/read_content.py');
      expect(withCwd).toHaveBeenCalledWith('/skills/feishu/scripts');
    });

    it('rejects a relative path that escapes both workspace and additionalDirs', async () => {
      const glob = vi.fn(async (): Promise<readonly string[]> => []);
      const { fs, withCwd } = createSpiedGlobFs({ glob });
      const tool = new GlobTool(fs, createTestKaos(), {
        workspaceDir: '/workspace/project',
        additionalDirs: ['/skills'],
      });

      const result = await execute(tool, { pattern: '*.py', path: '../../tmp/evil' });

      expect(result).toMatchObject({ isError: true });
      expect(result.output).toContain('absolute path');
      expect(glob).not.toHaveBeenCalled();
      expect(withCwd).not.toHaveBeenCalled();
    });

    it('accepts a path inside a deeply nested additionalDir entry', async () => {
      const glob = vi.fn(async () => ['/skills/my-skill/scripts/helper.py']);
      const { fs, withCwd } = createSpiedGlobFs({ glob });
      const tool = new GlobTool(fs, createTestKaos(), skillsWorkspace);

      const result = await execute(tool, {
        pattern: '*.py',
        path: '/skills/my-skill/scripts',
      });

      expect(result.output).toContain('/skills/my-skill/scripts/helper.py');
      expect(withCwd).toHaveBeenCalledWith('/skills/my-skill/scripts');
    });
  });

  it('walks "**/" prefix patterns with a literal anchor instead of rejecting them', async () => {
    // Previously a hard reject; now `**/*.py` reaches the filesystem like
    // any other pattern and the 100-match cap is the only safety.
    const glob = vi.fn(async () => ['/workspace/a.py', '/workspace/sub/b.py']);
    const { fs, withCwd } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: '**/*.py' });

    expect(result.isError).toBeFalsy();
    expect(withCwd).toHaveBeenCalledWith('/workspace');
    expect(glob).toHaveBeenCalledWith('**/*.py');
    expect(result.output).toContain('a.py');
    expect(result.output).toContain('sub/b.py');
  });

  it('walks safe recursive patterns with a literal subdirectory anchor', async () => {
    const glob = vi.fn(async () => [
      '/workspace/src/main.py',
      '/workspace/src/utils.py',
      '/workspace/src/main/app.py',
      '/workspace/src/main/config.py',
      '/workspace/src/test/test_app.py',
      '/workspace/src/test/test_config.py',
    ]);
    const { fs } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: 'src/**/*.py', path: '/workspace' });

    expect(result.output).toContain('src/main.py');
    expect(result.output).toContain('src/utils.py');
    expect(result.output).toContain('src/main/app.py');
    expect(result.output).toContain('src/main/config.py');
    expect(result.output).toContain('src/test/test_app.py');
    expect(result.output).toContain('src/test/test_config.py');
  });

  it('surfaces an explicit no-match message when no paths are yielded', async () => {
    const glob = vi.fn(async (): Promise<readonly string[]> => []);
    const { fs } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: '*.xyz', path: '/workspace' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('No matches found');
  });

  it('reports "does not exist" when the search directory is missing', async () => {
    // Real fs.glob silently returns empty for a missing root because its
    // kaos walker catches readdir failures. The tool pre-checks with
    // readdir so ENOENT surfaces before glob runs. Realistic mock: readdir
    // throws ENOENT, glob is never called.
    const readdir = vi.fn(async (): Promise<readonly string[]> => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    });
    const glob = vi.fn(async (): Promise<readonly string[]> => []);
    const { fs, withCwd } = createSpiedGlobFs({ readdir, glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: '*.py', path: '/workspace/nonexistent' });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('does not exist');
    expect(glob).not.toHaveBeenCalled();
    expect(withCwd).not.toHaveBeenCalled();
  });

  it('reports "is not a directory" when the search target is a file', async () => {
    // Real fs.glob silently returns empty when the root is a regular file
    // because its kaos walker's readdir hits ENOTDIR and exits. The
    // pre-check uses readdir, which raises ENOTDIR on file-as-dir.
    // Realistic mock: readdir throws ENOTDIR, glob is never called.
    const readdir = vi.fn(async (): Promise<readonly string[]> => {
      throw Object.assign(new Error('ENOTDIR: not a directory'), { code: 'ENOTDIR' });
    });
    const glob = vi.fn(async (): Promise<readonly string[]> => []);
    const { fs, withCwd } = createSpiedGlobFs({ readdir, glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: '*.py', path: '/workspace/file.txt' });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('is not a directory');
    expect(glob).not.toHaveBeenCalled();
    expect(withCwd).not.toHaveBeenCalled();
  });

  it('surfaces a "first N matches" header when matches exceed MAX_MATCHES', async () => {
    const paths = Array.from(
      { length: MAX_MATCHES + 50 },
      (_, i) => `/workspace/file_${String(i)}.txt`,
    );
    const glob = vi.fn(async () => paths);
    const { fs } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await execute(tool, { pattern: '*.txt' });

    expect(result.output).toContain(`Only the first ${String(MAX_MATCHES)} matches are returned`);
  });

  it('returns a "Found N matches" footer at exactly MAX_MATCHES without truncation', async () => {
    const paths = Array.from({ length: MAX_MATCHES }, (_, i) => `/workspace/test_${String(i)}.py`);
    const glob = vi.fn(async () => paths);
    const { fs } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await execute(tool, { pattern: '*.py' });

    expect(result.output).not.toContain('Only the first');
    expect(result.output).toContain(`Found ${String(MAX_MATCHES)} matches`);
  });

  it('walks "**/" patterns with literal subdirectory anchors after the prefix', async () => {
    // Previously rejected up-front; now `**/main/*.py` walks like any
    // other anchored pattern.
    const glob = vi.fn(async () => ['/workspace/src/main/app.py']);
    const { fs, withCwd } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: '**/main/*.py' });

    expect(result.isError).toBeFalsy();
    expect(withCwd).toHaveBeenCalledWith('/workspace');
    expect(glob).toHaveBeenCalledWith('**/main/*.py');
    expect(result.output).toContain('src/main/app.py');
  });

  it('matches dotfiles like .gitlab-ci.yml under a simple "*.yml" pattern', async () => {
    const glob = vi.fn(async () => ['/workspace/.gitlab-ci.yml', '/workspace/config.yml']);
    const { fs } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: '*.yml' });

    expect(result.output).toContain('.gitlab-ci.yml');
    expect(result.output).toContain('config.yml');
  });

  it('descends into hidden directories under a recursive pattern', async () => {
    const glob = vi.fn(async () => ['/workspace/src/.config/settings.yml']);
    const { fs } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: 'src/**/*.yml' });

    expect(result.output).toContain('src/.config/settings.yml');
  });

  it('matches files inside an explicitly addressed hidden directory', async () => {
    const glob = vi.fn(async () => ['/workspace/.github/workflows/ci.yml']);
    const { fs } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: '.github/**/*.yml' });

    expect(result.output).toContain('.github/workflows/ci.yml');
  });

  it('shows absolute paths when explicit search root is outside all workspace roots', async () => {
    // When the search root is not inside workspaceDir, matches must stay
    // absolute in the output. Otherwise the model would resolve a
    // relativized path against the workspace cwd and hit the wrong file.
    const glob = vi.fn(async () => ['/extra/test.py']);
    const { fs, withCwd } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await execute(tool, { pattern: '*.py', path: '/extra' });
    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('/extra/test.py');
    expect(withCwd).toHaveBeenCalledWith('/extra');
  });

  it('keeps absolute paths when explicit search root is an additionalDir', async () => {
    // AdditionalDirs are searchable, but model-visible relative paths
    // still resolve against workspaceDir in follow-up Read/Edit calls, so
    // matches under an additionalDir stay absolute.
    const registered: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: ['/extra'] };
    const glob = vi.fn(async () => ['/extra/test.py']);
    const { fs } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), registered);

    const result = await execute(tool, { pattern: '*.py', path: '/extra' });
    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('/extra/test.py');
  });

  it('allows a relative path argument that resolves inside the workspace', async () => {
    const glob = vi.fn(async () => ['/workspace/relative/path/test.py']);
    const { fs, withCwd } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    const result = await execute(tool, { pattern: '*.py', path: 'relative/path' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('test.py');
    expect(withCwd).toHaveBeenCalledWith('/workspace/relative/path');
    expect(glob).toHaveBeenCalledWith('*.py');
  });

  it('expands a leading "~/" path before searching outside the workspace', async () => {
    const glob = vi.fn(async (): Promise<readonly string[]> => []);
    const { fs, withCwd } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos({ home: '/home/test' }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await execute(tool, { pattern: '*.py', path: '~/' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('No matches found');
    expect(withCwd).toHaveBeenCalledWith('/home/test');
    expect(glob).toHaveBeenCalledWith('*.py');
  });

  it('allows a path sharing the workspace prefix when it is absolute', async () => {
    const glob = vi.fn(async (): Promise<readonly string[]> => []);
    const { fs, withCwd } = createSpiedGlobFs({ glob });
    const tool = new GlobTool(fs, createTestKaos(), {
      workspaceDir: '/parent/workdir',
      additionalDirs: [],
    });

    const result = await execute(tool, { pattern: '*.py', path: '/parent/workdir-sneaky' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('No matches found');
    expect(withCwd).toHaveBeenCalledWith('/parent/workdir-sneaky');
    expect(glob).toHaveBeenCalledWith('*.py');
  });

  it('locks down brace-expansion mention and large-directory caveats in the description', () => {
    const { fs } = createSpiedGlobFs();
    const tool = new GlobTool(fs, createTestKaos(), workspace);

    expect(tool.description).toContain('**');
    expect(tool.description).toMatch(/\*\*\/\*\.py/);
    expect(tool.description).toContain('brace expansion');
    expect(tool.description).toContain('node_modules');
    expect(tool.description).not.toContain('On Windows');
  });

  it('mentions Windows path forms in the description on win32 backends', () => {
    const { fs } = createSpiedGlobFs();
    const tool = new GlobTool(fs, createTestKaos({ pathClass: 'win32' }), {
      workspaceDir: 'C:\\workspace',
      additionalDirs: [],
    });

    expect(tool.description).toContain('C:\\Users\\foo');
    expect(tool.description).toContain('/c/Users/foo');
  });
});

describe('expandBraces', () => {
  it('returns the original pattern unchanged when there is no brace group', () => {
    expect(expandBraces('src/**/*.ts')).toEqual(['src/**/*.ts']);
  });

  it('expands a single top-level brace group into one pattern per alternative', () => {
    expect(expandBraces('*.{ts,tsx}')).toEqual(['*.ts', '*.tsx']);
  });

  it('produces the cartesian product when more than one brace group appears', () => {
    expect(expandBraces('{src,test}/{a,b}.ts')).toEqual([
      'src/a.ts',
      'src/b.ts',
      'test/a.ts',
      'test/b.ts',
    ]);
  });

  it('recursively expands nested brace groups', () => {
    expect(expandBraces('{a,{b,c}}.ts')).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('falls through with the literal pattern when a brace group has no top-level comma', () => {
    // bash also treats `{abc}` as a literal; we follow the same rule.
    expect(expandBraces('{abc}.ts')).toEqual(['{abc}.ts']);
  });

  it('falls through with the literal pattern when braces are unbalanced', () => {
    expect(expandBraces('{a,b.ts')).toEqual(['{a,b.ts']);
    expect(expandBraces('a,b}.ts')).toEqual(['a,b}.ts']);
  });

  it('treats backslash-escaped braces as literals and does not expand them', () => {
    expect(expandBraces('\\{a,b\\}.ts')).toEqual(['\\{a,b\\}.ts']);
  });

  it('falls back to the original pattern when expansion would exceed the fan-out cap', () => {
    // Seven groups of 3 alternatives = 3^7 = 2187 patterns, well above
    // the MAX_BRACE_EXPANSIONS = 64 cap. Falling back is preferred over
    // silently dropping alternatives.
    const pathological = '{a,b,c}{d,e,f}{g,h,i}{j,k,l}{m,n,o}{p,q,r}{s,t,u}';
    expect(expandBraces(pathological)).toEqual([pathological]);
  });
});
