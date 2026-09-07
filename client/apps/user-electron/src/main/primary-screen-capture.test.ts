import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow, desktopCapturer, screen } from 'electron'
import type { DesktopCapturerSource, Display } from 'electron'
import { PrimaryScreenCapture } from './primary-screen-capture'
import { assertScreenCaptureAvailable } from './capture-environment'
import { wslScreenCaptureErrorCode } from '../shared/screen-capture-error'

vi.mock('./capture-environment', () => ({
  assertScreenCaptureAvailable: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  desktopCapturer: { getSources: vi.fn() },
  screen: { getPrimaryDisplay: vi.fn(() => ({ id: 42 })) },
}))

const source = (displayId: string, id = `screen:${displayId}:0`) => ({
  id,
  display_id: displayId,
  name: 'Screen',
  thumbnail: {
    isEmpty: vi.fn(() => false),
    getSize: vi.fn(() => ({ width: 1920, height: 1080 })),
    toDataURL: vi.fn(() => `data:image/jpeg;base64,${displayId}`),
    toJPEG: vi.fn(() => Buffer.from(displayId)),
    resize: vi.fn(),
  },
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(assertScreenCaptureAvailable).mockReset()
  vi.mocked(screen.getPrimaryDisplay).mockReturnValue({ id: 42 } as Display)
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])
})

afterEach(() => vi.useRealTimers())

describe('PrimaryScreenCapture', () => {
  it('rejects WSL before acquiring or hiding any screen, including sharing and periodic captures', async () => {
    vi.mocked(assertScreenCaptureAvailable).mockImplementation(() => {
      throw new Error(wslScreenCaptureErrorCode)
    })
    const capture = new PrimaryScreenCapture()
    await expect(capture.jpeg()).rejects.toThrow(wslScreenCaptureErrorCode)
    await expect(capture.prepareScreenShare()).rejects.toThrow(
      wslScreenCaptureErrorCode,
    )
    await expect(capture.jpeg(true)).rejects.toThrow(wslScreenCaptureErrorCode)
    await expect(capture.sharingSource()).rejects.toThrow(
      wslScreenCaptureErrorCode,
    )
    expect(desktopCapturer.getSources).not.toHaveBeenCalled()
    expect(BrowserWindow.getAllWindows).not.toHaveBeenCalled()
  })
  it('uses the primary display for previews, sharing and periodic images regardless of enumeration order', async () => {
    const secondary = source('7')
    const primary = source('42')
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([
      secondary,
      primary,
    ] as unknown as DesktopCapturerSource[])
    const capture = new PrimaryScreenCapture()

    expect(await capture.jpeg()).toEqual(Buffer.from('42'))
    expect(await capture.prepareScreenShare()).toEqual({
      name: '画面全体',
      thumbnailDataUrl: 'data:image/jpeg;base64,42',
    })
    expect(await capture.sharingSource()).toBe(primary)
    expect(await capture.jpeg(true)).toEqual(Buffer.from('42'))
    for (const [options] of vi.mocked(desktopCapturer.getSources).mock.calls) {
      expect(options.types).toEqual(['screen'])
    }
    expect(primary.thumbnail.toJPEG).toHaveBeenCalledWith(80)
    expect(secondary.thumbnail.toJPEG).not.toHaveBeenCalled()
    expect(desktopCapturer.getSources).toHaveBeenNthCalledWith(3, {
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    })
  })

  it.each([
    { sources: [] },
    { sources: [source('7')] },
    { sources: [source('')] },
  ])(
    'rejects unavailable or unidentified primary displays without substituting another source (%j)',
    async ({ sources }) => {
      vi.mocked(desktopCapturer.getSources).mockResolvedValue(
        sources as unknown as DesktopCapturerSource[],
      )
      const capture = new PrimaryScreenCapture()
      await expect(capture.jpeg()).rejects.toThrow('画面全体を取得できません')
      await expect(capture.prepareScreenShare()).rejects.toThrow(
        '画面全体を取得できません',
      )
      await expect(capture.sharingSource()).rejects.toThrow(
        '画面共有を始めてください',
      )
    },
  )

  it('does not let a consultation screenshot retarget an existing shared screen after a display change', async () => {
    const primary = source('42')
    const other = source('7')
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([
      primary,
      other,
    ] as unknown as DesktopCapturerSource[])
    const capture = new PrimaryScreenCapture()
    await capture.prepareScreenShare()
    vi.mocked(screen.getPrimaryDisplay).mockReturnValue({ id: 7 } as Display)
    expect(await capture.jpeg()).toEqual(Buffer.from('7'))
    await expect(capture.jpeg(true)).rejects.toThrow('画面の設定が変わりました')
    await expect(capture.sharingSource()).rejects.toThrow(
      '画面の設定が変わりました',
    )
    await capture.prepareScreenShare()
    expect(await capture.sharingSource()).toBe(other)
  })

  it('rejects a display change while sources are being enumerated', async () => {
    vi.mocked(desktopCapturer.getSources).mockImplementationOnce(async () => {
      vi.mocked(screen.getPrimaryDisplay).mockReturnValue({ id: 7 } as Display)
      return [source('42')] as unknown as DesktopCapturerSource[]
    })
    await expect(new PrimaryScreenCapture().jpeg()).rejects.toThrow(
      '画面全体を取得できません',
    )
  })

  it('rejects empty images and scales large images within 1920 by 1080 with the aspect ratio preserved', async () => {
    const primary = source('42')
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([
      primary,
    ] as unknown as DesktopCapturerSource[])
    const capture = new PrimaryScreenCapture()
    primary.thumbnail.isEmpty.mockReturnValueOnce(true)
    await expect(capture.jpeg()).rejects.toThrow('画面を取得できません')
    primary.thumbnail.getSize.mockReturnValue({ width: 2160, height: 3840 })
    const toJPEG = vi.fn(() => Buffer.from('resized'))
    primary.thumbnail.resize.mockReturnValue({ toJPEG })
    expect(await capture.jpeg()).toEqual(Buffer.from('resized'))
    expect(primary.thumbnail.resize).toHaveBeenCalledWith({
      width: 608,
      height: 1080,
      quality: 'best',
    })
    expect(toJPEG).toHaveBeenCalledWith(80)
  })

  it.skipIf(process.platform === 'win32')(
    'restores hidden development overlays even when acquisition fails',
    async () => {
      vi.useFakeTimers()
      const window = {
        isVisible: () => true,
        isDestroyed: () => false,
        hide: vi.fn(),
        showInactive: vi.fn(),
      }
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
        window,
      ] as unknown as BrowserWindow[])
      vi.mocked(desktopCapturer.getSources).mockRejectedValueOnce(
        new Error('unavailable'),
      )
      const pending = expect(new PrimaryScreenCapture().jpeg()).rejects.toThrow(
        'unavailable',
      )
      await vi.advanceTimersByTimeAsync(100)
      await pending
      expect(window.hide).toHaveBeenCalledOnce()
      expect(window.showInactive).toHaveBeenCalledOnce()
    },
  )
})
