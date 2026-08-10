/**
 * `progressTrack` — outcome-based tool-receipt tracking (ported from
 * Reasonix's `internal/evidence/outcome.go`).
 *
 * Classifies each tool round by *outcome* instead of novelty: exploration
 * (new information), verification (commands that can falsify the working
 * hypothesis), objective/regression (verification state transitions),
 * churn (unverified mutations). Two derived signals feed the
 * Evidence-Before-More-Mutation reminder:
 *   - `blindMutations`: mutations since the last discriminating observation
 *   - `debtAge`: rounds carrying an unverified mutation
 * The tracker is pure and deterministic — the service layer owns wiring,
 * config and reminder injection.
 */

/** One tool round's receipts, normalized for classification. */
export interface ToolReceipt {
  readonly toolName: string;
  /** Raw command text (Bash tool only). */
  readonly command?: string | undefined;
  /** File paths touched by the call (from ToolAccesses). */
  readonly paths?: {
    readonly read: readonly string[];
    readonly write: readonly string[];
  } | undefined;
  readonly success: boolean;
  readonly isError?: boolean | undefined;
}

/** One round's outcome decomposition (unit-weighted counts). */
export interface ProgressSample {
  exploration: number;
  verification: number;
  objective: number;
  regression: number;
  churn: number;
  discriminating: number;
  debtAge: number;
  blindMutations: number;
}

export const EMPTY_SAMPLE: ProgressSample = {
  exploration: 0,
  verification: 0,
  objective: 0,
  regression: 0,
  churn: 0,
  discriminating: 0,
  debtAge: 0,
  blindMutations: 0,
};

/**
 * Commands that can falsify the working hypothesis — test runners and
 * checkers. Deliberately narrow; a build/typecheck counts as verification
 * only when the command itself is a check (not a build that happens to fail).
 */
const VERIFICATION_PATTERN =
  /(^|[\s&|;])(pytest|npm\s+test|pnpm\s+test|yarn\s+test|bun\s+test|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|make\s+test|tox|ctest|vitest|jest|karma|ava|mocha|rspec|phpunit|flutter\s+test|nx\s+test|turbo\s+test|tsc)(\s|$)/i;
const VERIFICATION_KEYWORD = /\b(test|tests|check|verify|validate|typecheck|type-check)\b/i;

export function isVerificationCommand(command: string): boolean {
  if (VERIFICATION_PATTERN.test(command)) return true;
  // `go test ./...`, `node --test x`, `python -m pytest ...` style invocations
  // carry the keyword in the argument tail; a bare keyword in a build command
  // ("build the tests") is a false positive we accept for the nudge's sake.
  return VERIFICATION_KEYWORD.test(command);
}

interface TrackerState {
  readonly round: number;
  readonly readPaths: ReadonlySet<string>;
  readonly commands: ReadonlySet<string>;
  readonly failures: ReadonlySet<string>;
  readonly actions: ReadonlySet<string>;
  readonly verifySeen: ReadonlySet<string>;
  readonly verifyPass: ReadonlySet<string>;
  readonly mutatedBases: ReadonlySet<string>;
  readonly debt: boolean;
  debtAge: number;
  readonly blind: number;
}

export const EMPTY_TRACKER: TrackerState = {
  round: 0,
  readPaths: new Set(),
  commands: new Set(),
  failures: new Set(),
  actions: new Set(),
  verifySeen: new Set(),
  verifyPass: new Set(),
  mutatedBases: new Set(),
  debt: false,
  debtAge: 0,
  blind: 0,
};

export class ProgressTracker {
  private state: TrackerState = EMPTY_TRACKER;

  /** Fold one round's receipts and return the outcome sample. */
  scoreRound(receipts: readonly ToolReceipt[]): ProgressSample {
    const sample = { ...EMPTY_SAMPLE };
    let next: TrackerState = {
      ...this.state,
      round: this.state.round + 1,
      readPaths: new Set(this.state.readPaths),
      commands: new Set(this.state.commands),
      failures: new Set(this.state.failures),
      actions: new Set(this.state.actions),
      verifySeen: new Set(this.state.verifySeen),
      verifyPass: new Set(this.state.verifyPass),
      mutatedBases: new Set(this.state.mutatedBases),
    };
    for (const receipt of receipts) {
      next = this.scoreReceipt(receipt, sample, next);
    }
    // Verification debt: a discriminating observation settles it; a mutation
    // opens it and every silent round ages it.
    if (sample.discriminating > 0) {
      next = { ...next, debt: false, debtAge: 0, blind: 0 };
    } else {
      if (sample.churn > 0) {
        next = { ...next, debt: true, blind: next.blind + sample.churn };
      }
      if (next.debt) {
        next = { ...next, debtAge: next.debtAge + 1 };
      }
    }
    sample.debtAge = next.debtAge;
    sample.blindMutations = next.blind;
    this.state = next;
    return sample;
  }

  get blindMutations(): number {
    return this.state.blind;
  }

  get debtAge(): number {
    return this.state.debtAge;
  }

  private scoreReceipt(
    receipt: ToolReceipt,
    sample: ProgressSample,
    state: TrackerState,
  ): TrackerState {
    const command = receipt.command?.trim();
    if (command !== undefined && command.length > 0) {
      return this.scoreCommand(receipt, command, sample, state);
    }
    switch (true) {
      case receipt.success && isWrite(receipt):
        // A mutation is a state transition, not proof of progress.
        sample.churn += 1;
        return this.noteMutatedPaths(state, receipt);
      case receipt.success && isDelegation(receipt):
        // A delegation return is new information at best.
        sample.exploration += 1;
        return state;
      case receipt.success && receipt.isError !== true && isNewRead(receipt, state):
        sample.exploration += 1;
        return {
          ...state,
          readPaths: new Set([...state.readPaths, ...(receipt.paths?.read ?? [])]),
        };
      case receipt.success && isReadOnly(receipt):
        // Already-seen read: no new information.
        return state;
      case receipt.success:
        return this.noteAction(state, receipt, sample);
      default:
        return state;
    }
  }

  private scoreCommand(
    receipt: ToolReceipt,
    command: string,
    sample: ProgressSample,
    state: TrackerState,
  ): TrackerState {
    let next = state;
    if (receipt.success && isWrite(receipt)) {
      sample.churn += 1;
      next = this.noteMutatedPaths(next, receipt);
    }
    const verify = isVerificationCommand(command);
    if (verify || this.commandExercisesMutation(command, next.mutatedBases)) {
      sample.discriminating += 1;
    }
    if (verify) {
      sample.verification += 1;
      const seen = next.verifySeen.has(command);
      const wasPass = next.verifyPass.has(command);
      next = {
        ...next,
        verifySeen: new Set([...next.verifySeen, command]),
        verifyPass: receipt.success
          ? new Set([...next.verifyPass, command])
          : new Set(next.verifyPass),
      };
      if (seen && receipt.success && !wasPass) sample.objective += 1;
      if (seen && !receipt.success && wasPass) sample.regression += 1;
    }
    if (receipt.success) {
      if (!verify && !next.commands.has(command)) sample.exploration += 1;
      next = { ...next, commands: new Set([...next.commands, command]) };
      return next;
    }
    if (!next.failures.has(command)) {
      next = { ...next, failures: new Set([...next.failures, command]) };
      sample.exploration += 1;
    }
    return next;
  }

  private noteMutatedPaths(state: TrackerState, receipt: ToolReceipt): TrackerState {
    const bases = new Set(state.mutatedBases);
    for (const path of receipt.paths?.write ?? []) {
      const base = path.replaceAll('\\', '/').split('/').at(-1);
      if (base !== undefined && base.length >= 3) bases.add(base);
    }
    return { ...state, mutatedBases: bases };
  }

  private noteAction(state: TrackerState, receipt: ToolReceipt, sample: ProgressSample): TrackerState {
    const signature = `${receipt.toolName}\u0000${JSON.stringify(receipt.paths ?? {})}`;
    if (state.actions.has(signature)) return state;
    sample.exploration += 1;
    return { ...state, actions: new Set([...state.actions, signature]) };
  }

  private commandExercisesMutation(command: string, mutatedBases: ReadonlySet<string>): boolean {
    for (const base of mutatedBases) {
      if (command.includes(base)) return true;
    }
    return false;
  }
}

function isWrite(receipt: ToolReceipt): boolean {
  return (receipt.paths?.write?.length ?? 0) > 0;
}

function isDelegation(receipt: ToolReceipt): boolean {
  return receipt.toolName === 'Agent' || receipt.toolName === 'AgentSwarm';
}

function isReadOnly(receipt: ToolReceipt): boolean {
  return (receipt.paths?.read?.length ?? 0) > 0 && (receipt.paths?.write?.length ?? 0) === 0;
}

function isNewRead(receipt: ToolReceipt, state: TrackerState): boolean {
  return (receipt.paths?.read?.length ?? 0) > 0 &&
    (receipt.paths?.read ?? []).some((path) => !state.readPaths.has(path));
}
