import { PRIMARY_GUIDE, createInitialState } from '../domain/fixtures'
import { miteReducer } from '../domain/reducer'
import { findMockMatchingGuide, formatRequestTime } from './mockMiteService'

describe('mockMiteService', () => {
  it('類似ガイドあり設定では主ガイドを決定的に返す', () => {
    const state = createInitialState('B')
    expect(findMockMatchingGuide(state)?.id).toBe(PRIMARY_GUIDE.id)
  })

  it('ガイドから家族への相談を選んだ依頼は同じガイドへ戻さない', () => {
    let state = createInitialState('B')
    state = miteReducer(state, { type: 'OPEN_GUIDE_LIST' })
    state = miteReducer(state, {
      type: 'SELECT_GUIDE',
      guideId: PRIMARY_GUIDE.id,
    })
    state = miteReducer(state, {
      type: 'OPEN_REMOTE_SUPPORT_CONFIRMATION',
    })
    state = miteReducer(state, { type: 'REQUEST_REMOTE_SUPPORT_FROM_GUIDE' })

    expect(state.settings.matchMode).toBe('match')
    expect(state.supportRequest?.source).toBe('guideFallback')
    expect(findMockMatchingGuide(state)).toBeNull()
  })

  it('依頼時刻は閲覧環境にかかわらず日本時間で表示する', () => {
    expect(formatRequestTime('2026-08-24T10:15:00+09:00')).toContain('10:15')
  })
})
