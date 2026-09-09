import type * as LiveKit from 'livekit-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Room, RoomEvent, Track } from 'livekit-client'
import {
  encodeGuidanceMessage,
  MITE_GUIDANCE_TOPIC,
  encodeMarkingMessage,
  MITE_MARKING_TOPIC,
} from '@mite/client-core'
import type { LiveKitConnectionInfo } from '@mite/client-api'
import { LiveKitUserMediaSession, type UserMediaCallbacks } from './livekit'

const meter = vi.hoisted(() => ({
  track: null as { isMuted: boolean } | null,
  calculateVolume: vi.fn(() => 0.72),
  cleanup: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('livekit-client', async (importOriginal) => {
  const original = await importOriginal<typeof LiveKit>()
  return {
    ...original,
    createAudioAnalyser: vi.fn(() => ({
      calculateVolume: meter.calculateVolume,
      cleanup: meter.cleanup,
    })),
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
          getTrackPublication: vi.fn(() =>
            meter.track ? { audioTrack: meter.track } : undefined,
          ),
          setMicrophoneEnabled: vi.fn(async (enabled) => {
            if (meter.track) meter.track.isMuted = !enabled
          }),
          setScreenShareEnabled: vi
            .fn()
            .mockResolvedValue({ trackSid: 'TR_current' }),
        },
      }
    }),
  }
})

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  meter.track = null
})

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
        { identity: 'family:demo', sid: 'PA_family' },
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

it('rejects non-family, wrong-track, duplicate and old guidance; clears on reconnect, stop and participant disconnect', async () => {
  const session = new LiveKitUserMediaSession()
  const callbacks: UserMediaCallbacks = {
    onStateChange: vi.fn(),
    onMarking: vi.fn(),
    onGuidance: vi.fn(),
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
  const room = vi.mocked(Room).mock.results[0]!.value as Room & {
    dispatch(event: string, ...args: unknown[]): void
  }
  const receive = (
    sequence: number,
    identity = 'family:demo',
    trackSid = 'TR_current',
  ) =>
    room.dispatch(
      RoomEvent.DataReceived,
      encodeGuidanceMessage({
        type: 'guidance.set',
        sequence,
        trackSid,
        mode: 'KEYBOARD',
        keys: ['Ctrl', 'C'],
        buttons: 0,
        x: 0.5,
        y: 0.5,
        ttlMs: 2000,
        sentAt: new Date().toISOString(),
      }),
      { identity, sid: 'PA_family' },
      undefined,
      MITE_GUIDANCE_TOPIC,
    )
  receive(1, 'user:demo')
  receive(1, 'family:demo', 'TR_old')
  expect(callbacks.onGuidance).not.toHaveBeenCalled()
  receive(2)
  receive(2)
  receive(1)
  expect(callbacks.onGuidance).toHaveBeenCalledOnce()
  room.dispatch(RoomEvent.Reconnecting)
  expect(callbacks.onGuidance).toHaveBeenLastCalledWith(null)
  room.dispatch(RoomEvent.Reconnected)
  receive(3)
  expect(callbacks.onGuidance).toHaveBeenLastCalledWith(
    expect.objectContaining({ sequence: 3 }),
  )
  room.dispatch(RoomEvent.ParticipantDisconnected, {
    identity: 'family:demo',
    sid: 'PA_family',
  })
  expect(callbacks.onGuidance).toHaveBeenLastCalledWith(null)
  expect(callbacks.onMarking).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: 'mark.clear' }),
  )
  await session.stopScreenShare()
  receive(4)
  expect(callbacks.onGuidance).toHaveBeenLastCalledWith(null)
  await session.disconnect()
  receive(5)
  expect(callbacks.onGuidance).toHaveBeenLastCalledWith(null)
})

it('meters the local microphone, resets on mute/reconnecting and cleans up on disconnect', async () => {
  vi.useFakeTimers()
  meter.track = { isMuted: false }
  const session = new LiveKitUserMediaSession()
  const callbacks: UserMediaCallbacks = {
    onStateChange: vi.fn(),
    onMarking: vi.fn(),
    onAudioLevel: vi.fn(),
    onLocalAudioLevel: vi.fn(),
    onScreenShareStopped: vi.fn(),
  }
  await session.connect(
    {
      serverUrl: 'wss://example.invalid',
      token: 'test',
    } as LiveKitConnectionInfo,
    callbacks,
  )
  await vi.advanceTimersByTimeAsync(100)
  expect(callbacks.onLocalAudioLevel).toHaveBeenLastCalledWith(0.72)
  expect(callbacks.onAudioLevel).not.toHaveBeenCalled()
  await session.setMicrophoneEnabled(false)
  expect(callbacks.onLocalAudioLevel).toHaveBeenLastCalledWith(0)
  await session.setMicrophoneEnabled(true)
  const room = vi.mocked(Room).mock.results[0]!.value as Room & {
    dispatch(event: string): void
  }
  room.dispatch(RoomEvent.Reconnecting)
  expect(callbacks.onLocalAudioLevel).toHaveBeenLastCalledWith(0)
  room.dispatch(RoomEvent.Reconnected)
  await vi.advanceTimersByTimeAsync(100)
  expect(callbacks.onLocalAudioLevel).toHaveBeenLastCalledWith(0.72)
  await session.disconnect()
  expect(callbacks.onLocalAudioLevel).toHaveBeenLastCalledWith(0)
  expect(meter.cleanup).toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
