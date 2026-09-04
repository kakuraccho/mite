import type { MiteEvent, MiteEventType } from './types'

export type EventConnectionStatus =
  'CONNECTING' | 'AUTHENTICATING' | 'CONNECTED' | 'DISCONNECTED'

export interface MiteEventStreamOptions {
  apiBaseUrl: string
  token: string
  onEvent: (event: MiteEvent) => void
  onStatusChange?: (status: EventConnectionStatus) => void
  webSocketFactory?: (url: string) => WebSocket
}

const reconnectDelays = [1_000, 2_000, 5_000, 10_000] as const
const eventTypes = new Set<MiteEventType>([
  'supportRequest.created',
  'supportRequest.updated',
  'supportSession.created',
  'supportSession.updated',
  'guideMaterialBatch.created',
  'guideMaterialBatch.updated',
  'guideGenerationJob.created',
  'guideGenerationJob.updated',
  'guideDraft.created',
  'guideDraft.updated',
  'guide.created',
  'guideRun.created',
  'guideRun.updated',
])

const eventUrlFromApi = (apiBaseUrl: string) => {
  const url = new URL('/v1/events', apiBaseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

const isMiteEvent = (value: unknown): value is MiteEvent => {
  if (!value || typeof value !== 'object') return false
  return (
    'eventId' in value &&
    typeof value.eventId === 'string' &&
    'type' in value &&
    typeof value.type === 'string' &&
    eventTypes.has(value.type as MiteEventType) &&
    'entityId' in value &&
    typeof value.entityId === 'string' &&
    'revision' in value &&
    Number.isInteger(value.revision) &&
    (value.revision as number) >= 1 &&
    'occurredAt' in value &&
    typeof value.occurredAt === 'string' &&
    'data' in value
  )
}

export class MiteEventStream {
  readonly #options: MiteEventStreamOptions
  #socket: WebSocket | null = null
  #retryTimer: ReturnType<typeof setTimeout> | null = null
  #retryAttempt = 0
  #stopped = true
  #authenticated = false
  #seenEventIds = new Set<string>()

  constructor(options: MiteEventStreamOptions) {
    this.#options = options
  }

  start() {
    if (!this.#stopped) return
    this.#stopped = false
    this.#connect()
  }

  stop() {
    this.#stopped = true
    this.#authenticated = false
    if (this.#retryTimer) clearTimeout(this.#retryTimer)
    this.#retryTimer = null
    this.#socket?.close()
    this.#socket = null
    this.#options.onStatusChange?.('DISCONNECTED')
  }

  #connect() {
    if (this.#stopped) return
    this.#options.onStatusChange?.('CONNECTING')
    const factory =
      this.#options.webSocketFactory ?? ((url) => new WebSocket(url))
    const socket = factory(eventUrlFromApi(this.#options.apiBaseUrl))
    this.#socket = socket
    this.#authenticated = false
    this.#seenEventIds = new Set()

    socket.addEventListener('open', () => {
      this.#options.onStatusChange?.('AUTHENTICATING')
      socket.send(
        JSON.stringify({ type: 'authenticate', token: this.#options.token }),
      )
    })

    socket.addEventListener('message', (message) => {
      let value: unknown
      try {
        value = JSON.parse(String(message.data)) as unknown
      } catch {
        return
      }

      if (
        value &&
        typeof value === 'object' &&
        'type' in value &&
        value.type === 'authenticated'
      ) {
        this.#authenticated = true
        this.#retryAttempt = 0
        this.#options.onStatusChange?.('CONNECTED')
        return
      }

      if (!this.#authenticated || !isMiteEvent(value)) return
      if (this.#seenEventIds.has(value.eventId)) return
      this.#seenEventIds.add(value.eventId)
      this.#options.onEvent(value)
    })

    socket.addEventListener('close', () => {
      if (this.#socket === socket) this.#socket = null
      this.#authenticated = false
      this.#options.onStatusChange?.('DISCONNECTED')
      this.#scheduleReconnect()
    })

    socket.addEventListener('error', () => {
      socket.close()
    })
  }

  #scheduleReconnect() {
    if (this.#stopped || this.#retryTimer) return
    const delay =
      reconnectDelays[Math.min(this.#retryAttempt, reconnectDelays.length - 1)]
    this.#retryAttempt += 1
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      this.#connect()
    }, delay)
  }
}
