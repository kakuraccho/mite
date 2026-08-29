import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type PropsWithChildren,
} from 'react'
import {
  SESSION_EVENT_TYPES,
  SESSION_STATUSES,
  createInitialSessionState,
  sessionReducer,
  type SessionEvent,
  type SessionState,
} from '../domain/session'

const STATE_STORAGE_KEY = 'mite-prototype:session-state'
const EVENT_STORAGE_KEY = 'mite-prototype:session-event'
const CHANNEL_NAME = 'mite-prototype:session-events'
const STORAGE_VERSION = 1

interface EventEnvelope {
  version: typeof STORAGE_VERSION
  id: string
  sender: string
  event: SessionEvent
}

interface StoredStateEnvelope {
  version: typeof STORAGE_VERSION
  state: SessionState
}

interface SessionContextValue {
  state: SessionState
  dispatch: Dispatch<SessionEvent>
}

const SessionContext = createContext<SessionContextValue | null>(null)

function isStoredSessionState(value: unknown): value is SessionState {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SessionState>

  const hasValidRequest =
    candidate.request === null ||
    (typeof candidate.request === 'object' &&
      typeof candidate.request.id === 'string' &&
      typeof candidate.request.comment === 'string' &&
      typeof candidate.request.createdAt === 'string' &&
      candidate.request.screenshotId === 'mock-email-screen')
  const hasValidMarker =
    candidate.marker === null ||
    (typeof candidate.marker === 'object' &&
      typeof candidate.marker.x === 'number' &&
      typeof candidate.marker.y === 'number' &&
      typeof candidate.marker.createdAt === 'string')
  const hasValidGuide =
    candidate.guide === null ||
    (typeof candidate.guide === 'object' &&
      typeof candidate.guide.title === 'string' &&
      Array.isArray(candidate.guide.steps) &&
      candidate.guide.steps.every((step) => typeof step === 'string'))
  const hasValidLastEvent =
    candidate.lastEvent === null ||
    (typeof candidate.lastEvent === 'string' &&
      SESSION_EVENT_TYPES.includes(
        candidate.lastEvent as (typeof SESSION_EVENT_TYPES)[number],
      ))

  return (
    typeof candidate.status === 'string' &&
    SESSION_STATUSES.includes(
      candidate.status as (typeof SESSION_STATUSES)[number],
    ) &&
    typeof candidate.requestComment === 'string' &&
    typeof candidate.grandfatherOnline === 'boolean' &&
    hasValidRequest &&
    hasValidMarker &&
    hasValidGuide &&
    hasValidLastEvent &&
    Array.isArray(candidate.eventLog) &&
    candidate.eventLog.every(
      (eventName) =>
        typeof eventName === 'string' &&
        SESSION_EVENT_TYPES.includes(
          eventName as (typeof SESSION_EVENT_TYPES)[number],
        ),
    ) &&
    (!['requestSent', 'waitingForFamily', 'familyViewingRequest', 'incomingCall', 'connecting', 'inSession', 'guideDecision', 'guideDraft', 'guideReview', 'completed'].includes(
      candidate.status ?? '',
    ) || candidate.request !== null) &&
    (!['guideDraft', 'guideReview'].includes(candidate.status ?? '') ||
      candidate.guide !== null)
  )
}

function isSessionEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== 'object' || !('type' in value)) return false
  const candidate = value as Record<string, unknown>

  if (
    typeof candidate.type !== 'string' ||
    !SESSION_EVENT_TYPES.includes(
      candidate.type as (typeof SESSION_EVENT_TYPES)[number],
    )
  ) {
    return false
  }

  switch (candidate.type) {
    case 'UPDATE_REQUEST_COMMENT':
      return typeof candidate.comment === 'string'
    case 'SUBMIT_SUPPORT_REQUEST':
      return (
        (candidate.comment === undefined ||
          typeof candidate.comment === 'string') &&
        (candidate.createdAt === undefined ||
          typeof candidate.createdAt === 'string')
      )
    case 'PLACE_MARKER':
      return (
        typeof candidate.x === 'number' &&
        typeof candidate.y === 'number' &&
        (candidate.createdAt === undefined ||
          typeof candidate.createdAt === 'string')
      )
    case 'UPDATE_GUIDE_TITLE':
      return typeof candidate.title === 'string'
    case 'UPDATE_GUIDE_STEP':
      return (
        typeof candidate.index === 'number' && typeof candidate.text === 'string'
      )
    default:
      return true
  }
}

function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<EventEnvelope>
  return (
    candidate.version === STORAGE_VERSION &&
    typeof candidate.id === 'string' &&
    typeof candidate.sender === 'string' &&
    isSessionEvent(candidate.event)
  )
}

function loadStoredState(): SessionState {
  try {
    const stored = window.localStorage.getItem(STATE_STORAGE_KEY)
    if (!stored) return createInitialSessionState()

    const parsed = JSON.parse(stored) as Partial<StoredStateEnvelope>
    return parsed.version === STORAGE_VERSION && isStoredSessionState(parsed.state)
      ? parsed.state
      : createInitialSessionState()
  } catch {
    return createInitialSessionState()
  }
}

function createMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

export function SessionProvider({ children }: PropsWithChildren) {
  const [state, applyEvent] = useReducer(
    sessionReducer,
    undefined,
    loadStoredState,
  )
  const senderId = useRef(createMessageId())
  const channelRef = useRef<BroadcastChannel | null>(null)
  const receivedEventIds = useRef(new Set<string>())

  useEffect(() => {
    const storedState: StoredStateEnvelope = {
      version: STORAGE_VERSION,
      state,
    }
    window.localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(storedState))
  }, [state])

  useEffect(() => {
    const onStorage = (storageEvent: StorageEvent) => {
      if (storageEvent.key !== EVENT_STORAGE_KEY || !storageEvent.newValue) {
        return
      }

      try {
        const envelope: unknown = JSON.parse(storageEvent.newValue)
        if (
          isEventEnvelope(envelope) &&
          envelope.sender !== senderId.current &&
          !receivedEventIds.current.has(envelope.id)
        ) {
          receivedEventIds.current.add(envelope.id)
          applyEvent(envelope.event)
        }
      } catch {
        // A malformed prototype message is ignored; no external data is involved.
      }
    }

    if (typeof globalThis.BroadcastChannel === 'function') {
      const channel = new BroadcastChannel(CHANNEL_NAME)
      channel.onmessage = (message: MessageEvent<unknown>) => {
        if (
          isEventEnvelope(message.data) &&
          message.data.sender !== senderId.current &&
          !receivedEventIds.current.has(message.data.id)
        ) {
          receivedEventIds.current.add(message.data.id)
          applyEvent(message.data.event)
        }
      }
      channelRef.current = channel
    } else {
      window.addEventListener('storage', onStorage)
    }

    return () => {
      channelRef.current?.close()
      channelRef.current = null
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const dispatch = useCallback((event: SessionEvent) => {
    applyEvent(event)

    const envelope: EventEnvelope = {
      version: STORAGE_VERSION,
      id: createMessageId(),
      sender: senderId.current,
      event,
    }

    if (channelRef.current) {
      channelRef.current.postMessage(envelope)
    } else {
      window.localStorage.setItem(EVENT_STORAGE_KEY, JSON.stringify(envelope))
    }
  }, [])

  const contextValue = useMemo(
    () => ({ state, dispatch }),
    [dispatch, state],
  )

  return (
    <SessionContext.Provider value={contextValue}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext)

  if (!context) {
    throw new Error('useSession must be used inside SessionProvider')
  }

  return context
}
