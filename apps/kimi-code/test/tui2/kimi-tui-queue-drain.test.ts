/**
 * Regression tests for queued skill-activation routing on the manual drain
 * paths (`KimiTUI.sendQueuedMessage` / `drainOneQueuedMessage`).
 *
 * A queued `/skill` item carries a `skillName` payload and must re-enter
 * through `sendSkillActivation`, never as literal prompt text — the same
 * contract the event-driven drain already follows inside
 * session-event-handler (v1 behavior). Plain-text and bash (`!`) items keep
 * their existing paths.
 *
 * KimiTUI's constructor wires a full terminal stack, so these tests invoke
 * the real prototype methods against a stubbed `this`: only the members the
 * drain path touches are replaced.
 */

import { describe, expect, it, vi } from 'vitest'

import { KimiTUI } from '@/tui2/controllers/kimi-tui'
import type { QueuedMessage } from '@/tui2/types'

const session = { id: 'session-1' } as never

function makeTui(queue: QueuedMessage[] = []) {
  const sendMessageInternal = vi.fn()
  const sendSkillActivation = vi.fn()
  const runShellCommandFromInput = vi.fn(async () => {})
  const tui = Object.assign(Object.create(KimiTUI.prototype), {
    session,
    harness: {
      withInteractiveAgent: (_agentId: string | undefined, fn: () => void) => {
        fn();
      },
    },
    sendMessageInternal,
    sendSkillActivation,
    runShellCommandFromInput,
    shiftQueuedMessage: vi.fn(() => queue.shift()),
    updateQueueDisplay: vi.fn(),
  }) as unknown as KimiTUI
  return { tui, sendMessageInternal, sendSkillActivation, runShellCommandFromInput }
}

describe('KimiTUI manual queue drain routes skill activations', () => {
  it('sendQueuedMessage dispatches a queued skill activation instead of prompt text', () => {
    const { tui, sendSkillActivation, sendMessageInternal } = makeTui()

    tui.sendQueuedMessage(session, {
      text: '/review src/a.ts',
      skillName: 'review',
      skillArgs: 'src/a.ts',
    })

    expect(sendSkillActivation).toHaveBeenCalledWith(session, 'review', 'src/a.ts')
    expect(sendMessageInternal).not.toHaveBeenCalled()
  })

  it('sendQueuedMessage defaults missing skillArgs to an empty string', () => {
    const { tui, sendSkillActivation } = makeTui()

    tui.sendQueuedMessage(session, { text: '/fix', skillName: 'fix' })

    expect(sendSkillActivation).toHaveBeenCalledWith(session, 'fix', '')
  })

  it('drainOneQueuedMessage drains a queued skill activation through the activation path', () => {
    const queue: QueuedMessage[] = [
      { text: '/review src/a.ts', skillName: 'review', skillArgs: 'src/a.ts' },
    ]
    const { tui, sendSkillActivation, sendMessageInternal } = makeTui(queue)

    tui.drainOneQueuedMessage()

    expect(sendSkillActivation).toHaveBeenCalledWith(session, 'review', 'src/a.ts')
    expect(sendMessageInternal).not.toHaveBeenCalled()
    expect(queue).toEqual([])
  })

  it('keeps plain-text queued items on the prompt path', () => {
    const { tui, sendMessageInternal, sendSkillActivation } = makeTui()

    tui.sendQueuedMessage(session, { text: 'follow-up question' })

    expect(sendMessageInternal).toHaveBeenCalledWith(session, 'follow-up question', {
      parts: undefined,
      imageAttachmentIds: undefined,
    })
    expect(sendSkillActivation).not.toHaveBeenCalled()
  })

  it('keeps bash-mode queued items on the shell path when drained', () => {
    const queue: QueuedMessage[] = [{ text: 'git status', mode: 'bash' }]
    const { tui, runShellCommandFromInput, sendMessageInternal, sendSkillActivation } = makeTui(queue)

    tui.drainOneQueuedMessage()

    expect(runShellCommandFromInput).toHaveBeenCalledWith('git status')
    expect(sendMessageInternal).not.toHaveBeenCalled()
    expect(sendSkillActivation).not.toHaveBeenCalled()
  })
})
