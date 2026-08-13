import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

import type { AutocompleteItem } from '@moonshot-ai/pi-tui';
import { basename, dirname, join, relative, resolve } from 'pathe';

import { t } from '#/i18n';

import { completeLeadingArg, type ArgCompletionSpec } from './complete-args';
import type { KimiSlashCommand, SlashCommandAvailability } from './types';

/** Map hyphenated command names to i18n keys under `tui.slashCommands.<key>`. */
function slashI18nKey(name: string): string {
  return `tui.slashCommands.${name.replaceAll(/-([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}

/** Subcommands offered when autocompleting `/goal <…>`. */
function goalSubcommandSpecs(): readonly ArgCompletionSpec[] {
  return [
    { value: 'status', description: t('tui.messages.registryGoalShow') },
    { value: 'pause', description: t('tui.messages.registryGoalPause') },
    { value: 'resume', description: t('tui.messages.registryGoalResume') },
    { value: 'cancel', description: t('tui.messages.registryGoalCancel') },
    { value: 'replace', description: t('tui.messages.registryGoalReplace') },
    { value: 'next', description: t('tui.messages.registryGoalNext') },
  ];
}

function goalNextSubcommandSpecs(): readonly ArgCompletionSpec[] {
  return [{ value: 'manage', description: t('tui.messages.registryGoalManage') }];
}

function swarmSubcommandSpecs(): readonly ArgCompletionSpec[] {
  return [
    { value: 'on', description: t('tui.messages.registrySwarmOn') },
    { value: 'off', description: t('tui.messages.registrySwarmOff') },
  ];
}

function addDirSubcommandSpecs(): readonly ArgCompletionSpec[] {
  return [{ value: 'list', description: t('tui.messages.registryAddDirShow') }];
}

/** Argument autocompletion for the `/goal` command (subcommands). */
export function goalArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const nextMatch = argumentPrefix.match(/^next\s+(\S*)$/i);
  if (nextMatch !== null) {
    return (
      completeLeadingArg(goalNextSubcommandSpecs(), nextMatch[1] ?? '')?.map((item) => ({
        ...item,
        value: `next ${item.value}`,
      })) ?? null
    );
  }
  return completeLeadingArg(goalSubcommandSpecs(), argumentPrefix);
}

/** Argument autocompletion for the `/swarm` command (subcommands). */
export function swarmArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return completeLeadingArg(swarmSubcommandSpecs(), argumentPrefix);
}

/** Argument autocompletion for the `/add-dir` command. */
export function addDirArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  if (isPathLikeAddDirArgument(argumentPrefix)) {
    return completeAddDirPath(argumentPrefix);
  }
  return completeLeadingArg(addDirSubcommandSpecs(), argumentPrefix);
}

function isPathLikeAddDirArgument(argumentPrefix: string): boolean {
  return (
    argumentPrefix === '.' ||
    argumentPrefix === '..' ||
    argumentPrefix.startsWith('./') ||
    argumentPrefix.startsWith('../') ||
    argumentPrefix.startsWith('/') ||
    argumentPrefix.startsWith('~')
  );
}

function completeAddDirPath(argumentPrefix: string): AutocompleteItem[] | null {
  const normalizedPrefix = argumentPrefix === '~' ? '~/' : argumentPrefix;
  const expandedPrefix = expandHomePrefix(normalizedPrefix);
  const parentInput = getDirectoryCompletionParentInput(normalizedPrefix, expandedPrefix);
  const partialName = normalizedPrefix.endsWith('/') ? '' : basename(expandedPrefix);
  const parentDir = resolveDirectoryCompletionParent(parentInput);
  let entries;
  try {
    entries = readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const items: AutocompleteItem[] = [];
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..' || entry.name.startsWith('.')) continue;
    if (partialName.length > 0 && !entry.name.toLowerCase().startsWith(partialName.toLowerCase()))
      continue;
    const absolutePath = join(parentDir, entry.name);
    if (!isDirectoryPath(absolutePath, entry.isDirectory(), entry.isSymbolicLink())) continue;
    const value = formatDirectoryCompletionValue(normalizedPrefix, parentInput, entry.name);
    items.push({
      value,
      label: `${entry.name}/`,
      description: absolutePath,
    });
  }

  return items.length > 0 ? items : null;
}

function expandHomePrefix(argumentPrefix: string): string {
  if (argumentPrefix === '~') return homedir();
  if (argumentPrefix.startsWith('~/')) return join(homedir(), argumentPrefix.slice(2));
  return argumentPrefix;
}

function getDirectoryCompletionParentInput(argumentPrefix: string, expandedPrefix: string): string {
  if (argumentPrefix === '/') return '/';
  if (argumentPrefix === '~/') return homedir();
  if (argumentPrefix.endsWith('/')) return expandedPrefix.slice(0, -1);
  return dirname(expandedPrefix);
}

function resolveDirectoryCompletionParent(parentInput: string): string {
  if (parentInput === '~') return homedir();
  if (parentInput.startsWith('~/')) return join(homedir(), parentInput.slice(2));
  return resolve(parentInput);
}

function isDirectoryPath(path: string, isDirectory: boolean, isSymlink: boolean): boolean {
  if (isDirectory) return true;
  if (!isSymlink) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function formatDirectoryCompletionValue(
  argumentPrefix: string,
  parentInput: string,
  entryName: string,
): string {
  if (argumentPrefix.startsWith('~/')) {
    const home = homedir();
    const homeRelative = relative(home, parentInput);
    return `~${homeRelative.length > 0 ? `/${homeRelative}` : ''}/${entryName}/`;
  }
  if (argumentPrefix.startsWith('/')) {
    return `${join(parentInput, entryName)}/`;
  }
  return `${join(parentInput, entryName)}/`;
}

export const BUILTIN_SLASH_COMMANDS = [
  {
    name: 'yolo',
    aliases: ['yes'],
    description:
      'Toggle YOLO mode: auto-approve tool actions, but the agent may still ask questions.',
    priority: 101,
    availability: 'always',
  },
  {
    name: 'auto',
    aliases: [],
    description: 'Toggle Auto mode: fully autonomous, agent decides everything without asking.',
    priority: 99,
    availability: 'always',
  },
  {
    name: 'permission',
    aliases: [],
    description: t('tui.slashCommands.permission'),
    priority: 100,
    availability: 'always',
  },
  {
    name: 'settings',
    aliases: ['config'],
    description: t('tui.slashCommands.settings'),
    priority: 100,
    availability: 'always',
  },
  {
    name: 'plan',
    aliases: [],
    description: t('tui.slashCommands.plan'),
    priority: 100,
    availability: (args) => (args.trim().toLowerCase() === 'clear' ? 'idle-only' : 'always'),
  },
  {
    name: 'swarm',
    aliases: [],
    description: t('tui.slashCommands.swarm'),
    priority: 100,
    argumentHint: '[on|off] | <task>',
    completeArgs: swarmArgumentCompletions,
    availability: 'idle-only',
  },
  {
    name: 'discuss',
    aliases: [],
    description: 'Run a multi-agent discussion on a topic and converge on a consensus',
    priority: 95,
    argumentHint: '<topic>',
    availability: 'idle-only',
  },
  {
    name: 'model',
    aliases: [],
    description: t('tui.slashCommands.model'),
    priority: 100,
    availability: 'always',
  },
  {
    name: 'secondary-model',
    aliases: ['subagent-model'],
    description: 'Configure the secondary model for subagents',
    priority: 90,
    availability: 'always',
    experimentalFlag: 'secondary-model',
  },
  {
    name: 'effort',
    aliases: ['thinking'],
    description: t('tui.slashCommands.effort'),
    priority: 95,
    availability: 'always',
  },
  {
    name: 'provider',
    aliases: ['providers'],
    description: t('tui.slashCommands.provider'),
    priority: 95,
    availability: 'always',
  },
  {
    name: 'multi-llm',
    aliases: ['multillm'],
    description: 'Configure MultiLLM concurrent providers (Rust engine)',
    priority: 90,
    availability: 'always',
  },
  {
    name: 'btw',
    aliases: [],
    description: t('tui.slashCommands.btw'),
    priority: 90,
    availability: 'always',
  },
  {
    name: 'help',
    aliases: ['h', '?'],
    description: t('tui.slashCommands.help'),
    priority: 80,
    availability: 'always',
  },
  {
    name: 'new',
    aliases: ['clear'],
    description: t('tui.slashCommands.new'),
    priority: 80,
  },
  {
    name: 'sessions',
    aliases: ['resume'],
    description: t('tui.slashCommands.sessions'),
    priority: 80,
  },
  {
    name: 'tasks',
    aliases: ['task'],
    description: t('tui.slashCommands.tasks'),
    priority: 80,
    availability: 'always',
  },
  {
    name: 'mcp',
    aliases: [],
    description: t('tui.slashCommands.mcp'),
    priority: 60,
    availability: 'always',
  },
  {
    name: 'plugins',
    aliases: [],
    description: t('tui.slashCommands.plugins'),
    priority: 60,
    availability: 'always',
  },
  {
    name: 'add-dir',
    aliases: [],
    description: t('tui.slashCommands.addDir'),
    priority: 60,
    availability: 'idle-only',
    argumentHint: '[list] | <path>',
    completeArgs: addDirArgumentCompletions,
  },
  {
    name: 'experiments',
    aliases: ['experimental'],
    description: t('tui.slashCommands.experiments'),
    priority: 60,
    availability: 'idle-only',
  },
  {
    name: 'reload',
    aliases: [],
    description: t('tui.slashCommands.reload'),
    priority: 60,
    availability: 'idle-only',
  },
  {
    name: 'reload-tui',
    aliases: [],
    description: t('tui.slashCommands.reloadTui'),
    priority: 60,
    availability: 'always',
  },
  {
    name: 'compact',
    aliases: [],
    description: t('tui.slashCommands.compact'),
    priority: 80,
    argumentHint: '<instruction>',
  },
  {
    name: 'goal',
    aliases: [],
    description: t('tui.slashCommands.goal'),
    priority: 80,
    argumentHint: '[status|pause|resume|cancel|replace|next] | <objective>',
    completeArgs: goalArgumentCompletions,
    // status / pause / cancel are always available; creation, replacement, and
    // resume start (or restart) a turn and so are idle-only.
    availability: (args) => {
      const trimmed = args.trim();
      if (trimmed === 'next' || trimmed.startsWith('next ')) return 'always';
      return trimmed === '' || trimmed === 'status' || trimmed === 'pause' || trimmed === 'cancel'
        ? 'always'
        : 'idle-only';
    },
  },
  {
    name: 'init',
    aliases: [],
    description: t('tui.slashCommands.init'),
  },
  {
    name: 'fork',
    aliases: [],
    description: 'Fork the current session into a copy without switching to it',
    priority: 80,
  },
  {
    name: 'title',
    aliases: ['rename'],
    description: t('tui.slashCommands.title'),
    priority: 60,
    argumentHint: '<title>',
    availability: 'always',
  },
  {
    name: 'usage',
    aliases: [],
    description: t('tui.slashCommands.usage'),
    priority: 60,
    availability: 'always',
  },
  {
    name: 'status',
    aliases: [],
    description: t('tui.slashCommands.status'),
    priority: 60,
    availability: 'always',
  },
  {
    name: 'feedback',
    aliases: ['bug'],
    description: t('tui.slashCommands.feedback'),
    priority: 60,
    availability: 'always',
  },
  {
    name: 'workflow',
    aliases: [],
    description: t('tui.slashCommands.workflow'),
    priority: 80,
    argumentHint: '<name> [args...] | list | status <runId> | cancel <runId>',
    availability: 'always',
  },
  {
    name: 'undo',
    aliases: [],
    description: t('tui.slashCommands.undo'),
    priority: 80,
    availability: 'idle-only',
  },
  {
    name: 'editor',
    aliases: [],
    description: t('tui.slashCommands.editor'),
    priority: 60,
    availability: 'always',
  },
  {
    name: 'theme',
    aliases: [],
    description: t('tui.slashCommands.theme'),
    priority: 60,
    availability: 'always',
  },
  {
    name: 'logout',
    aliases: ['disconnect'],
    description: t('tui.slashCommands.logout'),
    priority: 40,
  },
  {
    name: 'login',
    aliases: [],
    description: t('tui.slashCommands.login'),
    priority: 40,
  },
  {
    name: 'export-md',
    aliases: ['export'],
    description: t('tui.slashCommands.exportMd'),
    priority: 40,
  },
  {
    name: 'export-debug-zip',
    aliases: [],
    description: t('tui.slashCommands.exportDebugZip'),
    priority: 40,
  },
  {
    name: 'copy',
    aliases: [],
    description: t('tui.slashCommands.copy'),
    priority: 40,
  },
  {
    name: 'web',
    aliases: [],
    description: 'Open the current session in the Web UI by starting a new server',
    priority: 40,
    availability: 'always',
  },
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: t('tui.slashCommands.exit'),
    priority: 20,
  },
  {
    name: 'version',
    aliases: [],
    description: t('tui.slashCommands.version'),
    priority: 20,
    availability: 'always',
  },
] as const satisfies readonly KimiSlashCommand[];

export type BuiltinSlashCommand = (typeof BUILTIN_SLASH_COMMANDS)[number];
export type BuiltinSlashCommandName = BuiltinSlashCommand['name'];

export function findBuiltInSlashCommand(commandName: string): BuiltinSlashCommand | undefined {
  const commands = BUILTIN_SLASH_COMMANDS as readonly KimiSlashCommand<BuiltinSlashCommandName>[];
  return commands.find(
    (command) => command.name === commandName || command.aliases.includes(commandName),
  ) as BuiltinSlashCommand | undefined;
}

export function resolveSlashCommandAvailability(
  command: KimiSlashCommand,
  args: string,
): SlashCommandAvailability {
  const availability = command.availability ?? 'idle-only';
  return typeof availability === 'function' ? availability(args) : availability;
}

export function sortSlashCommands(commands: readonly KimiSlashCommand[]): KimiSlashCommand[] {
  return [...commands].toSorted(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name),
  );
}

export function getBuiltinSlashCommands(): readonly KimiSlashCommand[] {
  return BUILTIN_SLASH_COMMANDS.map((cmd) => ({
    ...cmd,
    // `t()` accepts any string key and falls back to the key's English message;
    // `cmd.description` (resolved through `t()` at module load) is the
    // last-resort fallback for a missing locale entry.
    description: t(slashI18nKey(cmd.name)) || cmd.description,
  }));
}
