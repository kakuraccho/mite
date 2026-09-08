import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ScreenShare } from './ScreenShare'
import type { FamilyLiveSupport, LiveSupportSnapshot } from './live-support'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const live: LiveSupportSnapshot = {
  connectionStatus: 'CONNECTED',
  microphoneEnabled: true,
  audioPlaybackBlocked: false,
  screenTrackSid: 'TR_screen',
  receivedAudioLevel: 0,
  localAudioLevel: 0.4,
  errorMessage: null,
}
const support = () =>
  ({
    attachScreen: vi.fn(),
    sendGuidance: vi.fn().mockResolvedValue(undefined),
    sendMark: vi.fn().mockResolvedValue(undefined),
    clearMarks: vi.fn().mockResolvedValue(undefined),
  }) as unknown as FamilyLiveSupport

it('shows a real Ctrl+C chord, repeats held keys, and clears on key release, mode change and disconnect', async () => {
  vi.useFakeTimers()
  const media = support(),
    onError = vi.fn()
  const { rerender, unmount } = render(
    <ScreenShare liveSupport={media} live={live} onError={onError} />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'キーボード' }))
  const stage = screen.getByRole('group', { name: /共有画面。/ })
  fireEvent.keyDown(stage, {
    code: 'ControlLeft',
    key: 'Control',
    ctrlKey: true,
  })
  fireEvent.keyDown(stage, { code: 'KeyC', key: 'c', ctrlKey: true })
  expect(media.sendGuidance).toHaveBeenLastCalledWith(
    expect.objectContaining({
      keys: ['Ctrl', 'C'],
      buttons: 0,
      mode: 'KEYBOARD',
    }),
  )
  const count = vi.mocked(media.sendGuidance).mock.calls.length
  await act(async () => vi.advanceTimersByTimeAsync(2500))
  expect(vi.mocked(media.sendGuidance).mock.calls.length).toBe(count + 5)
  fireEvent.keyUp(stage, { code: 'KeyC', key: 'c', ctrlKey: true })
  expect(media.sendGuidance).toHaveBeenLastCalledWith(
    expect.objectContaining({ keys: ['Ctrl'] }),
  )
  fireEvent.keyUp(stage, { code: 'ControlLeft', key: 'Control' })
  expect(media.sendGuidance).toHaveBeenLastCalledWith(null)
  fireEvent.keyDown(stage, { code: 'Escape', key: 'Escape' })
  expect(media.sendGuidance).toHaveBeenLastCalledWith(
    expect.objectContaining({ keys: ['Esc'] }),
  )
  fireEvent.keyUp(stage, { code: 'Escape', key: 'Escape' })
  fireEvent.keyDown(stage, { code: 'KeyA', key: 'a' })
  fireEvent.click(screen.getByRole('button', { name: '丸' }))
  expect(media.sendGuidance).toHaveBeenLastCalledWith(null)
  expect(media.clearMarks).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'キーボード' }))
  fireEvent.keyDown(stage, { code: 'KeyB', key: 'b' })
  rerender(
    <ScreenShare
      liveSupport={media}
      live={{ ...live, connectionStatus: 'RECONNECTING' }}
      onError={onError}
    />,
  )
  expect(media.sendGuidance).toHaveBeenLastCalledWith(null)
  const stoppedCount = vi.mocked(media.sendGuidance).mock.calls.length
  await act(async () => vi.advanceTimersByTimeAsync(2500))
  expect(vi.mocked(media.sendGuidance).mock.calls.length).toBe(stoppedCount)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('maps a letterboxed video, carries pressed buttons through a drag, and clears on focus loss or share stop', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('PointerEvent', MouseEvent)
  const media = support(),
    onError = vi.fn()
  const { container, rerender } = render(
    <ScreenShare liveSupport={media} live={live} onError={onError} />,
  )
  const video = container.querySelector('video')!
  Object.defineProperties(video, {
    videoWidth: { value: 1920 },
    videoHeight: { value: 1080 },
  })
  vi.spyOn(video, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    top: 50,
    width: 800,
    height: 600,
  } as DOMRect)
  const stage = screen.getByRole('group', { name: /共有画面。/ })
  stage.setPointerCapture = vi.fn()
  stage.hasPointerCapture = vi.fn(() => true)
  fireEvent.click(screen.getByRole('button', { name: 'カーソルとマウス' }))
  fireEvent.pointerDown(stage, { clientX: 500, clientY: 350, buttons: 1 })
  expect(media.sendGuidance).toHaveBeenLastCalledWith({
    mode: 'CURSOR_MOUSE',
    x: 0.5,
    y: 0.5,
    buttons: 1,
    keys: [],
  })
  fireEvent.pointerMove(stage, { clientX: 700, clientY: 350, buttons: 1 })
  expect(media.sendGuidance).toHaveBeenLastCalledWith(
    expect.objectContaining({ x: 0.75, buttons: 1 }),
  )
  await act(async () => vi.advanceTimersByTimeAsync(2500))
  expect(media.sendGuidance).toHaveBeenLastCalledWith(
    expect.objectContaining({ x: 0.75, buttons: 1 }),
  )
  fireEvent.pointerUp(stage, { clientX: 700, clientY: 350, buttons: 0 })
  expect(media.sendGuidance).toHaveBeenLastCalledWith(
    expect.objectContaining({ buttons: 0 }),
  )
  fireEvent.pointerMove(stage, { clientX: 500, clientY: 60, buttons: 0 })
  expect(media.sendGuidance).toHaveBeenLastCalledWith(null)
  fireEvent.pointerMove(stage, { clientX: 500, clientY: 350, buttons: 2 })
  fireEvent(window, new Event('blur'))
  expect(media.sendGuidance).toHaveBeenLastCalledWith(null)
  fireEvent.pointerMove(stage, { clientX: 500, clientY: 350, buttons: 1 })
  rerender(
    <ScreenShare
      liveSupport={media}
      live={{ ...live, screenTrackSid: null }}
      onError={onError}
    />,
  )
  expect(media.sendGuidance).toHaveBeenLastCalledWith(null)
})
