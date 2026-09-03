import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import {
  decodeNativeWindowHandle,
  WindowsAppBarAdapter,
  type WindowsAppBarNativeBinding,
} from './windows-appbar'

const display = { x: 0, y: 0, width: 1_920, height: 1_080 }
const reserved = { x: 0, y: 0, width: 4, height: 1_040 }

const makeWindow = () => {
  let callback: ((wParam: Buffer, lParam: Buffer) => void) | undefined
  const window = {
    getNativeWindowHandle: vi.fn(() => {
      const handle = Buffer.alloc(8)
      handle.writeBigUInt64LE(123n)
      return handle
    }),
    hookWindowMessage: vi.fn(
      (_message: number, next: (wParam: Buffer, lParam: Buffer) => void) => {
        callback = next
      },
    ),
    isWindowMessageHooked: vi.fn(() => true),
    unhookWindowMessage: vi.fn(),
  } as unknown as BrowserWindow
  return { window, callback: () => callback }
}

const makeNative = (): WindowsAppBarNativeBinding => ({
  register: vi.fn(),
  position: vi.fn(() => reserved),
  remove: vi.fn(),
})

describe('WindowsAppBarAdapter', () => {
  it('registers one HWND, keeps the reservation at four pixels, and removes it', () => {
    const native = makeNative()
    const fixture = makeWindow()
    const adapter = new WindowsAppBarAdapter(native)

    expect(adapter.reserve(fixture.window, display, 4)).toEqual(reserved)
    expect(adapter.reserve(fixture.window, display, 4)).toEqual(reserved)
    expect(native.register).toHaveBeenCalledOnce()
    expect(native.position).toHaveBeenCalledTimes(2)

    adapter.release(fixture.window)
    expect(native.remove).toHaveBeenCalledWith(123n)
    expect(fixture.window.unhookWindowMessage).toHaveBeenCalledOnce()
  })

  it('repositions after an AppBar position notification', async () => {
    const native = makeNative()
    const fixture = makeWindow()
    const adapter = new WindowsAppBarAdapter(native)
    adapter.reserve(fixture.window, display, 4)
    const wParam = Buffer.alloc(8)
    wParam.writeUInt32LE(1)

    fixture.callback()?.(wParam, Buffer.alloc(8))
    await Promise.resolve()

    expect(native.position).toHaveBeenCalledTimes(2)
  })

  it('decodes 32-bit and 64-bit native handles', () => {
    const handle32 = Buffer.alloc(4)
    handle32.writeUInt32LE(42)
    const handle64 = Buffer.alloc(8)
    handle64.writeBigUInt64LE(4_294_967_297n)

    expect(decodeNativeWindowHandle(handle32)).toBe(42n)
    expect(decodeNativeWindowHandle(handle64)).toBe(4_294_967_297n)
  })

  it('converts Electron DIP coordinates at the Windows boundary', () => {
    const native = makeNative()
    vi.mocked(native.position).mockReturnValue({
      x: 0,
      y: 60,
      width: 6,
      height: 1_500,
    })
    const fixture = makeWindow()
    const adapter = new WindowsAppBarAdapter(native, {
      dipToScreenRect: (_window, bounds) => ({
        x: Math.round(bounds.x * 1.5),
        y: Math.round(bounds.y * 1.5),
        width: Math.round(bounds.width * 1.5),
        height: Math.round(bounds.height * 1.5),
      }),
      screenToDipRect: (_window, bounds) => ({
        x: Math.round(bounds.x / 1.5),
        y: Math.round(bounds.y / 1.5),
        width: Math.round(bounds.width / 1.5),
        height: Math.round(bounds.height / 1.5),
      }),
    })

    expect(adapter.reserve(fixture.window, display, 4)).toEqual({
      x: 0,
      y: 40,
      width: 4,
      height: 1_000,
    })
    expect(native.position).toHaveBeenCalledWith(
      123n,
      { x: 0, y: 0, width: 2_880, height: 1_620 },
      6,
    )
  })

  it('unregisters when initial positioning fails', () => {
    const native = makeNative()
    vi.mocked(native.position).mockImplementation(() => {
      throw new Error('position failed')
    })
    const fixture = makeWindow()
    const adapter = new WindowsAppBarAdapter(native)

    expect(() => adapter.reserve(fixture.window, display, 4)).toThrow(
      'position failed',
    )
    expect(native.remove).toHaveBeenCalledWith(123n)
    expect(fixture.window.unhookWindowMessage).toHaveBeenCalledOnce()
  })
})
