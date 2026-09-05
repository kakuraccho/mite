import { describe, expect, it, vi } from 'vitest'
import {
  ShellAppBarNativeBinding,
  type ShellAppBarMessage,
} from './windows-appbar-native'

describe('ShellAppBarNativeBinding', () => {
  it('registers, negotiates a four-pixel left edge, and removes the AppBar', () => {
    const messages: number[] = []
    const sendMessage: ShellAppBarMessage = vi.fn((message, data) => {
      messages.push(message)
      if (message === 2) {
        data.rc.top = 40
        data.rc.bottom = 1_040
      }
      return 1n
    })
    const binding = new ShellAppBarNativeBinding(sendMessage, 48)

    binding.register(123n, 0x803a)
    expect(
      binding.position(123n, { x: 0, y: 0, width: 1_920, height: 1_080 }, 4),
    ).toEqual({
      x: 0,
      y: 40,
      width: 4,
      height: 1_000,
    })
    binding.remove(123n)

    expect(messages).toEqual([0, 2, 3, 1])
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      0,
      expect.objectContaining({
        cbSize: 48,
        hWnd: 123n,
        uCallbackMessage: 0x803a,
      }),
    )
    expect(sendMessage).toHaveBeenNthCalledWith(
      3,
      3,
      expect.objectContaining({
        uEdge: 0,
        rc: { left: 0, top: 40, right: 4, bottom: 1_040 },
      }),
    )
  })

  it('fails closed when Windows rejects registration or positioning', () => {
    const rejected = vi.fn(() => 0) as ShellAppBarMessage
    const binding = new ShellAppBarNativeBinding(rejected, 48)
    expect(() => binding.register(123n, 0x803a)).toThrow(
      'Windows AppBar registration failed',
    )

    const queryRejected = vi.fn((message: number) => (message === 0 ? 1 : 0))
    const queryBinding = new ShellAppBarNativeBinding(queryRejected, 48)
    expect(() =>
      queryBinding.position(
        123n,
        { x: 0, y: 0, width: 1_920, height: 1_080 },
        4,
      ),
    ).toThrow('Windows AppBar position query failed')
  })
})
