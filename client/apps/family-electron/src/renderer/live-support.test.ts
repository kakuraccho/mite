import type * as LiveKit from 'livekit-client'
import { Room, RoomEvent } from 'livekit-client'
import { afterEach, expect, it, vi } from 'vitest'
import { decodeGuidanceMessage, MITE_GUIDANCE_TOPIC } from '@mite/client-core'
import type { LiveKitConnectionInfo } from '@mite/client-api'
import { LiveKitFamilySupport } from './live-support'

const microphone = vi.hoisted(() => ({ isMuted: false }))
const cleanup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('livekit-client', async (importOriginal) => {
  const original = await importOriginal<typeof LiveKit>()
  return {
    ...original,
    createAudioAnalyser: vi.fn(() => ({
      calculateVolume: () => 0.64,
      cleanup,
    })),
    Room: vi.fn(function () {
      const handlers = new Map<string, (...args: unknown[]) => void>()
      return {
        on: (event: string, fn: (...args: unknown[]) => void) =>
          handlers.set(event, fn),
        dispatch: (event: string, ...args: unknown[]) =>
          handlers.get(event)?.(...args),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        canPlaybackAudio: true,
        localParticipant: {
          getTrackPublication: () => ({ audioTrack: microphone }),
          setMicrophoneEnabled: vi.fn(async (enabled) => {
            microphone.isMuted = !enabled
          }),
          publishData: vi.fn().mockResolvedValue(undefined),
        },
      }
    }),
  }
})
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('meters the family microphone and sends bounded guidance for the subscribed screen on a reliable topic', async () => {
  vi.useFakeTimers()
  const media = new LiveKitFamilySupport()
  await media.connect({
    serverUrl: 'wss://example.invalid',
    token: 'test',
  } as LiveKitConnectionInfo)
  const room = vi.mocked(Room).mock.results[0]!.value as Room & {
    dispatch(event: string, ...args: unknown[]): void
  }
  await vi.advanceTimersByTimeAsync(100)
  expect(media.getSnapshot().localAudioLevel).toBe(0.64)
  expect(media.getSnapshot().receivedAudioLevel).toBe(0)
  await media.setMicrophoneEnabled(false)
  expect(media.getSnapshot().localAudioLevel).toBe(0)
  await media.setMicrophoneEnabled(true)
  room.dispatch(
    RoomEvent.TrackSubscribed,
    { kind: 'video', attach: vi.fn(), detach: vi.fn() },
    { source: 'screen_share', trackSid: 'TR_screen' },
    { identity: 'user:demo' },
  )
  await media.sendGuidance({
    mode: 'CURSOR_MOUSE',
    buttons: 1,
    keys: [],
    x: 0.4,
    y: 0.2,
  })
  await media.sendGuidance(null)
  const calls = vi.mocked(room.localParticipant.publishData).mock.calls
  expect(calls[0]?.[1]).toEqual({ reliable: true, topic: MITE_GUIDANCE_TOPIC })
  expect(decodeGuidanceMessage(calls[0]![0])).toMatchObject({
    type: 'guidance.set',
    buttons: 1,
    sequence: 1,
    trackSid: 'TR_screen',
    ttlMs: 2000,
  })
  expect(decodeGuidanceMessage(calls[1]![0])).toMatchObject({
    type: 'guidance.clear',
    sequence: 2,
  })
  room.dispatch(RoomEvent.Reconnecting)
  expect(media.getSnapshot().localAudioLevel).toBe(0)
  await media.sendGuidance({
    mode: 'KEYBOARD',
    buttons: 0,
    keys: ['Ctrl', 'C'],
    x: 0.5,
    y: 0.5,
  })
  expect(calls).toHaveLength(2)
  room.dispatch(RoomEvent.Reconnected)
  await vi.advanceTimersByTimeAsync(100)
  expect(media.getSnapshot().localAudioLevel).toBe(0.64)
  await media.disconnect()
  expect(media.getSnapshot().localAudioLevel).toBe(0)
  expect(cleanup).toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not overwrite a newer connection when an older disconnect finishes late', async () => {
  vi.useFakeTimers()
  const media = new LiveKitFamilySupport()
  const info = {
    serverUrl: 'wss://example.invalid',
    token: 'test',
  } as LiveKitConnectionInfo
  await media.connect(info)
  const previous = vi.mocked(Room).mock.results[0]!.value as Room
  let finish!: () => void
  vi.mocked(previous.disconnect).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const stopping = media.disconnect()
  await media.connect(info)
  expect(media.getSnapshot().connectionStatus).toBe('CONNECTED')
  finish()
  await stopping
  expect(media.getSnapshot().connectionStatus).toBe('CONNECTED')
  await media.disconnect()
  expect(vi.getTimerCount()).toBe(0)
})
