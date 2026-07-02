/**
 * `fileTools` domain barrel — re-exports the built-in file tools (Read / Write
 * / Edit / Grep / Glob) and the shared line-ending helpers. Each tool
 * self-registers via `registerTool(...)` at module load, so importing this
 * barrel is what wires them into every Agent-scope tool registry.
 */

export * from '#/agent/fileTools/tools/edit';
export * from '#/agent/fileTools/tools/glob';
export * from '#/agent/fileTools/tools/grep';
export * from '#/agent/fileTools/tools/line-endings';
export * from '#/agent/fileTools/tools/read';
export * from '#/agent/fileTools/tools/write';
