import {
  BrowserWindow,
  screen,
  type Display,
  type IpcMainEvent,
} from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkingOverlay } from './marking-overlay'

vi.mock('electron', () => ({
  screen: { getPrimaryDisplay: vi.fn() },
  BrowserWindow: vi.fn(function () {
    return {
      webContents: {
        mainFrame: { url: 'mite-user://app/index.html?view=marking' },
        on: vi.fn(),
        send: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      },
      once: vi.fn(),
      loadURL: vi.fn().mockResolvedValue(undefined),
      setIgnoreMouseEvents: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setContentProtection: vi.fn(),
      setBounds: vi.fn(),
      showInactive: vi.fn(),
      hide: vi.fn(),
      destroy: vi.fn(),
      isDestroyed: vi.fn(() => false),
    }
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.mocked(screen.getPrimaryDisplay).mockReturnValue({
    bounds: { x: -1920, y: 100, width: 1920, height: 1080 },
    workArea: { x: -1916, y: 100, width: 1916, height: 1040 },
  } as Display)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const ready = (overlay: MarkingOverlay) =>
  overlay.rendererReady({
    sender: overlay.window.webContents,
    senderFrame: overlay.window.webContents.mainFrame,
  } as IpcMainEvent)
const mark = (id = 'mark_01', ttl = 2000) => ({
  id,
  x: 0.42,
  y: 0.31,
  expiresAt: Date.now() + ttl,
})

describe('MarkingOverlay', () => {
  it('covers the primary screen including the taskbar without taking input or appearing in captures', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const overlay = new MarkingOverlay(
      'mite-user://app/index.html?view=marking',
      '/marking-preload.js',
    )
    expect(BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        x: -1920,
        y: 100,
        width: 1920,
        height: 1080,
        focusable: false,
        transparent: true,
        show: false,
        skipTaskbar: true,
        autoHideMenuBar: true,
        webPreferences: expect.objectContaining({
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        }),
      }),
    )
    expect(overlay.window.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
    expect(overlay.window.setContentProtection).toHaveBeenCalledWith(true)
    overlay.dispose()
  })

  it('delivers queued positions after readiness and expires marks even if the control renderer stops responding', () => {
    const overlay = new MarkingOverlay(
      'mite-user://app/index.html?view=marking',
      '/marking-preload.js',
    )
    const first = mark()
    overlay.setMarks([first])
    expect(overlay.window.showInactive).not.toHaveBeenCalled()
    ready(overlay)
    expect(overlay.window.webContents.send).toHaveBeenLastCalledWith(
      'marking:changed',
      [first],
    )
    expect(overlay.window.showInactive).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(2000)
    expect(overlay.window.webContents.send).toHaveBeenLastCalledWith(
      'marking:changed',
      [],
    )
    expect(overlay.window.hide).toHaveBeenCalled()
    overlay.dispose()
  })

  it('replaces a mark with the same id, clears on stop and refreshes display bounds', () => {
    const overlay = new MarkingOverlay(
      'mite-user://app/index.html?view=marking',
      '/marking-preload.js',
    )
    ready(overlay)
    overlay.setMarks([mark()])
    vi.advanceTimersByTime(1000)
    const replacement = { ...mark(), x: 0.8 }
    overlay.setMarks([replacement])
    vi.advanceTimersByTime(1000)
    expect(overlay.window.webContents.send).toHaveBeenLastCalledWith(
      'marking:changed',
      [replacement],
    )
    overlay.setMarks([])
    expect(overlay.window.webContents.send).toHaveBeenLastCalledWith(
      'marking:changed',
      [],
    )
    overlay.setMarks([mark()])
    overlay.refresh()
    expect(overlay.window.setBounds).toHaveBeenCalledWith(
      screen.getPrimaryDisplay().bounds,
      false,
    )
    expect(overlay.window.webContents.send).toHaveBeenLastCalledWith(
      'marking:changed',
      [],
    )
    overlay.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects malformed positions and ignores readiness from other renderers', () => {
    const overlay = new MarkingOverlay(
      'mite-user://app/index.html?view=marking',
      '/marking-preload.js',
    )
    for (const invalid of [
      null,
      [{}],
      [{ ...mark(), x: 1.1 }],
      [{ ...mark(), y: NaN }],
    ]) {
      expect(() => overlay.setMarks(invalid)).toThrow(
        'Invalid marking positions',
      )
    }
    overlay.setMarks([mark()])
    overlay.rendererReady({
      sender: {},
      senderFrame: overlay.window.webContents.mainFrame,
    } as IpcMainEvent)
    expect(overlay.window.showInactive).not.toHaveBeenCalled()
    overlay.dispose()
  })
})

it('keeps the native window visible across movement and heartbeats, then hides when updates stop', () => {
  const overlay = new MarkingOverlay(
    'mite-user://app/index.html?view=marking',
    '/marking-preload.js',
  )
  ready(overlay)
  for (let i = 0; i < 8; i++) {
    overlay.setMarks([])
    overlay.setGuidance({
      mode: 'CURSOR_MOUSE',
      x: i / 10,
      y: 0.5,
      buttons: 1,
      keys: [],
      expiresAt: Date.now() + 2000,
    })
    vi.advanceTimersByTime(500)
  }
  expect(overlay.window.showInactive).toHaveBeenCalledOnce()
  expect(overlay.window.hide).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1500)
  expect(overlay.window.hide).toHaveBeenCalledOnce()
  overlay.dispose()
})

it('expires pressed guidance independently of the hidden main renderer and clears on geometry changes', () => {
  const overlay = new MarkingOverlay(
    'mite-user://app/index.html?view=marking',
    '/marking-preload.js',
  )
  ready(overlay)
  const guidance = {
    mode: 'CURSOR_MOUSE',
    x: 0.25,
    y: 0.75,
    buttons: 1,
    keys: [],
    expiresAt: Date.now() + 2000,
  }
  overlay.setMarks([mark()])
  overlay.setGuidance(guidance)
  expect(overlay.window.webContents.send).toHaveBeenCalledWith(
    'guidance:changed',
    guidance,
  )
  expect(overlay.window.webContents.send).toHaveBeenLastCalledWith(
    'marking:changed',
    [],
  )
  expect(overlay.window.showInactive).toHaveBeenCalled()
  vi.advanceTimersByTime(1999)
  expect(overlay.window.webContents.send).toHaveBeenCalledWith(
    'guidance:changed',
    guidance,
  )
  vi.advanceTimersByTime(1)
  expect(overlay.window.webContents.send).toHaveBeenCalledWith(
    'guidance:changed',
    null,
  )
  overlay.setGuidance({ ...guidance, expiresAt: Date.now() + 2000 })
  overlay.refresh()
  expect(overlay.window.webContents.send).toHaveBeenCalledWith(
    'guidance:changed',
    null,
  )
  expect(() => overlay.setGuidance({ ...guidance, buttons: 8 })).toThrow(
    'Invalid guidance',
  )
  overlay.dispose()
  expect(vi.getTimerCount()).toBe(0)
})
