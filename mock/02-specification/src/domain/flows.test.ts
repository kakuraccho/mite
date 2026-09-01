import { PRIMARY_GUIDE, createInitialState } from './fixtures'
import { miteReducer } from './reducer'
import type { AppAction, AppState } from './types'

const send = (state: AppState, action: AppAction) =>
  miteReducer(state, action)

const sendAll = (state: AppState, actions: AppAction[]) =>
  actions.reduce(send, state)

const createViewedRequestState = () =>
  sendAll(createInitialState('A'), [
    { type: 'START_SUPPORT_REQUEST' },
    { type: 'SUBMIT_SUPPORT_REQUEST' },
    { type: 'GUIDE_MATCH_NOT_FOUND' },
    { type: 'VIEW_SUPPORT_REQUEST' },
  ])

const createSupportingState = () =>
  sendAll(createViewedRequestState(), [
    { type: 'START_CALL' },
    { type: 'ACCEPT_CALL' },
    { type: 'CONNECTION_ESTABLISHED' },
  ])

const createGuideDecisionState = () =>
  sendAll(createSupportingState(), [
    { type: 'MOCK_CAPTURE_TICK' },
    { type: 'FINISH_PROBLEM_SOLVING' },
  ])

const createGuideReviewState = () =>
  sendAll(createGuideDecisionState(), [
    { type: 'CHOOSE_CREATE_GUIDE' },
    { type: 'GUIDE_DRAFT_GENERATED' },
  ])

describe('Scenario B', () => {
  it('類似ガイドを最初の手順から利用し、最後まで完了できる', () => {
    let state = createInitialState('B')

    expect(state.settings.matchMode).toBe('match')

    state = sendAll(state, [
      { type: 'START_SUPPORT_REQUEST' },
      { type: 'SUBMIT_SUPPORT_REQUEST' },
    ])
    expect(state.supportRequest?.status).toBe('matching')

    state = send(state, {
      type: 'GUIDE_MATCH_FOUND',
      guideId: PRIMARY_GUIDE.id,
    })
    expect(state.supportRequest?.status).toBe('closed')
    expect(state.guideRun).toEqual({
      guideId: PRIMARY_GUIDE.id,
      status: 'running',
      currentStepIndex: 0,
      entry: 'similarGuideMatch',
    })
    expect(state.notice?.kind).toBe('similarGuideFound')

    state = sendAll(state, [
      { type: 'GO_TO_NEXT_GUIDE_STEP' },
      { type: 'GO_TO_NEXT_GUIDE_STEP' },
      { type: 'COMPLETE_GUIDE' },
    ])
    expect(state.guideRun.status).toBe('completed')
    expect(state.guideRun.currentStepIndex).toBe(
      PRIMARY_GUIDE.steps.length - 1,
    )
  })
})

describe('Scenario C', () => {
  it('公開済みガイドを一覧から選び、前後移動して最終手順で完了する', () => {
    let state = createInitialState('C')

    state = send(state, { type: 'OPEN_GUIDE_LIST' })
    expect(state.guideRun.status).toBe('browsing')

    state = send(state, {
      type: 'SELECT_GUIDE',
      guideId: PRIMARY_GUIDE.id,
    })
    expect(state.guideRun).toEqual({
      guideId: PRIMARY_GUIDE.id,
      status: 'running',
      currentStepIndex: 0,
      entry: 'guideList',
    })

    state = send(state, { type: 'GO_TO_NEXT_GUIDE_STEP' })
    expect(state.guideRun.currentStepIndex).toBe(1)

    state = send(state, { type: 'GO_TO_PREVIOUS_GUIDE_STEP' })
    expect(state.guideRun.currentStepIndex).toBe(0)

    state = send(state, { type: 'COMPLETE_GUIDE' })
    expect(state.guideRun.status).toBe('running')

    state = sendAll(state, [
      { type: 'GO_TO_NEXT_GUIDE_STEP' },
      { type: 'GO_TO_NEXT_GUIDE_STEP' },
      { type: 'GO_TO_NEXT_GUIDE_STEP' },
    ])
    expect(state.guideRun.currentStepIndex).toBe(
      PRIMARY_GUIDE.steps.length - 1,
    )

    state = send(state, { type: 'COMPLETE_GUIDE' })
    expect(state.guideRun.status).toBe('completed')

    state = send(state, { type: 'CLOSE_COMPLETED_GUIDE' })
    expect(state.guideRun).toEqual({
      guideId: null,
      status: 'idle',
      currentStepIndex: 0,
      entry: null,
    })
  })
})

describe('Scenario D', () => {
  it('ガイド途中の確認後、手順情報を引き継いで家族への支援依頼を表示する', () => {
    let state = createInitialState('D')

    state = sendAll(state, [
      { type: 'OPEN_GUIDE_LIST' },
      { type: 'SELECT_GUIDE', guideId: PRIMARY_GUIDE.id },
      { type: 'GO_TO_NEXT_GUIDE_STEP' },
      { type: 'OPEN_REMOTE_SUPPORT_CONFIRMATION' },
    ])
    expect(state.remoteSupportConfirmationOpen).toBe(true)

    state = send(state, { type: 'REQUEST_REMOTE_SUPPORT_FROM_GUIDE' })
    expect(state.guideRun.status).toBe('fallback')
    expect(state.remoteSupportConfirmationOpen).toBe(false)
    expect(state.supportRequest).toMatchObject({
      status: 'draft',
      source: 'guideFallback',
      screenshotId: PRIMARY_GUIDE.steps[1].imageId,
      guideContext: {
        guideId: PRIMARY_GUIDE.id,
        guideTitle: PRIMARY_GUIDE.title,
        stepNumber: 2,
      },
    })

    state = sendAll(state, [
      { type: 'SUBMIT_SUPPORT_REQUEST' },
      { type: 'GUIDE_MATCH_NOT_FOUND' },
    ])
    expect(state.supportRequest?.status).toBe('pending')
  })

  it('ガイドから移った支援を終了すると通常状態へ戻る', () => {
    let state = createInitialState('D')
    state = sendAll(state, [
      { type: 'OPEN_GUIDE_LIST' },
      { type: 'SELECT_GUIDE', guideId: PRIMARY_GUIDE.id },
      { type: 'OPEN_REMOTE_SUPPORT_CONFIRMATION' },
      { type: 'REQUEST_REMOTE_SUPPORT_FROM_GUIDE' },
      { type: 'SUBMIT_SUPPORT_REQUEST' },
      { type: 'GUIDE_MATCH_NOT_FOUND' },
      { type: 'VIEW_SUPPORT_REQUEST' },
      { type: 'START_CALL' },
      { type: 'ACCEPT_CALL' },
      { type: 'CONNECTION_ESTABLISHED' },
      { type: 'MOCK_CAPTURE_TICK' },
      { type: 'FINISH_PROBLEM_SOLVING' },
      { type: 'CHOOSE_SKIP_GUIDE' },
    ])

    expect(state.supportSession.status).toBe('ended')
    expect(state.guideRun.status).toBe('idle')
    expect(state.lastSessionOutcome).toBe('supportEnded')
  })
})

describe('支援セッション', () => {
  it('着信への応答後、接続中を経て支援中になる', () => {
    let state = createViewedRequestState()

    state = send(state, { type: 'START_CALL' })
    expect(state.supportSession.status).toBe('ringing')

    state = send(state, { type: 'ACCEPT_CALL' })
    expect(state.supportSession.status).toBe('connecting')

    state = send(state, { type: 'CONNECTION_ESTABLISHED' })
    expect(state.supportSession.status).toBe('supporting')
    expect(state.supportSession.requestId).toBe(state.supportRequest?.id)
  })

  it('支援中のマーカーを0から1の相対座標内に収める', () => {
    let state = createSupportingState()

    state = send(state, {
      type: 'PLACE_MARKER',
      xRatio: -0.2,
      yRatio: 1.4,
    })

    expect(state.supportSession.marker).toMatchObject({
      xRatio: 0,
      yRatio: 1,
    })
  })

  it('問題解決後にガイド作成を選ぶと生成・レビューへ進む', () => {
    let state = createGuideDecisionState()

    expect(state.supportSession.status).toBe('guideDecision')

    state = send(state, { type: 'CHOOSE_CREATE_GUIDE' })
    expect(state.supportSession.status).toBe('guideGenerating')

    state = send(state, { type: 'GUIDE_DRAFT_GENERATED' })
    expect(state.supportSession.status).toBe('guideReview')
    expect(state.draftGuide).toMatchObject({
      status: 'draft',
      createdFromRequestId: state.supportRequest?.id,
    })
  })

  it('最初の疑似記録より前は問題解決状態へ進めない', () => {
    const state = send(createSupportingState(), {
      type: 'FINISH_PROBLEM_SOLVING',
    })

    expect(state.supportSession.status).toBe('supporting')
    expect(state.supportSession.mockCaptureCount).toBe(0)
  })

  it('問題解決後にガイドを作らない場合は支援だけを終了する', () => {
    const state = send(createGuideDecisionState(), {
      type: 'CHOOSE_SKIP_GUIDE',
    })

    expect(state.supportSession.status).toBe('ended')
    expect(state.supportRequest?.status).toBe('closed')
    expect(state.draftGuide).toBeNull()
    expect(state.notice).toEqual({
      kind: 'supportEnded',
      message: '支援を終了しました。',
    })
  })
})

describe('ガイドレビュー', () => {
  it('家族のタイトル・現在手順の編集を共有状態へ即時反映する', () => {
    let state = createGuideReviewState()

    state = send(state, {
      type: 'UPDATE_GUIDE_TITLE',
      title: '番号を確認して購入画面へ戻る',
    })
    state = send(state, {
      type: 'GO_TO_GUIDE_REVIEW_STEP',
      direction: 'next',
    })
    state = send(state, {
      type: 'UPDATE_GUIDE_STEP',
      instruction: '画面下の飛行機マークを一度だけ押します。',
    })

    expect(state.reviewStepIndex).toBe(1)
    expect(state.draftGuide?.title).toBe('番号を確認して購入画面へ戻る')
    expect(state.draftGuide?.steps[1].instruction).toBe(
      '画面下の飛行機マークを一度だけ押します。',
    )
    expect(state.draftGuide?.steps[0].instruction).toBe(
      PRIMARY_GUIDE.steps[0].instruction,
    )
  })
})

describe('デモのリセット', () => {
  it('選択中のシナリオ設定とフィクスチャの初期状態へ戻す', () => {
    let state = createInitialState('B')
    state = sendAll(state, [
      { type: 'START_SUPPORT_REQUEST' },
      { type: 'SET_REQUEST_COMMENT', comment: '変更したコメント' },
      { type: 'SUBMIT_SUPPORT_REQUEST' },
      { type: 'GUIDE_MATCH_FOUND', guideId: PRIMARY_GUIDE.id },
      { type: 'GO_TO_NEXT_GUIDE_STEP' },
    ])

    state = send(state, { type: 'RESET_DEMO' })

    expect(state).toEqual(createInitialState('B'))
    expect(state.settings.matchMode).toBe('match')
  })
})
