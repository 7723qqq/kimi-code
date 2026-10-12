/**
 * Scenario: the MCP management panel in the Webview.
 * Responsibilities: project-layer config files are listed with the workspace cwd, and an unreadable or
 * malformed config file surfaces as a warning instead of silently dropping its servers.
 * Wiring: real temporary workspace files plus the public handler surface; the engine harness and VS Code APIs are stubbed.
 * Run: cd apps/vscode && bunx vitest run --config vitest.config.ts test/mcp.handler.test.ts
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Methods } from "../shared/bridge";
import type { MCPServerConfig, UpdateMCPServerRequest } from "../shared/legacy-sdk";
import { mcpHandlers } from "../src/handlers/mcp.handler";
import type { HandlerContext } from "../src/handlers/types";

vi.mock("vscode", () => ({
  Uri: { parse: (value: string) => ({ value }) },
  env: { openExternal: async () => true },
  ProgressLocation: { Notification: 15 },
  window: {
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
  },
}));

const homeDir = "/tmp/kimi-mcp-handler-home";

let root: string;
let workDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kimi-vscode-mcp-handler-"));
  workDir = join(root, "workspace");
  await mkdir(workDir, { recursive: true });
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("getMCPServers (project-layer config warnings)", () => {
  it("warns once about a malformed .mcp.json and keeps the other servers", async () => {
    const ctx = createContext();
    await writeFile(
      join(workDir, ".mcp.json"),
      '{ "mcpServers": { "broken": { "transport": "http", } } }',
    );
    await mkdir(join(workDir, ".kimi-code"), { recursive: true });
    await writeFile(
      join(workDir, ".kimi-code", "mcp.json"),
      JSON.stringify({ mcpServers: { "project-api": { transport: "http", url: "https://x.test" } } }),
    );

    const catalog = await getServers(ctx);

    expect(catalog.warnings).toHaveLength(1);
    expect(catalog.warnings![0]).toContain(".mcp.json");
    expect(catalog.warnings![0]).toContain("not valid JSON");
    expect(catalog.servers.map((server) => server.name).sort()).toEqual([
      "global-api",
      "project-api",
    ]);
  });

  it("warns about a project config file that is not valid JSON", async () => {
    const ctx = createContext();
    await writeFile(join(workDir, ".mcp.json"), "[broken");

    const catalog = await getServers(ctx);

    expect(catalog.warnings).toEqual([expect.stringContaining(".mcp.json")]);
    expect(catalog.warnings![0]).toContain("not valid JSON");
  });

  it("reports which project config file could not be read", async () => {
    const ctx = createContext();
    await mkdir(join(workDir, ".mcp.json"));

    const catalog = await getServers(ctx);

    expect(catalog.warnings).toHaveLength(1);
    expect(catalog.warnings![0]!.startsWith(join(workDir, ".mcp.json"))).toBe(true);
    expect(catalog.servers.map((server) => server.name)).toEqual(["global-api"]);
  });

  it("stays silent when no project config file exists", async () => {
    const ctx = createContext();

    const catalog = await getServers(ctx);

    expect(catalog.warnings).toBeUndefined();
    expect(catalog.servers.map((server) => server.name)).toEqual(["global-api"]);
  });

  it("asks the engine for project-layer servers with the workspace cwd", async () => {
    const ctx = createContext();

    await getServers(ctx);

    expect(ctx.harness.listMcpServers).toHaveBeenCalledWith({ cwd: workDir });
  });

  it("lists only the global servers when no workspace is selected", async () => {
    const ctx = createContext({ workDir: null });

    const catalog = await getServers(ctx);

    expect(ctx.harness.listMcpServers).toHaveBeenCalledWith({ cwd: undefined });
    expect(catalog.servers.map((server) => server.name)).toEqual(["global-api"]);
    expect(catalog.warnings).toBeUndefined();
  });
});

describe("MCP mutation RPCs (catalog payload)", () => {
  it("returns the project-layer entry after adding a server", async () => {
    const ctx = createContext();
    await writeFile(
      join(workDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "project-api": { transport: "http", url: "https://x.test" } } }),
    );

    const catalog = await addServer(ctx, {
      name: "user-api",
      transport: "http",
      url: "https://y.test",
    });

    expect(catalog.servers.map((server) => server.name).sort()).toEqual([
      "global-api",
      "project-api",
      "user-api",
    ]);
    expect(ctx.broadcast).toHaveBeenCalledWith(
      "mcpServersChanged",
      expect.objectContaining({ servers: expect.any(Array) }),
    );
  });

  it("keeps the malformed-config warning visible after an update", async () => {
    const ctx = createContext();
    await writeFile(join(workDir, ".mcp.json"), "{ oops");

    const catalog = (await mcpHandlers[Methods.UpdateMCPServer]!(
      { originalName: "global-api", server: { name: "global-api", transport: "http", url: "https://z.test" } } satisfies UpdateMCPServerRequest,
      ctx,
    )) as { servers: MCPServerConfig[]; warnings?: string[] };

    expect(catalog.warnings).toHaveLength(1);
  });
});

function createContext(overrides: { workDir?: string | null } = {}): HandlerContext {
  const selectedWorkDir = overrides.workDir === undefined ? workDir : overrides.workDir;
  const globalServers: MCPServerConfig[] = [
    { name: "global-api", transport: "http", url: "https://global.test" },
  ];
  const harness = {
    homeDir,
    listMcpServers: vi.fn(async () => [...globalServers]),
    addMcpServer: vi.fn(async (server: MCPServerConfig) => {
      globalServers.push(server);
    }),
    updateMcpServer: vi.fn(async () => undefined),
    removeMcpServer: vi.fn(async () => undefined),
  };
  return {
    webviewId: "view-1",
    workDir: selectedWorkDir,
    workDirUri: selectedWorkDir === null ? null : { fsPath: selectedWorkDir },
    harness,
    broadcast: vi.fn(),
    logError: vi.fn(),
  } as unknown as HandlerContext;
}

async function getServers(ctx: HandlerContext): Promise<{
  servers: MCPServerConfig[];
  warnings?: string[];
}> {
  return (await mcpHandlers[Methods.GetMCPServers]!(undefined, ctx)) as {
    servers: MCPServerConfig[];
    warnings?: string[];
  };
}

async function addServer(
  ctx: HandlerContext,
  server: MCPServerConfig,
): Promise<{ servers: MCPServerConfig[]; warnings?: string[] }> {
  return (await mcpHandlers[Methods.AddMCPServer]!(server, ctx)) as {
    servers: MCPServerConfig[];
    warnings?: string[];
  };
}
