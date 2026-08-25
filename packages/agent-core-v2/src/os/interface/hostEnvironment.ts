import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type {
  HostEnvironmentInfo,
  JsRuntimeInfo,
  OsKind,
  PathClass,
  ShellName,
} from '#/_base/execEnv/environmentProbe';

export type { HostEnvironmentInfo, JsRuntimeInfo, OsKind, PathClass, ShellName };

export interface IHostEnvironment {
  readonly _serviceBrand: undefined;

  readonly osKind: OsKind;
  readonly osArch: string;
  readonly osVersion: string;
  readonly shellName: ShellName;
  readonly shellPath: string;
  readonly pathClass: PathClass;
  readonly homeDir: string;
  readonly jsRuntimes?: ReadonlyArray<JsRuntimeInfo>;
  readonly ready: Promise<void>;
}

export const IHostEnvironment: ServiceIdentifier<IHostEnvironment> =
  createDecorator<IHostEnvironment>('hostEnvironment');
