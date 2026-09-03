import { describe, expect, it } from 'vitest'
import { RevisionGate, selectNewestRevision } from './revision'

const entity = (id: string, revision: number) => ({
  id,
  revision,
  createdAt: '2026-09-03T00:00:00Z',
  updatedAt: '2026-09-03T00:00:00Z',
})

describe('selectNewestRevision', () => {
  it('古いrevisionと同じrevisionを無視する', () => {
    const current = entity('session_01', 4)
    expect(selectNewestRevision(current, entity('session_01', 3))).toBe(current)
    expect(selectNewestRevision(current, entity('session_01', 4))).toBe(current)
    expect(
      selectNewestRevision(current, entity('session_01', 5)).revision,
    ).toBe(5)
  })
})

describe('RevisionGate', () => {
  it('エンティティごとに増加するrevisionだけを受け入れる', () => {
    const gate = new RevisionGate()
    expect(gate.accept('request_01', 1)).toBe(true)
    expect(gate.accept('request_01', 1)).toBe(false)
    expect(gate.accept('request_01', 0)).toBe(false)
    expect(gate.accept('request_01', 2)).toBe(true)
    expect(gate.accept('session_01', 1)).toBe(true)
  })
})
