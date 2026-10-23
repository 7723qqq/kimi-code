import { homedir } from 'node:os';
import { basename, isAbsolute, resolve, sep } from 'node:path';

import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionPolicy, PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import { isFullSuiteTestGuardEnabled } from '#/agent/permissionRules/configSection';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import {
  IBashParserService,
  type BashParseResult,
  type BashSyntaxNode,
} from '#/app/bashParser/bashParser';
import { IConfigService } from '#/app/config/config';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

const PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 } as const;

const MAX_NESTED_SHELL_DEPTH = 2;

const FULL_SUITE_SCRIPTS: ReadonlySet<string> = new Set([
  'test',
  'test:watch',
  'test:coverage',
  'test:heavy',
]);

const FULL_SUITE_RUNNERS: ReadonlySet<string> = new Set(['run-tests.mjs', 'run-test-heavy.mjs']);

const SCRIPT_RUNNERS: ReadonlySet<string> = new Set(['bun', 'node', 'npm', 'pnpm', 'yarn']);

const LAUNCH_WRAPPERS: ReadonlySet<string> = new Set([
  'env',
  'command',
  'exec',
  'nohup',
  'nice',
  'time',
]);

const WRAPPER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-u',
  '--unset',
  '-C',
  '--chdir',
  '-S',
  '--split-string',
  '-a',
  '-n',
  '--adjustment',
  '-o',
  '--output',
  '-f',
  '--format',
]);

const NESTED_SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash']);

const SKIPPED_COMMAND_CHILDREN: ReadonlySet<string> = new Set([
  'variable_assignment',
  'file_redirect',
  'heredoc_redirect',
]);

const DYNAMIC_OPERAND = /[$`*?[\]{}]/;

const TEST_MENTION = /test/i;

interface AnalysisContext {
  readonly rootDir: string;
  readonly parse: (source: string) => BashParseResult;
  readonly depth: number;
}

interface WalkResult {
  readonly cwd: string | undefined;
  readonly hit?: string;
}

interface InvocationShape {
  readonly name: string;
  readonly args: readonly (string | undefined)[];
}

export class FullSuiteTestAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'full-suite-test-ask';

  constructor(
    @IBashParserService private readonly bashParser: IBashParserService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IConfigService private readonly config: IConfigService,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    if (!isFullSuiteTestGuardEnabled(this.config)) return undefined;
    if (this.modeService.mode === 'auto') return undefined;
    if (context.toolCall.name !== 'Bash') return undefined;
    const command = bashCommandText(context.args);
    if (command === undefined || !TEST_MENTION.test(command)) return undefined;
    const rootDir = this.workspace.workDir;
    if (rootDir.length === 0) return undefined;
    const hit = findFullSuiteRun(command, bashCwd(context.args, rootDir), {
      rootDir,
      parse: (source) => this.bashParser.parse(source, PARSE_OPTIONS),
      depth: 0,
    });
    return hit === undefined
      ? undefined
      : { kind: 'ask', reason: { full_suite_test_command: hit } };
  }
}

function bashCommandText(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const command = (args as { readonly command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}

function bashCwd(args: unknown, rootDir: string): string {
  if (typeof args !== 'object' || args === null) return rootDir;
  const cwd = (args as { readonly cwd?: unknown }).cwd;
  if (typeof cwd !== 'string' || cwd.length === 0) return rootDir;
  return isAbsolute(cwd) ? resolve(cwd) : resolve(rootDir, cwd);
}

function findFullSuiteRun(
  source: string,
  cwd: string | undefined,
  ctx: AnalysisContext,
): string | undefined {
  const parsed = ctx.parse(source);
  if (!parsed.ok || parsed.hasError) return undefined;
  return walkNode(parsed.root, cwd, ctx).hit;
}

function walkNode(
  node: BashSyntaxNode,
  cwd: string | undefined,
  ctx: AnalysisContext,
): WalkResult {
  if (node.type === 'command') return walkCommand(node, cwd, ctx);
  const children = node.children.filter((child) => child.isNamed);
  if (node.type === 'subshell' || node.type === 'command_substitution') {
    let inner = cwd;
    for (const child of children) {
      const result = walkNode(child, inner, ctx);
      if (result.hit !== undefined) return { cwd, hit: result.hit };
      inner = result.cwd;
    }
    return { cwd };
  }
  let current = cwd;
  for (const child of children) {
    const result = walkNode(child, current, ctx);
    if (result.hit !== undefined) return { cwd: current, hit: result.hit };
    current = result.cwd;
  }
  return { cwd: current };
}

function walkCommand(
  node: BashSyntaxNode,
  cwd: string | undefined,
  ctx: AnalysisContext,
): WalkResult {
  const invocation = invocationShape(node);
  if (invocation === undefined) return { cwd };
  if (invocation.name === 'cd') return { cwd: cdTarget(invocation.args[0], cwd) };
  return walkInvocation(invocation, cwd, ctx, node.text);
}

function walkInvocation(
  invocation: InvocationShape,
  cwd: string | undefined,
  ctx: AnalysisContext,
  text: string,
): WalkResult {
  const { name, args } = invocation;
  if (LAUNCH_WRAPPERS.has(name)) {
    const rest = dropLaunchWrapperOperands(name, args);
    const inner = rest[0];
    if (inner === undefined) return { cwd };
    return walkInvocation({ name: normalizeCommandName(inner), args: rest.slice(1) }, cwd, ctx, text);
  }
  if (NESTED_SHELLS.has(name)) {
    const payload = nestedShellPayload(args);
    if (payload === undefined || ctx.depth >= MAX_NESTED_SHELL_DEPTH) return { cwd };
    const hit = findFullSuiteRun(payload, cwd, { ...ctx, depth: ctx.depth + 1 });
    return hit === undefined ? { cwd } : { cwd, hit };
  }
  if (!SCRIPT_RUNNERS.has(name)) return { cwd };
  return isFullSuiteInvocation(name, args, cwd, ctx) ? { cwd, hit: text } : { cwd };
}

function isFullSuiteInvocation(
  name: string,
  args: readonly (string | undefined)[],
  cwd: string | undefined,
  ctx: AnalysisContext,
): boolean {
  if (!isRootCwd(cwd, ctx.rootDir)) return false;
  const first = args[0];
  if (first === undefined) return false;
  if (name !== 'node') {
    if (first === 'run' || first === 'run-script') {
      const script = positionalArg(args.slice(1));
      if (script === undefined) return false;
      return isFullSuiteScript(script) || FULL_SUITE_RUNNERS.has(basename(script));
    }
    if (first === 'test') return positionalArg(args.slice(1)) === undefined;
  }
  return FULL_SUITE_RUNNERS.has(basename(first));
}

function isFullSuiteScript(script: string | undefined): boolean {
  return script !== undefined && FULL_SUITE_SCRIPTS.has(script);
}

function positionalArg(args: readonly (string | undefined)[]): string | undefined {
  for (const arg of args) {
    if (arg === undefined) return undefined;
    if (arg === '--') continue;
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return undefined;
}

function cdTarget(target: string | undefined, cwd: string | undefined): string | undefined {
  if (target === undefined) return homedir();
  if (target === '-') return undefined;
  if (cwd === undefined) return undefined;
  if (target === '~') return homedir();
  if (target.startsWith('~/') || target.startsWith(`~${sep}`)) return resolve(homedir(), target.slice(2));
  return isAbsolute(target) ? resolve(target) : resolve(cwd, target);
}

function isRootCwd(cwd: string | undefined, rootDir: string): boolean {
  return cwd !== undefined && normalizePath(cwd) === normalizePath(rootDir);
}

function normalizePath(path: string): string {
  const resolved = resolve(path);
  const trimmed =
    resolved.endsWith(sep) && resolved.length > sep.length ? resolved.slice(0, -1) : resolved;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

function invocationShape(node: BashSyntaxNode): InvocationShape | undefined {
  const nameIndex = node.children.findIndex((child) => child.type === 'command_name');
  if (nameIndex < 0) return undefined;
  const nameNode = node.children[nameIndex];
  const nameWord = nameNode?.children.find((child) => child.isNamed);
  const rawName = nameWord === undefined ? undefined : literalText(nameWord);
  if (rawName === undefined || rawName.length === 0) return undefined;
  const args: (string | undefined)[] = [];
  for (const child of node.children.slice(nameIndex + 1)) {
    if (!child.isNamed) continue;
    if (SKIPPED_COMMAND_CHILDREN.has(child.type)) continue;
    const value = literalText(child);
    args.push(value !== undefined && value.length > 0 ? value : undefined);
  }
  return { name: normalizeCommandName(rawName), args };
}

function nestedShellPayload(args: readonly (string | undefined)[]): string | undefined {
  let payloadIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) return undefined;
    if (arg === '--') break;
    if (/^-[a-zA-Z]+$/.test(arg)) {
      if (arg.includes('c')) payloadIndex = index + 1;
      continue;
    }
    break;
  }
  return payloadIndex < 0 ? undefined : args[payloadIndex];
}

function dropLaunchWrapperOperands(
  name: string,
  args: readonly (string | undefined)[],
): readonly (string | undefined)[] {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === undefined) return [];
    if (arg === '--') {
      index += 1;
      break;
    }
    if (arg === '-' || !arg.startsWith('-')) break;
    index += 1;
    if (!arg.includes('=') && WRAPPER_VALUE_OPTIONS.has(arg)) index += 1;
  }
  let rest = args.slice(index);
  if (name === 'env') {
    let start = rest[0] === '-' ? 1 : 0;
    while (start < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[start] ?? '')) start += 1;
    rest = rest.slice(start);
  }
  return rest;
}

function literalText(node: BashSyntaxNode): string | undefined {
  switch (node.type) {
    case 'word': {
      const raw = node.text;
      if (DYNAMIC_OPERAND.test(raw)) return undefined;
      const unescaped = raw.replaceAll(/\\(.)/gs, '$1');
      return DYNAMIC_OPERAND.test(unescaped) ? undefined : unescaped;
    }
    case 'number':
      return node.text;
    case 'raw_string': {
      if (node.text.length < 2) return undefined;
      const value = node.text.slice(1, -1);
      return DYNAMIC_OPERAND.test(value) ? undefined : value;
    }
    case 'string': {
      let value = '';
      for (const child of node.children) {
        if (child.type === 'string_content') {
          value += child.text;
        } else if (child.isNamed) {
          return undefined;
        }
      }
      return DYNAMIC_OPERAND.test(value) ? undefined : value;
    }
    default:
      return undefined;
  }
}

function normalizeCommandName(raw: string): string {
  let name = raw;
  const separator = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (separator >= 0) name = name.slice(separator + 1);
  name = name.toLowerCase();
  if (name.endsWith('.exe')) name = name.slice(0, -'.exe'.length);
  return name;
}
