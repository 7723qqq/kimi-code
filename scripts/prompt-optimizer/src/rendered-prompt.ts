/**
 * Prompt Optimizer — Production-rendered prompt profile.
 *
 * The benchmark used to measure `system.md`'s raw template, which is not what a
 * session receives: the template still carries `${...}` placeholders. This
 * module asks agent-core's pure rendering boundary for the actual text instead.
 *
 * Every model family renders the same `system.md`, so there is one production
 * shape. Family-specific guidance arrives inside it through the
 * `${model_adaptation_section}` block rather than through a separate reminder.
 *
 * Nothing here starts the DI runtime or reads a user home file. The one
 * exception is explicit and fail-closed: `actualGlobalPath` must be exactly the
 * single authorized path, and its content is used in memory only.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { PromptValueDelivery } from '../../../packages/agent-core-v2/src/app/agentProfileCatalog/agentProfileCatalog';
import {
  CORE_BEHAVIOR_CONTRACT_IDS,
  type ContractDelivery,
  type CoreBehaviorContractId,
} from '../../../packages/agent-core-v2/src/app/agentProfileCatalog/behaviorContract';
import {
  DEEPSEEK_ADAPTATION_SOURCE_ID,
  loadCuratedAdaptation,
} from '../../../packages/agent-core-v2/src/app/agentProfileCatalog/modelAdaptations';
import { renderSystemPromptResult } from '../../../packages/agent-core-v2/src/app/agentProfileCatalog/profile-shared';
import { estimateTokens } from './prompt-parser';

// ─── Profiles ───────────────────────────────────────────────────────────────

/**
 * What the benchmark renders.
 *
 * There is one production shape: `system.md`, with the family's curated
 * adaptation embedded by the `${model_adaptation_section}` placeholder.
 */
export type PromptProfile = 'full';

export const PROMPT_PROFILES: readonly PromptProfile[] = ['full'];

export const DEFAULT_PROMPT_PROFILE: PromptProfile = 'full';

export function isPromptProfile(value: string): value is PromptProfile {
  return (PROMPT_PROFILES as readonly string[]).includes(value);
}

/**
 * The one global instruction file the optimizer may read, and only on an
 * explicit opt-in. Every other path is refused, so a typo cannot send the
 * user's home directory contents to a provider.
 */
export const AUTHORIZED_ACTUAL_GLOBAL_PATH = 'C:/Users/Administrator/.kimi-code/AGENTS.md';

// ─── Fixture ────────────────────────────────────────────────────────────────

/**
 * Explicit render context.
 *
 * `cwd` is required because a render without it is not a prompt a session could
 * ever receive; everything else is optional and simply absent when omitted.
 */
export interface RenderFixture {
  readonly cwd: string;
  readonly agentsMd?: string;
  readonly skills?: string;
  readonly pluginSections?: string;
  readonly additionalDirsInfo?: string;
  readonly osKind?: string;
  readonly shellName?: string;
  readonly shellPath?: string;
  readonly productName?: string;
  readonly notifyUserActive?: boolean;
  readonly todoListActive?: boolean;
  readonly skillActive?: boolean;
}

/**
 * Where the rendered `AGENTS.md` block came from, without any of its content.
 * `actual` means the authorized global file was read; it is recorded so a report
 * can say the run used real global instructions without carrying them.
 */
export type AgentsMdSource = 'fixture' | 'actual' | 'none';

/** Presence, size and count only — never prompt text. */
export interface FixtureSummary {
  readonly agentsMd: AgentsMdSource;
  readonly agentsMdChars: number;
  readonly skillsChars: number;
  readonly plugins: boolean;
  readonly pluginChars: number;
  readonly additionalDirsChars: number;
  readonly osKind: string | null;
  readonly shellName: string | null;
  readonly productName: string | null;
  readonly notifyUserActive: boolean;
  readonly todoListActive: boolean;
  readonly skillActive: boolean;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export type RenderedPromptErrorCode =
  | 'unknown_profile'
  | 'profile_model_mismatch'
  | 'fixture_incomplete'
  | 'actual_global_path_rejected'
  | 'actual_global_unreadable';

/**
 * A named failure, because every one of these is a mistake the caller can fix:
 * the wrong profile for the model, an incomplete fixture, or a path that was
 * never authorized. None of them may fall back to a template silently.
 */
export class RenderedPromptError extends Error {
  readonly code: RenderedPromptErrorCode;

  constructor(code: RenderedPromptErrorCode, message: string) {
    super(message);
    this.name = 'RenderedPromptError';
    this.code = code;
  }
}

// ─── Result ─────────────────────────────────────────────────────────────────

export interface RenderedPromptWarning {
  readonly code: string;
  readonly name: string;
  readonly message: string;
}

export interface ContractCoverageCount {
  readonly system: number;
  readonly reminder: number;
  readonly omitted: number;
}

export type ContractCoverage = Record<CoreBehaviorContractId, ContractCoverageCount>;

export interface RenderedPrompt {
  readonly profile: PromptProfile;
  readonly model: string;
  readonly system: string;
  readonly reminderSourceId?: string;
  readonly contractDelivery: readonly ContractDelivery[];
  readonly valueDelivery: readonly PromptValueDelivery[];
  readonly warnings: readonly RenderedPromptWarning[];
  /** Truncated sha256 over profile, model, system and the embedded adaptation. */
  readonly sourceHash: string;
  readonly tokens: { readonly system: number; readonly reminder: number };
  readonly fixtureSummary: FixtureSummary;
}

export interface RenderProfileInput {
  readonly profile: PromptProfile;
  readonly model: string;
  readonly fixture: RenderFixture;
  /** Opt-in read of the single authorized global instruction file. */
  readonly actualGlobalPath?: string;
  /**
   * Overrides the reader for the authorized path. Tests inject one so a run
   * never touches a real home directory; production leaves it undefined.
   */
  readonly readActualGlobal?: (path: string) => Promise<string>;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function assertProfileMatchesModel(profile: PromptProfile, _model: string): void {
  if (profile !== 'full') {
    throw new RenderedPromptError(
      'profile_model_mismatch',
      `Unknown profile "${String(profile)}". Every model family renders the same prompt.`,
    );
  }
}

/**
 * Normalise a path for comparison only.
 *
 * The authorization is an exact-path rule; the comparison folds case and the
 * separator so `C:\Users\...\AGENTS.md` and the canonical constant are the same
 * file, while anything else stays rejected.
 */
export function normalizeAuthorizedPath(path: string): string {
  return path.trim().replaceAll('\\', '/').replaceAll(/\/+/g, '/').toLowerCase();
}

function assertAuthorizedPath(path: string): void {
  if (normalizeAuthorizedPath(path) === normalizeAuthorizedPath(AUTHORIZED_ACTUAL_GLOBAL_PATH)) {
    return;
  }
  throw new RenderedPromptError(
    'actual_global_path_rejected',
    `--actual-global accepts only ${AUTHORIZED_ACTUAL_GLOBAL_PATH}; refusing "${path}". ` +
      'No other path is read, and nothing was rendered from it.',
  );
}

async function readAuthorizedGlobal(
  path: string,
  reader: ((path: string) => Promise<string>) | undefined,
): Promise<string> {
  try {
    return reader === undefined ? await readFile(path, 'utf-8') : await reader(path);
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | null)?.code;
    const reason = typeof code === 'string' ? ` (${code})` : '';
    throw new RenderedPromptError(
      'actual_global_unreadable',
      `the authorized global instruction file is unreadable${reason}; no content was rendered.`,
    );
  }
}

function sourceHashFor(profile: PromptProfile, model: string, system: string, reminder: string) {
  const hash = createHash('sha256');
  for (const part of [profile, model, system, reminder]) hash.update(part).update('\u0000');
  return hash.digest('hex').slice(0, 16);
}

function fixtureSummaryFor(
  fixture: RenderFixture,
  agentsMd: AgentsMdSource,
  agentsMdChars: number,
): FixtureSummary {
  const skills = fixture.skills ?? '';
  const plugins = fixture.pluginSections ?? '';
  const additionalDirs = fixture.additionalDirsInfo ?? '';
  return {
    agentsMd,
    agentsMdChars,
    skillsChars: skills.length,
    plugins: plugins.length > 0,
    pluginChars: plugins.length,
    additionalDirsChars: additionalDirs.length,
    osKind: fixture.osKind ?? null,
    shellName: fixture.shellName ?? null,
    productName: fixture.productName ?? null,
    notifyUserActive: fixture.notifyUserActive === true,
    todoListActive: fixture.todoListActive === true,
    skillActive: fixture.skillActive === true,
  };
}

/**
 * Render one production profile.
 *
 * The returned object is everything a report may say about the prompt: its
 * source hash, its size in estimated tokens, the delivery channels of the six
 * core contracts, and a content-free summary of the fixture.
 */
export async function renderProfile(input: RenderProfileInput): Promise<RenderedPrompt> {
  if (!isPromptProfile(input.profile)) {
    throw new RenderedPromptError(
      'unknown_profile',
      `Unknown profile "${String(input.profile)}". Known profiles: ${PROMPT_PROFILES.join(', ')}.`,
    );
  }
  assertProfileMatchesModel(input.profile, input.model);

  if (input.fixture.cwd.trim().length === 0) {
    throw new RenderedPromptError(
      'fixture_incomplete',
      'the render fixture has no cwd; a prompt without a working directory is not one a session would receive.',
    );
  }

  let fixture = input.fixture;
  let agentsMdSource: AgentsMdSource = fixture.agentsMd === undefined ? 'none' : 'fixture';
  if (input.actualGlobalPath !== undefined) {
    assertAuthorizedPath(input.actualGlobalPath);
    const actual = await readAuthorizedGlobal(input.actualGlobalPath, input.readActualGlobal);
    if (actual.trim().length === 0) {
      throw new RenderedPromptError(
        'actual_global_unreadable',
        'the authorized global instruction file is empty; refusing to render it as project instructions.',
      );
    }
    fixture = { ...fixture, agentsMd: actual };
    agentsMdSource = 'actual';
  }

  const adaptation = await loadCuratedAdaptation(input.model);

  const rendered = renderSystemPromptResult(
    '',
    {
      cwd: fixture.cwd,
      ...(fixture.agentsMd === undefined ? {} : { agentsMd: fixture.agentsMd }),
      ...(fixture.skills === undefined ? {} : { skills: fixture.skills }),
      ...(fixture.pluginSections === undefined ? {} : { pluginSections: fixture.pluginSections }),
      ...(fixture.additionalDirsInfo === undefined
        ? {}
        : { additionalDirsInfo: fixture.additionalDirsInfo }),
      ...(fixture.osKind === undefined ? {} : { osKind: fixture.osKind }),
      ...(fixture.shellName === undefined ? {} : { shellName: fixture.shellName }),
      ...(fixture.shellPath === undefined ? {} : { shellPath: fixture.shellPath }),
      ...(fixture.productName === undefined ? {} : { productName: fixture.productName }),
      ...(fixture.notifyUserActive === undefined
        ? {}
        : { notifyUserActive: fixture.notifyUserActive }),
      ...(fixture.todoListActive === undefined ? {} : { todoListActive: fixture.todoListActive }),
      ...(fixture.skillActive === undefined ? {} : { skillActive: fixture.skillActive }),
      ...(adaptation === undefined ? {} : { modelAdaptation: adaptation }),
      modelName: input.model,
    },
    { skillActive: fixture.skillActive === true },
  );

  const agentsMdChars = (fixture.agentsMd ?? '').length;
  return {
    profile: input.profile,
    model: input.model,
    system: rendered.text,
    ...(adaptation === undefined ? {} : { reminderSourceId: DEEPSEEK_ADAPTATION_SOURCE_ID }),
    contractDelivery: rendered.contractDelivery ?? [],
    valueDelivery: rendered.valueDelivery ?? [],
    warnings: rendered.warnings ?? [],
    sourceHash: sourceHashFor(input.profile, input.model, rendered.text, adaptation ?? ''),
    tokens: { system: estimateTokens(rendered.text), reminder: 0 },
    fixtureSummary: fixtureSummaryFor(fixture, agentsMdSource, agentsMdChars),
  };
}

// ─── Contract coverage ──────────────────────────────────────────────────────

/**
 * Count each core contract id by the channel that carries it.
 *
 * Every contract arrives through the system prompt now, so the record is kept
 * channel-shaped only to stay comparable with older reports.
 */
export function contractCoverageFor(
  delivery: readonly { readonly id: string; readonly channel: string }[],
): ContractCoverage {
  const counts: Record<string, { system: number; reminder: number; omitted: number }> = {};
  for (const id of CORE_BEHAVIOR_CONTRACT_IDS) {
    counts[id] = { system: 0, reminder: 0, omitted: 0 };
  }
  for (const entry of delivery) {
    const count = counts[entry.id];
    if (count === undefined) continue;
    if (entry.channel === 'system') count.system += 1;
    else count.omitted += 1;
  }
  const coverage = {} as ContractCoverage;
  for (const id of CORE_BEHAVIOR_CONTRACT_IDS) {
    const count = counts[id] ?? { system: 0, reminder: 0, omitted: 0 };
    coverage[id] = { system: count.system, reminder: count.reminder, omitted: count.omitted };
  }
  return coverage;
}

/** Core ids that no channel carries in this run — the completeness gate's input. */
export function contractCoverageGaps(
  coverage: Readonly<Record<string, ContractCoverageCount>>,
): readonly CoreBehaviorContractId[] {
  return CORE_BEHAVIOR_CONTRACT_IDS.filter((id) => {
    const count = coverage[id];
    return count === undefined || count.system + count.reminder === 0;
  });
}

// ─── Fixture helpers ────────────────────────────────────────────────────────

/** The platform name agent-core writes into the prompt. */
export function hostOsKind(platform: string = process.platform): string {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  return platform;
}

/**
 * A fixture describing the machine the optimizer runs on, minus any user home
 * content. `agentsMd` is supplied by the caller so the project file it chooses
 * to benchmark is explicit.
 */
export function hostFixture(cwd: string, platform: string = process.platform): RenderFixture {
  const osKind = hostOsKind(platform);
  if (platform === 'win32') {
    return { cwd, osKind, shellName: 'Git Bash', shellPath: 'C:/Program Files/Git/bin/bash.exe' };
  }
  return { cwd, osKind, shellName: 'Bash', shellPath: '/bin/bash' };
}

/**
 * Project instructions for the default benchmark run.
 *
 * Synthetic on purpose. The repository's own `AGENTS.md` is reference data that
 * changes with every documentation edit, which would move the source hash on
 * runs that changed nothing about the prompt, and it quotes `${agents_md}` while
 * explaining what is injected — a literal placeholder that the renderer's
 * unresolved-variable scan reports as a template defect. A stable fixture keeps
 * two runs comparable and keeps the warning meaningful.
 */
export const DEFAULT_FIXTURE_AGENTS_MD = [
  '# Project instructions (benchmark fixture)',
  '',
  'These are project-supplied reference instructions, not a user request.',
  '',
  '- Package manager and test runner: `bun`.',
  '- Tests live in the package and run from its directory.',
  '- Match the style of the file you edit; keep the change focused.',
].join('\n');

/** The fixture the CLI benchmarks by default: this machine plus the stable fixture. */
export function benchmarkFixture(cwd: string, platform: string = process.platform): RenderFixture {
  return { ...hostFixture(cwd, platform), agentsMd: DEFAULT_FIXTURE_AGENTS_MD };
}
