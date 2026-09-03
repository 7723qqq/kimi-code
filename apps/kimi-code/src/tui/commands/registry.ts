import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

import type { AutocompleteItem } from '@moonshot-ai/pi-tui';
import { basename, dirname, join, relative, resolve } from 'pathe';

import { t } from '#/i18n';

import { completeLeadingArg, type ArgCompletionSpec } from './complete-args';
import type { KimiSlashCommand, SlashCommandAvailability } from './types';

/**
 * Subcommands offered when autocompleting `/goal <…>`.
 *
 * These are lazy getters, not module-level constants: the i18n singleton picks
 * an env-detected locale at import time and the real one from `tui.toml` lands
 * later via `setLocale()`, so a translation evaluated at module load would stay
 * English forever. `test/i18n/module-level-guard.test.ts` enforces this.
 */
function goalArgCompletions(): readonly ArgCompletionSpec[] {
  return [
    { value: 'status', description: t('tui.messages.registryGoalShow') },
    { value: 'pause', description: t('tui.messages.registryGoalPause') },
    { value: 'resume', description: t('tui.messages.registryGoalResume') },
    { value: 'cancel', description: t('tui.messages.registryGoalCancel') },
    { value: 'replace', description: t('tui.messages.registryGoalReplace') },
    { value: 'next', description: t('tui.messages.registryGoalNext') },
  ];
}

function goalNextArgCompletions(): readonly ArgCompletionSpec[] {
  return [{ value: 'manage', description: t('tui.messages.registryGoalManage') }];
}

function swarmArgCompletions(): readonly ArgCompletionSpec[] {
  return [
    { value: 'on', description: t('tui.messages.registrySwarmOn') },
    { value: 'off', description: t('tui.messages.registrySwarmOff') },
  ];
}

function towerArgCompletions(): readonly ArgCompletionSpec[] {
  return [
    { value: 'status', description: t('tui.messages.registryTowerStatus') },
    { value: 'teardown', description: t('tui.messages.registryTowerTeardown') },
    { value: 'on', description: t('tui.messages.registryTowerOn') },
    { value: 'off', description: t('tui.messages.registryTowerOff') },
  ];
}

function addDirArgCompletions(): readonly ArgCompletionSpec[] {
  return [{ value: 'list', description: t('tui.messages.registryAddDirShow') }];
}

/** Argument autocompletion for the `/goal` command (subcommands). */
export function goalArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const nextMatch = argumentPrefix.match(/^next\s+(\S*)$/i);
  if (nextMatch !== null) {
    return (
      completeLeadingArg(goalNextArgCompletions(), nextMatch[1] ?? '')?.map((item) => ({
        ...item,
        value: `next ${item.value}`,
      })) ?? null
    );
  }
  return completeLeadingArg(goalArgCompletions(), argumentPrefix);
}

/** Argument autocompletion for the `/swarm` command (subcommands). */
export function swarmArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return completeLeadingArg(swarmArgCompletions(), argumentPrefix);
}

/** Argument autocompletion for the `/tower` command (subcommands). */
export function towerArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return completeLeadingArg(towerArgCompletions(), argumentPrefix);
}

/** Argument autocompletion for the `/add-dir` command. */
export function addDirArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  if (isPathLikeAddDirArgument(argumentPrefix)) {
    return completeAddDirPath(argumentPrefix);
  }
  return completeLeadingArg(addDirArgCompletions(), argumentPrefix);
}

function isPathLikeAddDirArgument(argumentPrefix: string): boolean {
  return (
    argumentPrefix === '.' ||
    argumentPrefix === '..' ||
    argumentPrefix.startsWith('./') ||
    argumentPrefix.startsWith('../') ||
    argumentPrefix.startsWith('/') ||
    argumentPrefix.startsWith('~') ||
    // Windows drive-letter paths: `C:/dir`, `C:\dir`.
    /^[a-zA-Z]:[/\\]/.test(argumentPrefix)
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
  return `${join(parentInput, entryName).replaceAll('\\', '/')}/`;
}

export const BUILTIN_SLASH_COMMANDS = [
  {
    name: 'ask-when-needed',
    aliases: ['yolo', 'yes'],
    get description() {
      return t('tui.slashCommands.yolo');
    },
    priority: 101,
    availability: 'always',
  },
  {
    name: 'never-ask',
    aliases: ['auto'],
    get description() {
      return t('tui.slashCommands.auto');
    },
    priority: 99,
    availability: 'always',
  },
  {
    name: 'permission',
    aliases: [],
    get description() {
      return t('tui.slashCommands.permission');
    },
    priority: 100,
    availability: 'always',
  },
  {
    name: 'settings',
    aliases: ['config'],
    get description() {
      return t('tui.slashCommands.settings');
    },
    priority: 100,
    availability: 'always',
  },
  {
    name: 'plan',
    aliases: [],
    get description() {
      return t('tui.slashCommands.plan');
    },
    priority: 100,
    availability: (args) => (args.trim().toLowerCase() === 'clear' ? 'idle-only' : 'always'),
  },
  {
    name: 'swarm',
    aliases: [],
    get description() {
      return t('tui.slashCommands.swarm');
    },
    priority: 100,
    argumentHint: '[on|off] | <task>',
    completeArgs: swarmArgumentCompletions,
    availability: 'idle-only',
  },
  {
    name: 'team',
    aliases: [],
    get description() {
      return t('tui.slashCommands.team');
    },
    priority: 95,
    argumentHint: '<topic>',
    availability: 'idle-only',
  },
  {
    name: 'workflow',
    aliases: [],
    get description() {
      return t('tui.slashCommands.workflow');
    },
    priority: 80,
    argumentHint: '<name> [args...] | list | status <runId> | cancel <runId>',
    availability: 'always',
  },
  {
    name: 'tower',
    aliases: [],
    get description() {
      return t('tui.slashCommands.tower');
    },
    priority: 100,
    argumentHint: '[status|teardown|on|off] | <base-branch>',
    completeArgs: towerArgumentCompletions,
    // Every form stays available while busy: base selections apply to the next
    // TowerInit of the running coordinator turn, so /tower commands never wait
    // for the previous one to finish.
    availability: 'always',
    experimentalFlag: 'tower',
  },
  {
    name: 'model',
    aliases: [],
    get description() {
      return t('tui.slashCommands.model');
    },
    priority: 100,
    availability: 'always',
  },
  {
    name: 'secondary-model',
    aliases: ['subagent-model'],
    get description() {
      return t('tui.slashCommands.secondaryModel');
    },
    priority: 90,
    availability: 'always',
    experimentalFlag: 'secondary-model',
  },
  {
    name: 'effort',
    aliases: ['thinking'],
    get description() {
      return t('tui.slashCommands.effort');
    },
    priority: 95,
    availability: 'always',
  },
  {
    name: 'provider',
    aliases: ['providers'],
    get description() {
      return t('tui.slashCommands.provider');
    },
    priority: 95,
    availability: 'always',
  },
  {
    name: 'btw',
    aliases: [],
    get description() {
      return t('tui.slashCommands.btw');
    },
    priority: 90,
    availability: 'always',
  },
  {
    name: 'help',
    aliases: ['h', '?'],
    get description() {
      return t('tui.slashCommands.help');
    },
    priority: 80,
    availability: 'always',
  },
  {
    name: 'new',
    aliases: ['clear'],
    get description() {
      return t('tui.slashCommands.new');
    },
    priority: 80,
  },
  {
    name: 'sessions',
    aliases: ['resume'],
    get description() {
      return t('tui.slashCommands.sessions');
    },
    priority: 80,
  },
  {
    name: 'tasks',
    aliases: ['task'],
    get description() {
      return t('tui.slashCommands.tasks');
    },
    priority: 80,
    availability: 'always',
  },
  {
    name: 'mcp',
    aliases: [],
    get description() {
      return t('tui.slashCommands.mcp');
    },
    priority: 60,
    availability: 'always',
  },
  {
    name: 'plugins',
    aliases: [],
    get description() {
      return t('tui.slashCommands.plugins');
    },
    priority: 60,
    availability: 'always',
  },
  {
    name: 'add-dir',
    aliases: [],
    get description() {
      return t('tui.slashCommands.addDir');
    },
    priority: 60,
    availability: 'idle-only',
    argumentHint: '[list] | <path>',
    completeArgs: addDirArgumentCompletions,
  },
  {
    name: 'experiments',
    aliases: ['experimental'],
    get description() {
      return t('tui.slashCommands.experiments');
    },
    priority: 60,
    availability: 'idle-only',
  },
  {
    name: 'reload',
    aliases: [],
    get description() {
      return t('tui.slashCommands.reload');
    },
    priority: 60,
    availability: 'idle-only',
  },
  {
    name: 'reload-tui',
    aliases: [],
    get description() {
      return t('tui.slashCommands.reloadTui');
    },
    priority: 60,
    availability: 'always',
  },
  {
    name: 'compact',
    aliases: [],
    get description() {
      return t('tui.slashCommands.compact');
    },
    priority: 80,
    argumentHint: '<instruction>',
  },
  {
    name: 'goal',
    aliases: [],
    get description() {
      return t('tui.slashCommands.goal');
    },
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
    get description() {
      return t('tui.slashCommands.init');
    },
  },
  {
    name: 'fork',
    aliases: [],
    get description() {
      return t('tui.slashCommands.fork');
    },
    priority: 80,
  },
  {
    name: 'title',
    aliases: ['rename'],
    get description() {
      return t('tui.slashCommands.title');
    },
    priority: 60,
    argumentHint: '<title>',
    availability: 'always',
  },
  {
    name: 'usage',
    aliases: [],
    get description() {
      return t('tui.slashCommands.usage');
    },
    priority: 60,
    availability: 'always',
  },
  {
    name: 'status',
    aliases: [],
    get description() {
      return t('tui.slashCommands.status');
    },
    priority: 60,
    availability: 'always',
  },
  {
    name: 'feedback',
    aliases: ['bug'],
    get description() {
      return t('tui.slashCommands.feedback');
    },
    priority: 60,
    availability: 'always',
  },
  {
    name: 'undo',
    aliases: [],
    get description() {
      return t('tui.slashCommands.undo');
    },
    priority: 80,
    availability: 'idle-only',
  },
  {
    name: 'editor',
    aliases: [],
    get description() {
      return t('tui.slashCommands.editor');
    },
    priority: 60,
    availability: 'always',
  },
  {
    name: 'theme',
    aliases: [],
    get description() {
      return t('tui.slashCommands.theme');
    },
    priority: 60,
    availability: 'always',
  },
  {
    name: 'logout',
    aliases: ['disconnect'],
    get description() {
      return t('tui.slashCommands.logout');
    },
    priority: 40,
  },
  {
    name: 'login',
    aliases: [],
    get description() {
      return t('tui.slashCommands.login');
    },
    priority: 40,
  },
  {
    name: 'export-md',
    aliases: ['export'],
    get description() {
      return t('tui.slashCommands.exportMd');
    },
    priority: 40,
  },
  {
    name: 'export-debug-zip',
    aliases: [],
    get description() {
      return t('tui.slashCommands.exportDebugZip');
    },
    priority: 40,
  },
  {
    name: 'copy',
    aliases: [],
    get description() {
      return t('tui.slashCommands.copy');
    },
    priority: 40,
  },
  {
    name: 'web',
    aliases: [],
    get description() {
      return t('tui.slashCommands.web');
    },
    priority: 40,
    availability: 'always',
  },
  {
    name: 'remote-control',
    aliases: ['rc'],
    get description() {
      return t('tui.slashCommands.remoteControl');
    },
    priority: 40,
    availability: 'always',
    experimentalFlag: 'remote-control',
  },
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    get description() {
      return t('tui.slashCommands.exit');
    },
    priority: 20,
  },
  {
    name: 'version',
    aliases: [],
    get description() {
      return t('tui.slashCommands.version');
    },
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
