import { createRequire } from 'node:module'
import type { OverlayRectangle } from '../shared/overlay'
import type { WindowsAppBarNativeBinding } from './windows-appbar'

const appBarNew = 0
const appBarRemove = 1
const appBarQueryPosition = 2
const appBarSetPosition = 3
const appBarEdgeLeft = 0

interface NativeRectangle {
  left: number
  top: number
  right: number
  bottom: number
}

interface AppBarData {
  cbSize: number
  hWnd: bigint
  uCallbackMessage: number
  uEdge: number
  rc: NativeRectangle
  lParam: bigint
}

export type ShellAppBarMessage = (
  message: number,
  data: AppBarData,
) => number | bigint

interface KoffiLibrary {
  func(declaration: string): ShellAppBarMessage
}

interface KoffiRuntime {
  struct(name: string, members: Record<string, unknown>): unknown
  load(filename: string): KoffiLibrary
  sizeof(type: unknown): number
}

const succeeded = (result: number | bigint) => result !== 0 && result !== 0n

const toNativeRectangle = (bounds: OverlayRectangle): NativeRectangle => ({
  left: bounds.x,
  top: bounds.y,
  right: bounds.x + bounds.width,
  bottom: bounds.y + bounds.height,
})

export class ShellAppBarNativeBinding implements WindowsAppBarNativeBinding {
  constructor(
    private readonly sendMessage: ShellAppBarMessage,
    private readonly dataSize: number,
  ) {}

  register(windowHandle: bigint, callbackMessage: number) {
    const data = this.#data(windowHandle)
    data.uCallbackMessage = callbackMessage
    if (!succeeded(this.sendMessage(appBarNew, data))) {
      throw new Error('Windows AppBar registration failed')
    }
  }

  position(
    windowHandle: bigint,
    displayBounds: OverlayRectangle,
    width: number,
  ) {
    const data = this.#data(windowHandle)
    data.uEdge = appBarEdgeLeft
    data.rc = toNativeRectangle(displayBounds)
    if (!succeeded(this.sendMessage(appBarQueryPosition, data))) {
      throw new Error('Windows AppBar position query failed')
    }
    data.rc.right = data.rc.left + width
    if (!succeeded(this.sendMessage(appBarSetPosition, data))) {
      throw new Error('Windows AppBar positioning failed')
    }
    return {
      x: data.rc.left,
      y: data.rc.top,
      width: data.rc.right - data.rc.left,
      height: data.rc.bottom - data.rc.top,
    }
  }

  remove(windowHandle: bigint) {
    this.sendMessage(appBarRemove, this.#data(windowHandle))
  }

  #data(windowHandle: bigint): AppBarData {
    return {
      cbSize: this.dataSize,
      hWnd: windowHandle,
      uCallbackMessage: 0,
      uEdge: appBarEdgeLeft,
      rc: { left: 0, top: 0, right: 0, bottom: 0 },
      lParam: 0n,
    }
  }
}

export const createWindowsAppBarNativeBinding = () => {
  const require = createRequire(__filename)
  const koffi = require('koffi') as KoffiRuntime
  const rectangle = koffi.struct('MiteAppBarRectangle', {
    left: 'int32_t',
    top: 'int32_t',
    right: 'int32_t',
    bottom: 'int32_t',
  })
  const appBarData = koffi.struct('MiteAppBarData', {
    cbSize: 'uint32_t',
    hWnd: 'uintptr_t',
    uCallbackMessage: 'uint32_t',
    uEdge: 'uint32_t',
    rc: rectangle,
    lParam: 'intptr_t',
  })
  const shell32 = koffi.load('shell32.dll')
  const sendMessage = shell32.func(
    'uintptr_t __stdcall SHAppBarMessage(uint32_t message, _Inout_ MiteAppBarData *data)',
  )
  return new ShellAppBarNativeBinding(sendMessage, koffi.sizeof(appBarData))
}
