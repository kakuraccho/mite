import { createInitialState } from './fixtures'
import { miteReducer } from './reducer'
import type { AppAction, AppState } from './types'

const send = (state: AppState, action: AppAction) =>
  miteReducer(state, action)

describe('Scenario A', () => {
  it('困りごとの記録から家族支援、ガイド編集・保存まで進む', () => {
    let state = createInitialState('A')

    state = send(state, { type: 'START_SUPPORT_REQUEST' })
    state = send(state, {
      type: 'SET_REQUEST_COMMENT',
      comment: '番号は分かったけれど、飛行機の画面に戻れません',
    })
    state = send(state, { type: 'SUBMIT_SUPPORT_REQUEST' })
    expect(state.supportRequest?.status).toBe('matching')

    state = send(state, { type: 'GUIDE_MATCH_NOT_FOUND' })
    expect(state.supportRequest?.status).toBe('pending')

    state = send(state, { type: 'VIEW_SUPPORT_REQUEST' })
    state = send(state, { type: 'START_CALL' })
    expect(state.supportSession.status).toBe('ringing')

    state = send(state, { type: 'ACCEPT_CALL' })
    expect(state.supportSession.status).toBe('connecting')
    state = send(state, { type: 'CONNECTION_ESTABLISHED' })
    expect(state.supportSession.status).toBe('supporting')

    state = send(state, { type: 'PLACE_MARKER', xRatio: 0.48, yRatio: 0.91 })
    state = send(state, { type: 'MOCK_CAPTURE_TICK' })
    expect(state.supportSession.marker).toMatchObject({
      xRatio: 0.48,
      yRatio: 0.91,
    })
    expect(state.supportSession.mockCaptureCount).toBe(1)

    state = send(state, { type: 'FINISH_PROBLEM_SOLVING' })
    expect(state.supportSession.status).toBe('guideDecision')
    state = send(state, { type: 'CHOOSE_CREATE_GUIDE' })
    expect(state.supportSession.status).toBe('guideGenerating')
    state = send(state, { type: 'GUIDE_DRAFT_GENERATED' })
    expect(state.supportSession.status).toBe('guideReview')

    state = send(state, {
      type: 'UPDATE_GUIDE_TITLE',
      title: '確認番号を見て、飛行機の画面へ戻る',
    })
    state = send(state, {
      type: 'GO_TO_GUIDE_REVIEW_STEP',
      direction: 'next',
    })
    state = send(state, {
      type: 'UPDATE_GUIDE_STEP',
      instruction: '画面下の飛行機マークを、1回押します。',
    })

    expect(state.draftGuide?.title).toBe(
      '確認番号を見て、飛行機の画面へ戻る',
    )
    expect(state.draftGuide?.steps[1].instruction).toBe(
      '画面下の飛行機マークを、1回押します。',
    )

    state = send(state, { type: 'SAVE_GUIDE' })
    expect(state.supportSession.status).toBe('ended')
    expect(state.supportRequest?.status).toBe('closed')
    expect(state.supportSession.marker).toBeNull()
    expect(state.guides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'guide-auth-code-created',
          status: 'published',
          title: '確認番号を見て、飛行機の画面へ戻る',
        }),
      ]),
    )
  })
})
