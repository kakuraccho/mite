export const SESSION_STATUSES = [
  'idle',
  'requestDraft',
  'requestSent',
  'waitingForFamily',
  'familyViewingRequest',
  'incomingCall',
  'connecting',
  'inSession',
  'guideDecision',
  'guideDraft',
  'guideReview',
  'completed',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const sessionStatusLabels: Record<SessionStatus, string> = {
  idle: '待機中',
  requestDraft: '困りごとを記録中',
  requestSent: '支援依頼を送信済み',
  waitingForFamily: '家族の確認待ち',
  familyViewingRequest: '家族が依頼を確認中',
  incomingCall: '家族から着信中',
  connecting: '家族と接続中',
  inSession: '支援中',
  guideDecision: 'ガイドを作るか確認中',
  guideDraft: 'ガイド作成中',
  guideReview: 'ガイド確認中',
  completed: '支援終了',
};

export const DEMO_REQUEST_COMMENT =
  '番号は分かったけれど、飛行機の画面に戻れません';

export const DEMO_GUIDE = {
  title: '認証コードを確認したあと、元の画面へ戻る',
  steps: [
    '画面下のタスクバーを見ます。',
    '飛行機の購入画面のアイコンを押します。',
    '元の画面に戻ったら、控えた番号を入力します。',
  ],
} as const;

export const DEMO_REQUEST_CREATED_AT = '2026-08-29T10:15:00+09:00';

export interface SupportRequest {
  id: string;
  comment: string;
  createdAt: string;
  screenshotId: 'mock-email-screen';
}

/** Shared-screen coordinates normalized to the inclusive 0..1 range. */
export interface Marker {
  x: number;
  y: number;
  createdAt: string;
}

export interface Guide {
  title: string;
  steps: string[];
}

export type SessionEvent =
  | { type: 'OPEN_REQUEST_PANEL' }
  | { type: 'UPDATE_REQUEST_COMMENT'; comment: string }
  | {
      type: 'SUBMIT_SUPPORT_REQUEST';
      comment?: string;
      createdAt?: string;
    }
  | { type: 'DELIVER_SUPPORT_REQUEST' }
  | { type: 'VIEW_SUPPORT_REQUEST' }
  | { type: 'START_CALL' }
  | { type: 'ACCEPT_CALL' }
  | { type: 'CONNECTION_ESTABLISHED' }
  | {
      type: 'PLACE_MARKER';
      x: number;
      y: number;
      createdAt?: string;
    }
  | { type: 'END_SUPPORT' }
  | { type: 'CHOOSE_CREATE_GUIDE' }
  | { type: 'CHOOSE_SKIP_GUIDE' }
  | { type: 'UPDATE_GUIDE_TITLE'; title: string }
  | { type: 'UPDATE_GUIDE_STEP'; index: number; text: string }
  | { type: 'BEGIN_GUIDE_REVIEW' }
  | { type: 'SAVE_GUIDE' }
  | { type: 'RESET_DEMO' };

export type SessionEventType = SessionEvent['type'];

export const SESSION_EVENT_TYPES = [
  'OPEN_REQUEST_PANEL',
  'UPDATE_REQUEST_COMMENT',
  'SUBMIT_SUPPORT_REQUEST',
  'DELIVER_SUPPORT_REQUEST',
  'VIEW_SUPPORT_REQUEST',
  'START_CALL',
  'ACCEPT_CALL',
  'CONNECTION_ESTABLISHED',
  'PLACE_MARKER',
  'END_SUPPORT',
  'CHOOSE_CREATE_GUIDE',
  'CHOOSE_SKIP_GUIDE',
  'UPDATE_GUIDE_TITLE',
  'UPDATE_GUIDE_STEP',
  'BEGIN_GUIDE_REVIEW',
  'SAVE_GUIDE',
  'RESET_DEMO',
] as const satisfies readonly SessionEventType[];

export interface SessionState {
  status: SessionStatus;
  requestComment: string;
  request: SupportRequest | null;
  grandfatherOnline: boolean;
  marker: Marker | null;
  guide: Guide | null;
  lastEvent: SessionEventType | null;
  eventLog: SessionEventType[];
}

export function createInitialSessionState(): SessionState {
  return {
    status: 'idle',
    requestComment: DEMO_REQUEST_COMMENT,
    request: null,
    grandfatherOnline: true,
    marker: null,
    guide: null,
    lastEvent: null,
    eventLog: [],
  };
}

export const initialSessionState: SessionState = createInitialSessionState();

function acceptEvent(
  state: SessionState,
  event: SessionEvent,
  changes: Partial<SessionState> = {},
): SessionState {
  return {
    ...state,
    ...changes,
    lastEvent: event.type,
    eventLog: [...state.eventLog, event.type].slice(-12),
  };
}

function isNormalizedCoordinate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function sessionReducer(
  state: SessionState,
  event: SessionEvent,
): SessionState {
  if (event.type === 'RESET_DEMO') {
    return {
      ...createInitialSessionState(),
      lastEvent: event.type,
      eventLog: [event.type],
    };
  }

  switch (event.type) {
    case 'OPEN_REQUEST_PANEL':
      return state.status === 'idle'
        ? acceptEvent(state, event, { status: 'requestDraft' })
        : state;

    case 'UPDATE_REQUEST_COMMENT':
      return state.status === 'requestDraft'
        ? acceptEvent(state, event, { requestComment: event.comment })
        : state;

    case 'SUBMIT_SUPPORT_REQUEST': {
      if (state.status !== 'requestDraft') return state;

      const comment = event.comment ?? state.requestComment;
      const createdAt = event.createdAt ?? DEMO_REQUEST_CREATED_AT;

      return acceptEvent(state, event, {
        status: 'requestSent',
        requestComment: comment,
        request: {
          id: 'demo-support-request',
          comment,
          createdAt,
          screenshotId: 'mock-email-screen',
        },
      });
    }

    case 'DELIVER_SUPPORT_REQUEST':
      return state.status === 'requestSent'
        ? acceptEvent(state, event, { status: 'waitingForFamily' })
        : state;

    case 'VIEW_SUPPORT_REQUEST':
      return state.status === 'waitingForFamily'
        ? acceptEvent(state, event, { status: 'familyViewingRequest' })
        : state;

    case 'START_CALL':
      return state.status === 'familyViewingRequest'
        ? acceptEvent(state, event, { status: 'incomingCall' })
        : state;

    case 'ACCEPT_CALL':
      return state.status === 'incomingCall'
        ? acceptEvent(state, event, { status: 'connecting' })
        : state;

    case 'CONNECTION_ESTABLISHED':
      return state.status === 'connecting'
        ? acceptEvent(state, event, { status: 'inSession' })
        : state;

    case 'PLACE_MARKER':
      if (
        state.status !== 'inSession' ||
        !isNormalizedCoordinate(event.x) ||
        !isNormalizedCoordinate(event.y)
      ) {
        return state;
      }

      return acceptEvent(state, event, {
        marker: {
          x: event.x,
          y: event.y,
          createdAt: event.createdAt ?? DEMO_REQUEST_CREATED_AT,
        },
      });

    case 'END_SUPPORT':
      return state.status === 'inSession'
        ? acceptEvent(state, event, {
            status: 'guideDecision',
            marker: null,
          })
        : state;

    case 'CHOOSE_CREATE_GUIDE':
      return state.status === 'guideDecision'
        ? acceptEvent(state, event, {
            status: 'guideDraft',
            guide: {
              title: DEMO_GUIDE.title,
              steps: [...DEMO_GUIDE.steps],
            },
          })
        : state;

    case 'CHOOSE_SKIP_GUIDE':
      return state.status === 'guideDecision'
        ? acceptEvent(state, event, { status: 'completed' })
        : state;

    case 'UPDATE_GUIDE_TITLE':
      return state.status === 'guideDraft' && state.guide
        ? acceptEvent(state, event, {
            guide: { ...state.guide, title: event.title },
          })
        : state;

    case 'UPDATE_GUIDE_STEP': {
      if (
        state.status !== 'guideDraft' ||
        !state.guide ||
        !Number.isInteger(event.index) ||
        event.index < 0 ||
        event.index >= state.guide.steps.length
      ) {
        return state;
      }

      const steps = [...state.guide.steps];
      steps[event.index] = event.text;
      return acceptEvent(state, event, {
        guide: { ...state.guide, steps },
      });
    }

    case 'BEGIN_GUIDE_REVIEW':
      return state.status === 'guideDraft'
        ? acceptEvent(state, event, { status: 'guideReview' })
        : state;

    case 'SAVE_GUIDE':
      return state.status === 'guideReview'
        ? acceptEvent(state, event, { status: 'completed' })
        : state;
  }
}
