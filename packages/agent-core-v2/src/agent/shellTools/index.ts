/**
 * `shellTools` domain barrel — re-exports the built-in Bash tool and the
 * shared output `ToolResultBuilder`. The Bash tool self-registers via
 * `registerTool(BashTool)` at module load, so importing this barrel is what
 * wires it into every Agent-scope tool registry.
 */

export * from '#/agent/shellTools/tools/bash';
export * from '#/agent/shellTools/tools/result-builder';
