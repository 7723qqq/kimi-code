/**
 * Scenario: `@` file completion and inline image previews in the Webview.
 * Responsibilities: folder browsing reads the real directory, engine suggest failures fall back to the
 * workspace search, and image paths are resolved literally before any percent-decoding.
 * Wiring: real temporary files plus the public handler surface; VS Code host APIs and the engine harness are stubbed.
 * Run: cd apps/vscode && bun test --isolate test/file.handler.test.ts
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';

import type { KimiHarness } from "@moonshot-ai/kimi-code-sdk";

import { installVscode } from './vscode-host';
import { SYMLINKS } from './helpers';

import { Methods } from "../shared/bridge";
import { fileHandlers } from "../src/handlers/file.handler";
import type { HandlerContext } from "../src/handlers/types";
import { FileManager } from "../src/managers/file.manager";

// Bun runs mock factories while the test file's imports are still being linked,
// before this module's own top-level statements. The host object therefore lives
// behind a hoisted function so the factory can reach the same instance the tests
// use.
function createVscodeHost() {
  function normalizeUriPath(value: string): string {
    const segments: string[] = [];
    for (const segment of value.replaceAll("\\", "/").split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") segments.pop();
      else segments.push(segment);
    }
    return `/${segments.join("/")}`;
  }

  class Uri {
    constructor(
      readonly scheme: string,
      readonly authority: string,
      readonly path: string,
      readonly fsPath: string,
    ) {}

    static file(fsPath: string): Uri {
      return new Uri("file", "", normalizeUriPath(fsPath), fsPath);
    }

    static joinPath(base: Uri, ...segments: string[]): Uri {
      const path = normalizeUriPath(`${base.path}/${segments.join("/")}`);
      const suffix = segments.join("/");
      const separator = base.fsPath.endsWith("/") ? "" : "/";
      return new Uri(base.scheme, base.authority, path, `${base.fsPath}${separator}${suffix}`);
    }

    toString(): string {
      return `${this.scheme}://${this.authority}${this.path}`;
    }
  }

  class RelativePattern {
    readonly baseUri: Uri;
    readonly base: string;

    constructor(base: Uri, readonly pattern: string) {
      this.baseUri = base;
      this.base = base.fsPath;
    }
  }

  return {
    Uri,
    RelativePattern,
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    readDirectory: mock(),
    stat: mock(),
    readFile: mock(),
    findFiles: mock(),
  };
}

type VscodeHost = ReturnType<typeof createVscodeHost>;

const vscodeHost: VscodeHost = createVscodeHost();

installVscode({
  Uri: vscodeHost.Uri,
  RelativePattern: vscodeHost.RelativePattern,
  FileType: vscodeHost.FileType,
  workspace: {
    fs: {
      readDirectory: vscodeHost.readDirectory,
      stat: vscodeHost.stat,
      readFile: vscodeHost.readFile,
    },
    findFiles: vscodeHost.findFiles,
    createFileSystemWatcher: () => ({
      onDidChange: mock(),
      onDidCreate: mock(),
      onDidDelete: mock(),
      dispose: mock(),
    }),
  },
});

let root: string;
let workDir: string;
let workDirUri: InstanceType<typeof vscodeHost.Uri>;
let fileManager: FileManager;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vscode-file-handler-"));
  workDir = join(root, "workspace");
  await mkdir(join(workDir, "shots", "nested"), { recursive: true });
  await writeFile(join(workDir, "src.ts"), "root file");
  await writeFile(join(workDir, "shots", "50%-done.png"), Buffer.from([1, 2, 3]));
  await writeFile(join(workDir, "shots", "a%20b.png"), Buffer.from([7, 8, 9]));
  await writeFile(join(workDir, "shots", "nested", "deep.ts"), "deep");
  workDirUri = vscodeHost.Uri.file(workDir);
  vscodeHost.stat.mockImplementation(async (uri: { fsPath: string }) => {
    const info = await stat(uri.fsPath);
    return { size: info.size, type: info.isDirectory() ? 2 : 1 };
  });
  vscodeHost.readFile.mockImplementation((uri: { fsPath: string }) => readFile(uri.fsPath));
  vscodeHost.readDirectory.mockImplementation(async (uri: { fsPath: string }) => {
    const entries = await readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((entry) => [
      entry.name,
      entry.isDirectory() ? vscodeHost.FileType.Directory : vscodeHost.FileType.File,
    ]);
  });
  vscodeHost.findFiles.mockResolvedValue([]);
  fileManager = new FileManager({} as never, mock());
});

afterEach(async () => {
  fileManager.dispose();
  mock.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("getProjectFiles (folder mode and engine suggest fallback)", () => {
  it("lists the direct children of the requested directory", async () => {
    const ctx = createContext();
    const suggested = ctx.harness.suggestFiles;

    const files = await fileHandlers[Methods.GetProjectFiles]!({ directory: "shots" }, ctx);

    expect(files!.every((file: { path: string }) => file.path.startsWith("shots/"))).toBe(true);
    expect(
      files!.map((file: { path: string; isDirectory: boolean }) => [file.path, file.isDirectory]).sort(),
    ).toEqual(
      [
        ["shots/50%-done.png", false],
        ["shots/a%20b.png", false],
        ["shots/nested", true],
      ].sort(),
    );
    expect(suggested).not.toHaveBeenCalled();
    expect(vscodeHost.findFiles).not.toHaveBeenCalled();
  });

  it("falls back to the workspace search when the directory cannot be read", async () => {
    const ctx = createContext();
    vscodeHost.findFiles.mockResolvedValue([vscodeHost.Uri.file(join(workDir, "src.ts"))]);

    const files = await fileHandlers[Methods.GetProjectFiles]!({ directory: "missing" }, ctx);

    expect(vscodeHost.findFiles).toHaveBeenCalledTimes(1);
    expect(files).toEqual([{ path: "src.ts", name: "src.ts", isDirectory: false }]);
  });

  it("falls back to the workspace search when the engine cannot suggest", async () => {
    const ctx = createContext();
    ctx.harness.suggestFiles.mockRejectedValue(new Error("engine down"));
    vscodeHost.findFiles.mockResolvedValue([vscodeHost.Uri.file(join(workDir, "src.ts"))]);

    const files = await fileHandlers[Methods.GetProjectFiles]!({ query: "a" }, ctx);

    expect(ctx.logError).toHaveBeenCalledTimes(1);
    expect(files).toEqual([{ path: "src.ts", name: "src.ts", isDirectory: false }]);
  });

  it("falls back to the workspace search on a v1 engine that cannot suggest", async () => {
    const ctx = createContext();
    ctx.harness.suggestFiles.mockResolvedValue(undefined);
    vscodeHost.findFiles.mockResolvedValue([vscodeHost.Uri.file(join(workDir, "src.ts"))]);

    const files = await fileHandlers[Methods.GetProjectFiles]!({ query: "a" }, ctx);

    expect(vscodeHost.findFiles).toHaveBeenCalledTimes(1);
    expect(files).toEqual([{ path: "src.ts", name: "src.ts", isDirectory: false }]);
  });
});

describe("getImageDataUri (literal-first path resolution)", () => {
  it("returns a data URI for a real path whose name contains a stray percent", async () => {
    const ctx = createContext();

    const dataUri = await fileHandlers[Methods.GetImageDataUri]!(
      { filePath: "shots/50%-done.png" },
      ctx,
    );

    expect(dataUri).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`);
  });

  it("returns a data URI for a real file named a%20b.png", async () => {
    const ctx = createContext();

    const dataUri = await fileHandlers[Methods.GetImageDataUri]!(
      { filePath: "shots/a%20b.png" },
      ctx,
    );

    expect(dataUri).toBe(`data:image/png;base64,${Buffer.from([7, 8, 9]).toString("base64")}`);
  });

  it("decodes an encoded path when only the decoded file exists", async () => {
    const ctx = createContext();
    await writeFile(join(workDir, "shots", "c d.png"), Buffer.from([10]));

    const dataUri = await fileHandlers[Methods.GetImageDataUri]!(
      { filePath: "shots/c%20d.png" },
      ctx,
    );

    expect(dataUri).toBe(`data:image/png;base64,${Buffer.from([10]).toString("base64")}`);
  });

  it("returns null for a missing image path", async () => {
    const ctx = createContext();

    const dataUri = await fileHandlers[Methods.GetImageDataUri]!(
      { filePath: "shots/missing.png" },
      ctx,
    );

    expect(dataUri).toBeNull();
  });

  it.skipIf(!SYMLINKS)("reads through a symlink whose target stays inside the workspace", async () => {
    const ctx = createContext();
    await writeFile(join(workDir, "shots", "target.png"), Buffer.from([11]));
    await symlink(join(workDir, "shots", "target.png"), join(workDir, "shots", "alias.png"));

    const dataUri = await fileHandlers[Methods.GetImageDataUri]!({ filePath: "shots/alias.png" }, ctx);

    expect(dataUri).toBe(`data:image/png;base64,${Buffer.from([11]).toString("base64")}`);
  });
});

type SuggestFilesMock = Mock<KimiHarness["suggestFiles"]>;
type TestContext = HandlerContext & { harness: { suggestFiles: SuggestFilesMock } };

function createContext(): TestContext {
  const harness: { suggestFiles: SuggestFilesMock } = {
    suggestFiles: mock(async () => undefined),
  };
  return {
    webviewId: "view-1",
    workDir,
    workDirUri,
    requireWorkDir: () => workDir,
    requireWorkDirUri: () => workDirUri,
    fileManager,
    harness,
    logError: mock(),
  } as unknown as TestContext;
}
