import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ProjectAdditionalDirsLoadResult {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly additionalDirs: readonly string[];
}

export interface IProjectLocalConfigService {
  readonly _serviceBrand: undefined;

  readAdditionalDirs(workDir: string): Promise<ProjectAdditionalDirsLoadResult>;
  /**
   * Resolve configured additional dirs against `baseDir`. `source` selects the
   * policy: `'session'` (a create/resume payload) is validated against the
   * machine-scale directories a session must not be handed; `'config'`
   * (project `local.toml`) keeps the permissive legacy behaviour.
   */
  resolveAdditionalDirs(
    baseDir: string,
    additionalDirs: readonly string[],
    source?: 'session' | 'config',
  ): Promise<string[]>;
  appendAdditionalDir(workDir: string, inputPath: string): Promise<ProjectAdditionalDirsLoadResult>;
}

export const IProjectLocalConfigService: ServiceIdentifier<IProjectLocalConfigService> =
  createDecorator<IProjectLocalConfigService>('projectLocalConfigService');
