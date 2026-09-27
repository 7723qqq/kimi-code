#!/usr/bin/env node
// Thin CLI around the tool registry so Normify can be driven from a shell
// (handy for scripts, CI, and debugging without a host):
//
//   normify --list
//   normify --help <topic>
//   normify normify_validate '{"project":"demo","repoRoot":"F:/repo"}'
//   cat args.json | normify normify_tree_list -

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createToolRegistry } from './tools.js';

const USAGE = `normify — normalized structure-diagram builder (CLI)

Usage:
  normify --list                 列出全部 normify_* 工具
  normify --describe <tool>      打印某个工具的 JSON Schema
  normify --help [topic]         规范速查（等价 normify_help）
  normify <tool> [json | -]      调用工具；'-' 表示从 stdin 读 JSON 实参
  normify --version

Environment:
  NORMIFY_ROOT   结构数据项目的父目录（默认当前工作目录）

Examples:
  normify normify_tree_list '{}'
  normify normify_project_init '{"project":"demo","root":{"id":"demo","name":{"zh":"演示","en":"Demo"},"description":{"zh":"演示项目","en":"Demo project"}}}'
  echo '{"project":"demo"}' | normify normify_validate -
`;

function parseStdin(): unknown {
  const raw = readFileSync(0, 'utf8').trim();
  return raw.length === 0 ? {} : JSON.parse(raw);
}

export async function main(argv: readonly string[]): Promise<number> {
  const [first, second] = argv;

  if (first === undefined || first === '--help' || first === '-h') {
    if (first === '--help' && second !== undefined && second !== 'true') {
      const tools = createToolRegistry({ rootDir: process.env.NORMIFY_ROOT ?? process.cwd() });
      const help = tools.find((tool) => tool.name === 'normify_help');
      const value = await help?.execute({ topic: second });
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      return isFailure(value) ? 1 : 0;
    }
    console.log(USAGE);
    return 0;
  }
  if (first === '--version') {
    console.log('0.5.4');
    return 0;
  }

  const tools = createToolRegistry({ rootDir: process.env.NORMIFY_ROOT ?? process.cwd() });

  if (first === '--list') {
    for (const tool of tools) console.log(`${tool.name}\t[${tool.behavior}]\t${tool.description.split('\n')[0]}`);
    return 0;
  }
  if (first === '--describe') {
    const tool = tools.find((candidate) => candidate.name === second);
    if (tool === undefined) {
      console.error(`Unknown tool: ${String(second)}`);
      return 1;
    }
    console.log(JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.parameters ?? {} }, null, 2));
    return 0;
  }

  const tool = tools.find((candidate) => candidate.name === first);
  if (tool === undefined) {
    console.error(`Unknown tool: ${first}\n\n${USAGE}`);
    return 1;
  }

  let args: unknown = {};
  if (second === '-') args = parseStdin();
  else if (second !== undefined) args = JSON.parse(second);

  const value = await tool.execute(args);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return isFailure(value) ? 1 : 0;
}

function isFailure(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

// Robust main-module detection: `process.argv[1]` is a native path (and may be a
// symlink, e.g. via `bun link`), while `import.meta.url` is always a file URL.
function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
