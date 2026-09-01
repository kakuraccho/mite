import type {
  AppState,
  Guide,
  MockScreenId,
  ScenarioId,
  SupportSession,
} from './types'

export const GRANDFATHER = {
  id: 'grandfather-1',
  displayName: 'おじいちゃん',
} as const

export const FAMILY = {
  id: 'family-1',
  displayName: '家族',
} as const

export const FIXED_REQUEST_CREATED_AT = '2026-08-24T10:15:00+09:00'

export const PRIMARY_GUIDE: Guide = {
  id: 'guide-auth-code',
  title: '認証コードを確認したあと、元の画面へ戻る',
  coverImageId: 'mock-mail-screen',
  status: 'published',
  steps: [
    {
      id: 'auth-step-1',
      imageId: 'mock-mail-screen',
      instruction: '画面下のタスクバーを見ます。',
    },
    {
      id: 'auth-step-2',
      imageId: 'mock-taskbar-screen',
      instruction: '飛行機の購入画面のアイコンを押します。',
    },
    {
      id: 'auth-step-3',
      imageId: 'mock-purchase-screen',
      instruction: '元の画面に戻ったら、控えた番号を入力します。',
    },
  ],
}

export const SECONDARY_GUIDE: Guide = {
  id: 'guide-text-size',
  title: '画面の文字を大きくして読む',
  coverImageId: 'mock-text-size-screen',
  status: 'published',
  steps: [
    {
      id: 'text-step-1',
      imageId: 'mock-text-size-screen',
      instruction: '画面右上の「文字サイズ」を見つけます。',
    },
    {
      id: 'text-step-2',
      imageId: 'mock-text-size-screen',
      instruction: '「大きくする」を1回押します。',
    },
  ],
}

export const SCENARIO_DESCRIPTIONS: Record<
  ScenarioId,
  { title: string; summary: string }
> = {
  A: {
    title: '支援してガイドを作る',
    summary: '困りごとの記録から家族の支援、ガイド保存まで進めます。',
  },
  B: {
    title: '似たガイドで解決する',
    summary: '困りごとの記録後、見つかったガイドを使います。',
  },
  C: {
    title: '一覧からガイドを使う',
    summary: '保存済みガイドを選び、1ステップずつ進めます。',
  },
  D: {
    title: 'ガイド途中で家族に相談する',
    summary: 'ガイドから遠隔支援の依頼へ切り替えます。',
  },
}

const initialGuides = (scenario: ScenarioId): Guide[] =>
  scenario === 'A'
    ? [structuredClone(SECONDARY_GUIDE)]
    : [structuredClone(PRIMARY_GUIDE), structuredClone(SECONDARY_GUIDE)]

const createIdleSession = (): SupportSession => ({
  id: 'session-auth-code',
  requestId: '',
  status: 'idle',
  marker: null,
  mockCaptureCount: 0,
  mockCaptureTimes: [],
})

export const createDraftGuide = (requestId: string): Guide => ({
  ...structuredClone(PRIMARY_GUIDE),
  id: 'guide-auth-code-created',
  status: 'draft',
  createdFromRequestId: requestId,
  steps: PRIMARY_GUIDE.steps.map((step, index) => ({
    ...step,
    id: `created-step-${index + 1}`,
  })),
})

export const getScenarioDefaults = (scenario: ScenarioId) => ({
  scenario,
  matchMode: scenario === 'B' ? ('match' as const) : ('no-match' as const),
  grandfatherOnline: true,
  fastMode: true,
})

export const createInitialState = (scenario: ScenarioId = 'A'): AppState => ({
  settings: getScenarioDefaults(scenario),
  supportRequest: null,
  supportSession: createIdleSession(),
  guides: initialGuides(scenario),
  draftGuide: null,
  guideRun: {
    guideId: null,
    status: 'idle',
    currentStepIndex: 0,
    entry: null,
  },
  reviewStepIndex: 0,
  remoteSupportConfirmationOpen: false,
  notice: null,
  lastSessionOutcome: null,
  eventLog: [
    {
      id: 0,
      event: 'DEMO_READY',
      label: `Scenario ${scenario} を開始`,
      logicalTime: 'T+00秒',
    },
  ],
  eventSequence: 0,
})

export const getScreenForCapture = (count: number): MockScreenId => {
  if (count <= 1) return 'mock-mail-screen'
  if (count === 2) return 'mock-taskbar-screen'
  return 'mock-purchase-screen'
}
