import type * as LiveKit from 'livekit-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Room, RoomEvent, Track } from 'livekit-client'
import { encodeMarkingMessage, MITE_MARKING_TOPIC } from '@mite/client-core'
import type { LiveKitConnectionInfo } from '@mite/client-api'
import { LiveKitUserMediaSession, type UserMediaCallbacks } from './livekit'

vi.mock('livekit-client', async (importOriginal) => {
  const original = await importOriginal<typeof LiveKit>()
  return {
    ...original,
    Room: vi.fn(function () {
      const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
      return {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          handlers.set(event, [...(handlers.get(event) ?? []), handler])
        },
        dispatch: (event: string, ...args: unknown[]) => {
          for (const handler of handlers.get(event) ?? []) handler(...args)
        },
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        localParticipant: {
          setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
          setScreenShareEnabled: vi
            .fn()
            .mockResolvedValue({ trackSid: 'TR_current' }),
        },
      }
    }),
  }
})

afterEach(() => vi.clearAllMocks())

describe('LiveKitUserMediaSession marking reception', () => {
  it('accepts the family packet format only for the current topic and screen track, including after republishing', async () => {
    const session = new LiveKitUserMediaSession()
    const callbacks: UserMediaCallbacks = {
      onStateChange: vi.fn(),
      onMarking: vi.fn(),
      onAudioLevel: vi.fn(),
      onScreenShareStopped: vi.fn(),
    }
    await session.connect(
      {
        serverUrl: 'wss://example.invalid',
        token: 'test',
      } as LiveKitConnectionInfo,
      callbacks,
    )
    const room = vi.mocked(Room).mock.results[0]?.value as Room & {
      dispatch(event: string, ...args: unknown[]): void
    }
    const packet = (trackSid: string) =>
      encodeMarkingMessage({
        type: 'mark.set',
        markId: 'mark_01',
        trackSid,
        x: 0.42,
        y: 0.31,
        shape: 'CIRCLE',
        ttlMs: 2000,
        sentAt: new Date().toISOString(),
      })
    const receive = (trackSid: string, topic = MITE_MARKING_TOPIC) => {
      room.dispatch(
        RoomEvent.DataReceived,
        packet(trackSid),
        undefined,
        undefined,
        topic,
      )
    }
    receive('TR_old')
    receive('TR_current', 'another-topic')
    expect(callbacks.onMarking).not.toHaveBeenCalled()
    receive('TR_current')
    expect(callbacks.onMarking).toHaveBeenCalledOnce()
    room.dispatch(RoomEvent.LocalTrackUnpublished, {
      source: Track.Source.ScreenShare,
    })
    receive('TR_current')
    expect(callbacks.onMarking).toHaveBeenCalledOnce()
    expect(callbacks.onScreenShareStopped).toHaveBeenCalledOnce()
    vi.mocked(room.localParticipant.setScreenShareEnabled).mockResolvedValue({
      trackSid: 'TR_new',
    } as never)
    await session.startScreenShare()
    receive('TR_current')
    receive('TR_new')
    expect(callbacks.onMarking).toHaveBeenCalledTimes(2)
    await session.disconnect()
    receive('TR_new')
    expect(callbacks.onMarking).toHaveBeenCalledTimes(2)
  })
})
