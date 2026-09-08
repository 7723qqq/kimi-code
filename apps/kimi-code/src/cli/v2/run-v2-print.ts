/**
 * v2 print runner compatibility facade and background policy helpers.
 * Fully decoupled from agent-core-v2 while preserving testable pure logic.
 */

import { runNativePrint } from '../run-native-print.js';
import type { CLIOptions } from '../options.js';
import type { PromptRunIO } from '../run-prompt.js';
import { t } from '#/i18n';

export const PRINT_WAIT_CEILING_S_DEFAULT = 60;
export const PRINT_MAX_TURNS_DEFAULT = 50;
const GOAL_WAIT_POLL_MS = 500;
const CRON_FIRE_GRACE_MS = 2_000;

export async function runV2Print(
  opts: CLIOptions,
  version: string,
  io: PromptRunIO = {},
): Promise<void> {
  await runNativePrint(opts, version, io);
}

export class PrintSteeredTurnFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrintSteeredTurnFailedError';
  }
}

export interface PrintTurnEnding {
  readonly type: 'turn.ended';
  readonly turnId: number;
  readonly reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
  readonly error?: { readonly code?: string; readonly message?: string };
}

export interface PrintTurnEndings {
  next(timeoutMs: number, skipTurnId?: number): Promise<PrintTurnEnding | null>;
}

const MAX_TIMEOUT_MS = 2_147_483_647;
function setClampedTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  return setTimeout(fn, Math.min(Math.max(0, ms), MAX_TIMEOUT_MS));
}

export function createPrintTurnEndings(): PrintTurnEndings & {
  push: (event: PrintTurnEnding) => void;
} {
  const buffer: PrintTurnEnding[] = [];
  let waiter: ((ending: PrintTurnEnding | null) => void) | undefined;
  return {
    push: (event) => {
      const resolve = waiter;
      if (resolve !== undefined) {
        waiter = undefined;
        resolve(event);
        return;
      }
      buffer.push(event);
    },
    next: async (remainingMs, skipTurnId) => {
      const deadlineAt = Date.now() + remainingMs;
      const waitOnce = (ms: number): Promise<PrintTurnEnding | null> =>
        new Promise((resolve) => {
          let settled = false;
          const settle = (value: PrintTurnEnding | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            waiter = undefined;
            resolve(value);
          };
          const timer = Number.isFinite(ms)
            ? setClampedTimeout(() => {
                settle(null);
              }, ms)
            : undefined;
          waiter = settle;
        });
      for (;;) {
        while (buffer.length > 0) {
          const ending = buffer.shift()!;
          if (ending.turnId !== skipTurnId) return ending;
        }
        const ms = deadlineAt - Date.now();
        if (ms <= 0) return null;
        const ending = await waitOnce(ms);
        if (ending === null) continue;
        if (ending.turnId !== skipTurnId) return ending;
      }
    },
  };
}

export interface PrintBackgroundPolicyInput {
  readonly mode: 'exit' | 'drain' | 'steer';
  readonly ceilingS: number;
  readonly maxTurns: number;
  readonly countPending: () => number;
  readonly drain: () => Promise<void>;
  readonly turnEndings: PrintTurnEndings;
  readonly skipTurnId: number;
  readonly warn: (message: string) => void;
  readonly now: () => number;
  readonly goalActive?: () => boolean;
  readonly cronNextFireAt?: () => number | null;
}

export async function applyPrintBackgroundPolicy(input: PrintBackgroundPolicyInput): Promise<void> {
  const deadline = input.now() + input.ceilingS * 1000;
  let turns = 0;
  let lastPastFireAt: number | undefined;
  let cronWedged = false;
  for (;;) {
    while (input.goalActive?.() === true) {
      const ended = await input.turnEndings.next(
        Math.min(deadline - input.now(), GOAL_WAIT_POLL_MS),
        input.skipTurnId,
      );
      if (ended === null && input.now() >= deadline) {
        input.warn(`print goal wait ceiling reached (${input.ceilingS}s), finishing`);
        return;
      }
    }

    if (!cronWedged && input.cronNextFireAt !== undefined) {
      const fireAt = input.cronNextFireAt();
      if (fireAt !== null) {
        if (fireAt <= input.now() && lastPastFireAt === fireAt) {
          cronWedged = true;
          input.warn(
            'print cron wait: next fire time stuck in the past; cron tick appears wedged, giving up on cron',
          );
        } else {
          if (fireAt <= input.now()) lastPastFireAt = fireAt;
          const ended = await input.turnEndings.next(
            Math.max(fireAt - input.now(), 0) + CRON_FIRE_GRACE_MS,
            input.skipTurnId,
          );
          if (ended !== null && ended.reason !== 'completed') {
            throw new PrintSteeredTurnFailedError(formatTurnEndingFailure(ended));
          }
          continue;
        }
      }
    }

    if (input.mode === 'exit') return;
    if (input.mode === 'drain') {
      await input.drain();
      return;
    }

    turns += 1;
    if (input.now() >= deadline) {
      input.warn(`print steer ceiling reached (${input.ceilingS}s), finishing`);
      return;
    }
    if (turns > input.maxTurns) {
      input.warn(`print steer max turns reached (${input.maxTurns}), finishing`);
      return;
    }
    if (input.countPending() === 0) return;
    const ended = await input.turnEndings.next(deadline - input.now(), input.skipTurnId);
    if (ended === null) return;
    if (ended.reason !== 'completed') {
      throw new PrintSteeredTurnFailedError(formatTurnEndingFailure(ended));
    }
  }
}

function formatTurnEndingFailure(ending: PrintTurnEnding): string {
  if (ending.error?.code === 'provider.filtered') {
    return t('tui.statusMessages.policyBlocked');
  }
  if (ending.error !== undefined) return `${ending.error.code}: ${ending.error.message}`;
  if (ending.reason === 'blocked') {
    return t('tui.statusMessages.promptBlocked');
  }
  return `Prompt turn ended with reason: ${ending.reason}`;
}
