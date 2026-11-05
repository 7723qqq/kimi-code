import { CODE_SHIM_SUBCOMMAND } from '@moonshot-ai/agent-core-v2/features/codeRuntime/codeShimSource';
import { KIMI_NODE_FALLBACK_SUBCOMMAND } from '@moonshot-ai/kimi-code-sdk/runtime';
import { Command, InvalidArgumentError, Option } from 'commander';

import { CLI_COMMAND_NAME } from '#/constant/app';
import { t } from '#/i18n';
import { registerMigrateCommand, type MigrateCommandOptions } from '#/migration/command';
import { registerImportSessionsCommand } from '#/session-import/command';

import type { CLIOptions } from './options';
import { registerAcpCommand } from './sub/acp';
import { registerAppCommand } from './sub/app';
import { registerDoctorCommand } from './sub/doctor';
import { EXEC_SERVER_COMMAND } from './exec-server';
import { registerExportCommand } from './sub/export';
import { registerForkCommand } from './sub/fork';
import { registerInstallDesktopCommand } from './sub/install-desktop';
import { registerLoginCommand } from './sub/login';
import { registerProviderCommand } from './sub/provider';
import { registerSessionCommand } from './sub/session';
import { registerShellsCommand } from './sub/shells';
import { registerVisCommand } from './sub/vis';
import { registerWebCommand } from './sub/web';

export type MainCommandHandler = (opts: CLIOptions) => void;
export type MigrateCommandHandler = (options: MigrateCommandOptions) => void;
export type PluginNodeRunnerHandler = (entry: string, args: readonly string[]) => void;
export type UpgradeCommandHandler = (yes: boolean) => void | Promise<void>;
export type UpdateDownloadHandler = (version: string, manual: boolean) => void;
export type CodeShimHandler = () => void;
export type ExecServerCommandHandler = (listen: string) => void;

export function createProgram(
  version: string,
  onMain: MainCommandHandler,
  onMigrate: MigrateCommandHandler,
  onPluginNodeRunner: PluginNodeRunnerHandler = () => {},
  onUpgrade: UpgradeCommandHandler = () => {},
  onUpdateDownload: UpdateDownloadHandler = () => {},
  onCodeShim: CodeShimHandler = () => {},
  onExecServer: ExecServerCommandHandler = () => {},
): Command {
  const program = new Command(CLI_COMMAND_NAME)
    .description(t('cli.program.description'))
    .version(version, '-V, --version')
    .allowUnknownOption(false)
    .enablePositionalOptions()
    .configureHelp({ helpWidth: 100 })
    .helpOption('-h, --help', t('cli.program.helpOption'))
    .usage(t('cli.program.usage'))
    .addHelpText(
      'after',
      `\n${t('cli.program.documentation')}        https://moonshotai.github.io/kimi-code/\n`,
    );

  program
    .addOption(
      new Option('-S, --session [id]', t('cli.optionDescriptions.session')).argParser(
        (val: string | boolean) => (val === true ? '' : (val as string)),
      ),
    )
    .addOption(
      new Option('-r, --resume [id]')
        .hideHelp()
        .argParser((val: string | boolean) => (val === true ? '' : (val as string))),
    )
    .option('-c, --continue', t('cli.optionDescriptions.continue'), false)
    .addOption(new Option('-C').hideHelp().default(false))
    .option('-y, --yolo', t('cli.optionDescriptions.yolo'), false)
    .option('--auto', t('cli.optionDescriptions.auto'), false)
    .addOption(new Option('-m, --model <model>', t('cli.optionDescriptions.model')))
    .addOption(new Option('-p, --prompt <prompt>', t('cli.optionDescriptions.prompt')))
    .addOption(
      new Option('--output-format <format>', t('cli.optionDescriptions.outputFormat')).choices([
        'text',
        'stream-json',
      ]),
    )
    .addOption(
      new Option('--skills-dir <dir>', t('cli.optionDescriptions.skillsDir'))
        .argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value])
        .default([]),
    )
    .addOption(
      new Option('--agent <name>', t('cli.optionDescriptions.agent'))
        .argParser((value: string, previous: string | undefined) => {
          if (previous !== undefined) {
            throw new InvalidArgumentError(t('cli.errors.agentOnlyOnce'));
          }
          return value;
        })
        .conflicts('agentFile'),
    )
    .addOption(
      new Option('--agent-file <path>', t('cli.optionDescriptions.agentFile'))
        .argParser((value: string, previous: string[] | undefined) => {
          if ((previous?.length ?? 0) > 0) {
            throw new InvalidArgumentError(t('cli.errors.agentFileOnlyOnce'));
          }
          return [value];
        })
        .conflicts('agent')
        .default([]),
    )
    .addOption(
      new Option('--add-dir <dir>', t('cli.optionDescriptions.addDir'))
        .argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value])
        .default([]),
    )
    .addOption(new Option('--yes').hideHelp().default(false))
    .addOption(new Option('--auto-approve').hideHelp().default(false))
    .addOption(
      new Option('--environment <id>', 'Bind the new session to the configured environment <id>.').hideHelp(),
    )
    .addOption(
      new Option(
        '--environment-cwd <path>',
        'Set the working directory on the environment selected by --environment.',
      ).hideHelp(),
    )
    .option('--plan', t('cli.optionDescriptions.plan'), false);

  registerExportCommand(program);
  registerForkCommand(program);
  registerProviderCommand(program);
  registerSessionCommand(program);
  registerShellsCommand(program);
  registerAcpCommand(program);
  registerWebCommand(program);
  registerLoginCommand(program);
  registerDoctorCommand(program);
  registerVisCommand(program);
  registerInstallDesktopCommand(program);
  registerAppCommand(program);
  registerMigrateCommand(program, onMigrate);
  registerImportSessionsCommand(program);
  program
    .command('upgrade')
    .alias('update')
    .description(t('cli.commandDescriptions.upgrade'))
    .option('-y, --yes', t('cli.optionDescriptions.upgradeYes'), false)
    .action(async (options: { yes?: boolean }) => {
      await onUpgrade(options.yes === true);
    });

  // Self-spawned worker for native staged updates (detached background
  // download, or foreground from `kimi upgrade` — `--manual` marks the
  // latter's stage as user-requested). Hidden: not user-facing.
  program
    .command('__update_download', { hidden: true })
    .argument('<version>')
    .option('--manual', 'the stage answers an explicit user-initiated upgrade')
    .action((targetVersion: string, options: { manual?: boolean }) => {
      onUpdateDownload(targetVersion, options.manual === true);
    });

  program
    .command(KIMI_NODE_FALLBACK_SUBCOMMAND, { hidden: true })
    .argument('<entry>')
    .argument('[args...]')
    .allowUnknownOption(true)
    .action((entry: string, args: string[]) => {
      onPluginNodeRunner(entry, args);
    });

  program
    .command(CODE_SHIM_SUBCOMMAND, { hidden: true })
    .allowUnknownOption(true)
    .action(() => {
      onCodeShim();
    });

  program
    .command(EXEC_SERVER_COMMAND, { hidden: true })
    .option('--listen <transport>', 'Transport to listen on. Only "stdio" is supported.', 'stdio')
    .allowExcessArguments(false)
    .action((options: { listen: string }) => {
      onExecServer(options.listen);
    });

  program.argument('[args...]').action((args: string[]) => {
    if (args.length > 0) {
      program.error(
        t('cli.errors.unknownCommand', { command: args[0] ?? '', cliName: CLI_COMMAND_NAME }),
      );
    }

    const raw = program.opts<Record<string, unknown>>();

    const rawSession = raw['session'] ?? raw['resume'];
    const sessionValue = rawSession === true ? '' : (rawSession as string | undefined);
    const yoloValue = raw['yolo'] === true || raw['yes'] === true || raw['autoApprove'] === true;
    const autoValue = raw['auto'] === true;

    const opts: CLIOptions = {
      session: sessionValue,
      continue: raw['continue'] === true || raw['C'] === true,
      yolo: yoloValue,
      auto: autoValue,
      plan: raw['plan'] as boolean,
      model: raw['model'] as string | undefined,
      outputFormat: raw['outputFormat'] as CLIOptions['outputFormat'],
      prompt: raw['prompt'] as string | undefined,
      skillsDirs: raw['skillsDir'] as string[],
      agent: raw['agent'] as string | undefined,
      agentFiles: raw['agentFile'] as string[],
      addDirs: raw['addDir'] as string[],
      environment: raw['environment'] as string | undefined,
      environmentCwd: raw['environmentCwd'] as string | undefined,
    };

    onMain(opts);
  });

  return program;
}
