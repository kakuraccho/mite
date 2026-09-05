import { afterEach, describe, expect, it, vi } from 'vitest'
import { MiteEventStream } from './events'
import type { MiteEvent } from './types'

type SocketListener = (event: Event) => void

const fakeSocket = () => {
  const listeners = new Map<string, SocketListener[]>()
  const socket = {
    addEventListener: vi.fn((type: string, listener: SocketListener) => {
      const current = listeners.get(type) ?? []
      listeners.set(type, [...current, listener])
    }),
    send: vi.fn(),
    close: vi.fn(),
  }

  return {
    socket: socket as unknown as WebSocket,
    sendEvent(type: string, event: Event) {
      for (const listener of listeners.get(type) ?? []) listener(event)
    },
  }
}

const message = (value: unknown) =>
  new MessageEvent('message', { data: JSON.stringify(value) })

const event: MiteEvent = {
  eventId: 'event_01',
  type: 'supportRequest.updated',
  occurredAt: '2026-09-03T00:00:00Z',
  entityId: 'request_01',
  revision: 2,
  data: { id: 'request_01' },
}

afterEach(() => {
  vi.useRealTimers()
})

describe('MiteEventStream', () => {
  it('認証完了前のイベントを無視し、同じeventIdを重複処理しない', () => {
    const transport = fakeSocket()
    const onEvent = vi.fn()
    const onStatusChange = vi.fn()
    const stream = new MiteEventStream({
      apiBaseUrl: 'https://api.example.test',
      token: 'demo-token',
      onEvent,
      onStatusChange,
      webSocketFactory: () => transport.socket,
    })

    stream.start()
    transport.sendEvent('open', new Event('open'))
    expect(transport.socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'authenticate', token: 'demo-token' }),
    )

    transport.sendEvent('message', message(event))
    expect(onEvent).not.toHaveBeenCalled()

    transport.sendEvent('message', message({ type: 'authenticated' }))
    transport.sendEvent(
      'message',
      message({ ...event, eventId: 'event_unknown', type: 'unknown.created' }),
    )
    transport.sendEvent('message', message(event))
    transport.sendEvent('message', message(event))

    expect(onEvent).toHaveBeenCalledOnce()
    expect(onEvent).toHaveBeenCalledWith(event)
    expect(onStatusChange).toHaveBeenCalledWith('CONNECTED')
    stream.stop()
  })

  it('切断後1秒で新しい接続を作る', async () => {
    vi.useFakeTimers()
    const first = fakeSocket()
    const second = fakeSocket()
    const sockets = [first.socket, second.socket]
    const factory = vi.fn(() => sockets.shift() ?? second.socket)
    const stream = new MiteEventStream({
      apiBaseUrl: 'http://127.0.0.1:8080',
      token: 'demo-token',
      onEvent: vi.fn(),
      webSocketFactory: factory,
    })

    stream.start()
    expect(factory).toHaveBeenNthCalledWith(1, 'ws://127.0.0.1:8080/v1/events')
    first.sendEvent('close', new Event('close'))
    await vi.advanceTimersByTimeAsync(999)
    expect(factory).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(factory).toHaveBeenCalledTimes(2)
    stream.stop()
  })
})
