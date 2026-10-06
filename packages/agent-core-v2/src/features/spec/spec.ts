import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const SPEC_DIR_NAME = 'specs';

export const SPEC_REQUIREMENTS_FILE = 'requirements.md';
export const SPEC_DESIGN_FILE = 'design.md';
export const SPEC_TASKS_FILE = 'tasks.md';
export const SPEC_PROGRESS_FILE = 'progress.md';

export const SPEC_REQUIRED_FILES = [
  SPEC_REQUIREMENTS_FILE,
  SPEC_DESIGN_FILE,
  SPEC_TASKS_FILE,
] as const;

export const SPEC_ALL_FILES = [...SPEC_REQUIRED_FILES, SPEC_PROGRESS_FILE] as const;

export type SpecRequiredFile = (typeof SPEC_REQUIRED_FILES)[number];

export type SpecStage = 'specify' | 'plan' | 'tasks' | 'implement';

export interface SpecData {
  readonly id: string;
  readonly dir: string;
  readonly files: Readonly<Record<string, string>>;
  /** Contents of `progress.md`, or `''` when it has not been written yet. */
  readonly progress: string;
  readonly missing: readonly SpecRequiredFile[];
  readonly complete: boolean;
  readonly stage: SpecStage;
}

export interface IAgentSpecService {
  readonly _serviceBrand: undefined;

  enter(id?: string): Promise<void>;
  cancel(id?: string): void;
  exit(id?: string): void;
  clear(): Promise<void>;
  recordRevision(data?: SpecData): Promise<void>;
  status(): Promise<SpecData | null>;
  activeSpecDir(): string | null;
}

export const IAgentSpecService: ServiceIdentifier<IAgentSpecService> =
  createDecorator<IAgentSpecService>('agentSpecService');
