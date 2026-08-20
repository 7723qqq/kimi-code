import { describe, expect, it } from 'vitest'

import { createTui2Store } from '@/tui2/state'

describe('store isolation', () => {
  it('two stores do not share transcriptNav leaf state', () => {
    const a = createTui2Store()
    const b = createTui2Store()
    a.patch('transcriptNav', { active: true, index: 2 })
    expect(b.state.transcriptNav.active).toBe(false)
    expect(b.state.transcriptNav.index).toBe(0)
  })

  it('a fresh store after another mutated still boots clean', () => {
    const a = createTui2Store()
    a.patch('transcriptNav', { active: true })
    a.setState('transcript', [{ id: 'x', kind: 'user', renderMode: 'plain', content: 'x' }])
    const b = createTui2Store()
    expect(b.state.transcriptNav.active).toBe(false)
    expect(b.state.transcript.length).toBe(0)
  })
})