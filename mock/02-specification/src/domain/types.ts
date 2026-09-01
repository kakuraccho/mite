export type ScenarioId = 'A' | 'B' | 'C' | 'D'

export type MockScreenId =
  | 'mock-mail-screen'
  | 'mock-taskbar-screen'
  | 'mock-purchase-screen'
  | 'mock-text-size-screen'

export interface SupportRequestGuideContext {
  guideId: string
  guideTitle: string
  stepNumber: number
}

export interface SupportRequest {
  id: string
  createdAt: string
  screenshotId: MockScreenId
  comment: string
  status: 'draft' | 'matching' | 'pending' | 'viewed' | 'closed'
  source: 'problem' | 'guideFallback'
  guideContext?: SupportRequestGuideContext
}

export interface Marker {
  xRatio: number
  yRatio: number
  createdAt: string
}

export interface SupportSession {
  id: string
  requestId: string
  status:
    | 'idle'
    | 'ringing'
    | 'connecting'
    | 'supporting'
    | 'guideDecision'
    | 'guideGenerating'
    | 'guideReview'
    | 'ended'
  marker: Marker | null
  mockCaptureCount: number
  mockCaptureTimes: string[]
}

export interface GuideStep {
  id: string
  imageId: MockScreenId
  instruction: string
}

export interface Guide {
  id: string
  title: string
  coverImageId: MockScreenId
  steps: GuideStep[]
  status: 'draft' | 'published'
  createdFromRequestId?: string
}

export interface GuideRun {
  guideId: string | null
  status: 'idle' | 'browsing' | 'running' | 'completed' | 'fallback'
  currentStepIndex: number
  entry: 'guideList' | 'similarGuideMatch' | null
}

export interface DemoSettings {
  scenario: ScenarioId
  matchMode: 'match' | 'no-match'
  grandfatherOnline: boolean
  fastMode: boolean
}

export interface DemoEvent {
  id: number
  event: string
  label: string
  logicalTime: string
}

export type AppNotice =
  | { kind: 'similarGuideFound'; message: string }
  | { kind: 'guideSaved'; message: string; guideId: string }
  | { kind: 'supportEnded'; message: string }
  | null

export interface AppState {
  settings: DemoSettings
  supportRequest: SupportRequest | null
  supportSession: SupportSession
  guides: Guide[]
  draftGuide: Guide | null
  guideRun: GuideRun
  reviewStepIndex: number
  remoteSupportConfirmationOpen: boolean
  notice: AppNotice
  lastSessionOutcome: 'guideSaved' | 'supportEnded' | null
  eventLog: DemoEvent[]
  eventSequence: number
}

export type AppAction =
  | { type: 'OPEN_EDGE_PANEL' }
  | { type: 'START_SUPPORT_REQUEST' }
  | { type: 'CANCEL_SUPPORT_REQUEST' }
  | { type: 'SET_REQUEST_COMMENT'; comment: string }
  | { type: 'SUBMIT_SUPPORT_REQUEST' }
  | { type: 'GUIDE_MATCH_FOUND'; guideId: string }
  | { type: 'GUIDE_MATCH_NOT_FOUND' }
  | { type: 'VIEW_SUPPORT_REQUEST' }
  | { type: 'SET_GRANDFATHER_ONLINE'; online: boolean }
  | { type: 'START_CALL' }
  | { type: 'ACCEPT_CALL' }
  | { type: 'CONNECTION_ESTABLISHED' }
  | { type: 'PLACE_MARKER'; xRatio: number; yRatio: number }
  | { type: 'MOCK_CAPTURE_TICK' }
  | { type: 'FINISH_PROBLEM_SOLVING' }
  | { type: 'CHOOSE_CREATE_GUIDE' }
  | { type: 'CHOOSE_SKIP_GUIDE' }
  | { type: 'GUIDE_DRAFT_GENERATED' }
  | { type: 'UPDATE_GUIDE_TITLE'; title: string }
  | { type: 'UPDATE_GUIDE_STEP'; instruction: string }
  | { type: 'GO_TO_GUIDE_REVIEW_STEP'; direction: 'previous' | 'next' }
  | { type: 'SAVE_GUIDE' }
  | { type: 'OPEN_GUIDE_LIST' }
  | { type: 'CLOSE_GUIDE_LIST' }
  | { type: 'SELECT_GUIDE'; guideId: string }
  | { type: 'GO_TO_NEXT_GUIDE_STEP' }
  | { type: 'GO_TO_PREVIOUS_GUIDE_STEP' }
  | { type: 'COMPLETE_GUIDE' }
  | { type: 'CLOSE_COMPLETED_GUIDE' }
  | { type: 'OPEN_REMOTE_SUPPORT_CONFIRMATION' }
  | { type: 'CANCEL_REMOTE_SUPPORT_CONFIRMATION' }
  | { type: 'REQUEST_REMOTE_SUPPORT_FROM_GUIDE' }
  | { type: 'DISMISS_NOTICE' }
  | { type: 'SET_MATCH_MODE'; matchMode: DemoSettings['matchMode'] }
  | { type: 'SET_FAST_MODE'; fastMode: boolean }
  | { type: 'SET_SCENARIO'; scenario: ScenarioId }
  | { type: 'RESET_DEMO' }
