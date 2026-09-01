import {
  FIXED_REQUEST_CREATED_AT,
  createDraftGuide,
  createInitialState,
} from './fixtures'
import type { AppAction, AppState, Guide, SupportRequest } from './types'

const clamp = (value: number) => Math.min(1, Math.max(0, value))

const logicalTime = (sequence: number) =>
  `T+${String(sequence).padStart(2, '0')}秒`

const addEvent = (
  state: AppState,
  event: string,
  label: string,
): AppState => {
  const nextSequence = state.eventSequence + 1
  return {
    ...state,
    eventSequence: nextSequence,
    eventLog: [
      {
        id: nextSequence,
        event,
        label,
        logicalTime: logicalTime(nextSequence),
      },
      ...state.eventLog,
    ].slice(0, 12),
  }
}

const createProblemRequest = (): SupportRequest => ({
  id: 'request-auth-code',
  createdAt: FIXED_REQUEST_CREATED_AT,
  screenshotId: 'mock-mail-screen',
  comment: '',
  status: 'draft',
  source: 'problem',
})

const replaceOrAppendGuide = (guides: Guide[], nextGuide: Guide) => {
  const index = guides.findIndex((guide) => guide.id === nextGuide.id)
  if (index === -1) return [...guides, nextGuide]

  return guides.map((guide, guideIndex) =>
    guideIndex === index ? nextGuide : guide,
  )
}

const activeGuide = (state: AppState) =>
  state.guides.find((guide) => guide.id === state.guideRun.guideId) ?? null

export const miteReducer = (state: AppState, action: AppAction): AppState => {
  switch (action.type) {
    case 'OPEN_EDGE_PANEL':
      return addEvent(state, action.type, '左端のMiteメニューを開いた')

    case 'START_SUPPORT_REQUEST': {
      if (
        state.supportSession.status !== 'idle' &&
        state.supportSession.status !== 'ended'
      ) {
        return state
      }

      return addEvent(
        {
          ...state,
          supportRequest: createProblemRequest(),
          notice: null,
          lastSessionOutcome: null,
        },
        action.type,
        '困りごとの記録を始めた',
      )
    }

    case 'CANCEL_SUPPORT_REQUEST': {
      if (state.supportRequest?.status !== 'draft') return state

      const wasFallback = state.supportRequest.source === 'guideFallback'
      return addEvent(
        {
          ...state,
          supportRequest: null,
          guideRun: wasFallback
            ? { ...state.guideRun, status: 'running' }
            : state.guideRun,
        },
        action.type,
        '困りごとの記録をやめた',
      )
    }

    case 'SET_REQUEST_COMMENT':
      if (state.supportRequest?.status !== 'draft') return state
      return {
        ...state,
        supportRequest: { ...state.supportRequest, comment: action.comment },
      }

    case 'SUBMIT_SUPPORT_REQUEST':
      if (state.supportRequest?.status !== 'draft') return state
      return addEvent(
        {
          ...state,
          supportRequest: { ...state.supportRequest, status: 'matching' },
        },
        action.type,
        '似たガイドの確認を始めた',
      )

    case 'GUIDE_MATCH_FOUND': {
      if (state.supportRequest?.status !== 'matching') return state
      const guide = state.guides.find(
        (candidate) =>
          candidate.id === action.guideId && candidate.status === 'published',
      )
      if (!guide) return state

      return addEvent(
        {
          ...state,
          supportRequest: { ...state.supportRequest, status: 'closed' },
          guideRun: {
            guideId: guide.id,
            status: 'running',
            currentStepIndex: 0,
            entry: 'similarGuideMatch',
          },
          notice: {
            kind: 'similarGuideFound',
            message: '似たガイドが見つかりました。まずはこちらを見てみましょう。',
          },
        },
        action.type,
        `似たガイド「${guide.title}」が見つかった`,
      )
    }

    case 'GUIDE_MATCH_NOT_FOUND':
      if (state.supportRequest?.status !== 'matching') return state
      return addEvent(
        {
          ...state,
          supportRequest: { ...state.supportRequest, status: 'pending' },
        },
        action.type,
        '似たガイドがないため家族へ知らせた',
      )

    case 'VIEW_SUPPORT_REQUEST':
      if (state.supportRequest?.status !== 'pending') return state
      return addEvent(
        {
          ...state,
          supportRequest: { ...state.supportRequest, status: 'viewed' },
        },
        action.type,
        '家族が支援依頼を開いた',
      )

    case 'SET_GRANDFATHER_ONLINE':
      return addEvent(
        {
          ...state,
          settings: {
            ...state.settings,
            grandfatherOnline: action.online,
          },
        },
        action.type,
        action.online ? '祖父をオンラインにした' : '祖父をオフラインにした',
      )

    case 'START_CALL':
      if (
        state.supportRequest?.status !== 'viewed' ||
        !state.settings.grandfatherOnline ||
        (state.supportSession.status !== 'idle' &&
          state.supportSession.status !== 'ended')
      ) {
        return state
      }
      return addEvent(
        {
          ...state,
          supportSession: {
            ...state.supportSession,
            requestId: state.supportRequest.id,
            status: 'ringing',
            marker: null,
            mockCaptureCount: 0,
            mockCaptureTimes: [],
          },
        },
        action.type,
        '家族が電話をかけた',
      )

    case 'ACCEPT_CALL':
      if (state.supportSession.status !== 'ringing') return state
      return addEvent(
        {
          ...state,
          supportSession: { ...state.supportSession, status: 'connecting' },
        },
        action.type,
        '祖父が電話に出た',
      )

    case 'CONNECTION_ESTABLISHED':
      if (state.supportSession.status !== 'connecting') return state
      return addEvent(
        {
          ...state,
          supportSession: { ...state.supportSession, status: 'supporting' },
        },
        action.type,
        '家族との支援を開始した',
      )

    case 'PLACE_MARKER':
      if (state.supportSession.status !== 'supporting') return state
      return addEvent(
        {
          ...state,
          supportSession: {
            ...state.supportSession,
            marker: {
              xRatio: clamp(action.xRatio),
              yRatio: clamp(action.yRatio),
              createdAt: logicalTime(state.eventSequence + 1),
            },
          },
        },
        action.type,
        '家族が見る場所を示した',
      )

    case 'MOCK_CAPTURE_TICK': {
      if (state.supportSession.status !== 'supporting') return state
      const nextCount = state.supportSession.mockCaptureCount + 1
      const elapsedSeconds = nextCount * 5
      const captureMinute = 20 + Math.floor(elapsedSeconds / 60)
      const captureSecond = elapsedSeconds % 60
      const captureTime = `10:${String(captureMinute).padStart(2, '0')}:${String(captureSecond).padStart(2, '0')}`
      return addEvent(
        {
          ...state,
          supportSession: {
            ...state.supportSession,
            mockCaptureCount: nextCount,
            mockCaptureTimes: [
              ...state.supportSession.mockCaptureTimes,
              captureTime,
            ],
          },
        },
        action.type,
        `支援内容を記録した（${nextCount}件）`,
      )
    }

    case 'FINISH_PROBLEM_SOLVING':
      if (
        state.supportSession.status !== 'supporting' ||
        state.supportSession.mockCaptureCount < 1
      ) {
        return state
      }
      return addEvent(
        {
          ...state,
          supportSession: {
            ...state.supportSession,
            status: 'guideDecision',
            marker: null,
          },
        },
        action.type,
        '問題を解決した',
      )

    case 'CHOOSE_SKIP_GUIDE':
      if (state.supportSession.status !== 'guideDecision') return state
      return addEvent(
        {
          ...state,
          supportRequest: state.supportRequest
            ? { ...state.supportRequest, status: 'closed' }
            : null,
          supportSession: {
            ...state.supportSession,
            status: 'ended',
            marker: null,
          },
          notice: {
            kind: 'supportEnded',
            message: '支援を終了しました。',
          },
          guideRun: {
            guideId: null,
            status: 'idle',
            currentStepIndex: 0,
            entry: null,
          },
          remoteSupportConfirmationOpen: false,
          lastSessionOutcome: 'supportEnded',
        },
        action.type,
        'ガイドを作らず支援を終了した',
      )

    case 'CHOOSE_CREATE_GUIDE':
      if (state.supportSession.status !== 'guideDecision') return state
      return addEvent(
        {
          ...state,
          supportSession: {
            ...state.supportSession,
            status: 'guideGenerating',
          },
        },
        action.type,
        'ガイドの準備を始めた',
      )

    case 'GUIDE_DRAFT_GENERATED':
      if (state.supportSession.status !== 'guideGenerating') return state
      return addEvent(
        {
          ...state,
          draftGuide: createDraftGuide(state.supportSession.requestId),
          reviewStepIndex: 0,
          supportSession: { ...state.supportSession, status: 'guideReview' },
        },
        action.type,
        '固定テンプレートから仮ガイドを作った',
      )

    case 'UPDATE_GUIDE_TITLE':
      if (state.supportSession.status !== 'guideReview' || !state.draftGuide) {
        return state
      }
      return addEvent(
        {
          ...state,
          draftGuide: { ...state.draftGuide, title: action.title },
        },
        action.type,
        '家族がガイドのタイトルを編集した',
      )

    case 'UPDATE_GUIDE_STEP': {
      if (state.supportSession.status !== 'guideReview' || !state.draftGuide) {
        return state
      }
      const steps = state.draftGuide.steps.map((step, index) =>
        index === state.reviewStepIndex
          ? { ...step, instruction: action.instruction }
          : step,
      )
      return addEvent(
        {
          ...state,
          draftGuide: { ...state.draftGuide, steps },
        },
        action.type,
        `家族が手順${state.reviewStepIndex + 1}を編集した`,
      )
    }

    case 'GO_TO_GUIDE_REVIEW_STEP': {
      if (state.supportSession.status !== 'guideReview' || !state.draftGuide) {
        return state
      }
      const delta = action.direction === 'next' ? 1 : -1
      const nextIndex = Math.min(
        state.draftGuide.steps.length - 1,
        Math.max(0, state.reviewStepIndex + delta),
      )
      if (nextIndex === state.reviewStepIndex) return state
      return addEvent(
        { ...state, reviewStepIndex: nextIndex },
        action.type,
        `ガイドレビューの手順${nextIndex + 1}へ移動した`,
      )
    }

    case 'SAVE_GUIDE': {
      if (state.supportSession.status !== 'guideReview' || !state.draftGuide) {
        return state
      }
      const publishedGuide: Guide = { ...state.draftGuide, status: 'published' }
      return addEvent(
        {
          ...state,
          supportRequest: state.supportRequest
            ? { ...state.supportRequest, status: 'closed' }
            : null,
          supportSession: {
            ...state.supportSession,
            status: 'ended',
            marker: null,
          },
          guides: replaceOrAppendGuide(state.guides, publishedGuide),
          draftGuide: null,
          notice: {
            kind: 'guideSaved',
            message: 'ガイドを保存しました。次から「ガイドを見る」で使えます。',
            guideId: publishedGuide.id,
          },
          guideRun: {
            guideId: null,
            status: 'idle',
            currentStepIndex: 0,
            entry: null,
          },
          remoteSupportConfirmationOpen: false,
          lastSessionOutcome: 'guideSaved',
        },
        action.type,
        `ガイド「${publishedGuide.title}」を保存した`,
      )
    }

    case 'OPEN_GUIDE_LIST':
      if (
        state.supportSession.status !== 'idle' &&
        state.supportSession.status !== 'ended'
      ) {
        return state
      }
      return addEvent(
        {
          ...state,
          guideRun: {
            guideId: null,
            status: 'browsing',
            currentStepIndex: 0,
            entry: 'guideList',
          },
          notice: null,
        },
        action.type,
        '保存済みガイドの一覧を開いた',
      )

    case 'CLOSE_GUIDE_LIST':
      if (state.guideRun.status !== 'browsing') return state
      return addEvent(
        {
          ...state,
          guideRun: {
            guideId: null,
            status: 'idle',
            currentStepIndex: 0,
            entry: null,
          },
        },
        action.type,
        'ガイド一覧を閉じた',
      )

    case 'SELECT_GUIDE': {
      const guide = state.guides.find(
        (candidate) =>
          candidate.id === action.guideId && candidate.status === 'published',
      )
      if (state.guideRun.status !== 'browsing' || !guide) return state
      return addEvent(
        {
          ...state,
          guideRun: {
            guideId: guide.id,
            status: 'running',
            currentStepIndex: 0,
            entry: 'guideList',
          },
        },
        action.type,
        `ガイド「${guide.title}」を開始した`,
      )
    }

    case 'GO_TO_NEXT_GUIDE_STEP': {
      if (state.guideRun.status !== 'running') return state
      const guide = activeGuide(state)
      if (!guide) return state
      const nextIndex = Math.min(
        guide.steps.length - 1,
        state.guideRun.currentStepIndex + 1,
      )
      if (nextIndex === state.guideRun.currentStepIndex) return state
      return addEvent(
        {
          ...state,
          guideRun: { ...state.guideRun, currentStepIndex: nextIndex },
          notice: null,
        },
        action.type,
        `ガイドの手順${nextIndex + 1}へ進んだ`,
      )
    }

    case 'GO_TO_PREVIOUS_GUIDE_STEP': {
      if (state.guideRun.status !== 'running') return state
      const nextIndex = Math.max(0, state.guideRun.currentStepIndex - 1)
      if (nextIndex === state.guideRun.currentStepIndex) return state
      return addEvent(
        {
          ...state,
          guideRun: { ...state.guideRun, currentStepIndex: nextIndex },
          notice: null,
        },
        action.type,
        `ガイドの手順${nextIndex + 1}へ戻った`,
      )
    }

    case 'COMPLETE_GUIDE': {
      if (state.guideRun.status !== 'running') return state
      const guide = activeGuide(state)
      if (
        !guide ||
        state.guideRun.currentStepIndex !== guide.steps.length - 1
      ) {
        return state
      }
      return addEvent(
        {
          ...state,
          guideRun: { ...state.guideRun, status: 'completed' },
          notice: null,
        },
        action.type,
        'ガイドを最後まで完了した',
      )
    }

    case 'CLOSE_COMPLETED_GUIDE':
      if (state.guideRun.status !== 'completed') return state
      return addEvent(
        {
          ...state,
          guideRun: {
            guideId: null,
            status: 'idle',
            currentStepIndex: 0,
            entry: null,
          },
        },
        action.type,
        'ガイドを閉じて通常画面へ戻った',
      )

    case 'OPEN_REMOTE_SUPPORT_CONFIRMATION':
      if (state.guideRun.status !== 'running') return state
      return addEvent(
        { ...state, remoteSupportConfirmationOpen: true },
        action.type,
        '家族への相談確認を開いた',
      )

    case 'CANCEL_REMOTE_SUPPORT_CONFIRMATION':
      if (!state.remoteSupportConfirmationOpen) return state
      return addEvent(
        { ...state, remoteSupportConfirmationOpen: false },
        action.type,
        '家族への相談を取りやめた',
      )

    case 'REQUEST_REMOTE_SUPPORT_FROM_GUIDE': {
      if (
        state.guideRun.status !== 'running' ||
        !state.remoteSupportConfirmationOpen
      ) {
        return state
      }
      const guide = activeGuide(state)
      if (!guide) return state
      const step = guide.steps[state.guideRun.currentStepIndex]
      const stepNumber = state.guideRun.currentStepIndex + 1
      const request: SupportRequest = {
        id: 'request-guide-fallback',
        createdAt: FIXED_REQUEST_CREATED_AT,
        screenshotId: step.imageId,
        comment: `「${guide.title}」の手順${stepNumber}で分からなくなりました`,
        status: 'draft',
        source: 'guideFallback',
        guideContext: {
          guideId: guide.id,
          guideTitle: guide.title,
          stepNumber,
        },
      }
      return addEvent(
        {
          ...state,
          supportRequest: request,
          guideRun: { ...state.guideRun, status: 'fallback' },
          remoteSupportConfirmationOpen: false,
          notice: null,
        },
        action.type,
        `ガイドの手順${stepNumber}から家族への相談に切り替えた`,
      )
    }

    case 'DISMISS_NOTICE':
      return { ...state, notice: null }

    case 'SET_MATCH_MODE':
      return addEvent(
        {
          ...state,
          settings: { ...state.settings, matchMode: action.matchMode },
        },
        action.type,
        action.matchMode === 'match'
          ? '類似ガイドを「あり」にした'
          : '類似ガイドを「なし」にした',
      )

    case 'SET_FAST_MODE':
      return addEvent(
        {
          ...state,
          settings: { ...state.settings, fastMode: action.fastMode },
        },
        action.type,
        action.fastMode ? '待ち時間を短くした' : '標準の待ち時間にした',
      )

    case 'SET_SCENARIO':
      return createInitialState(action.scenario)

    case 'RESET_DEMO':
      return createInitialState(state.settings.scenario)
  }
}
