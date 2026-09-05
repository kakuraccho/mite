import { screen, type BrowserWindow } from 'electron'
import type { OverlayRectangle } from '../shared/overlay'
import { WindowsAppBarAdapter } from './windows-appbar'
import { createWindowsAppBarNativeBinding } from './windows-appbar-native'

export interface AppBarAdapter {
  readonly supported: boolean
  reserve(
    window: BrowserWindow,
    displayBounds: OverlayRectangle,
    width: number,
  ): OverlayRectangle
  release(window: BrowserWindow): void
}

export const simulatedAppBar: AppBarAdapter = {
  supported: false,
  reserve(_window, displayBounds, width) {
    return { ...displayBounds, width }
  },
  release() {},
}

export const createAppBarAdapter = (): AppBarAdapter => {
  if (process.platform !== 'win32') return simulatedAppBar

  return new WindowsAppBarAdapter(createWindowsAppBarNativeBinding(), {
    dipToScreenRect: (_window, bounds) => screen.dipToScreenRect(null, bounds),
    screenToDipRect: (_window, bounds) => screen.screenToDipRect(null, bounds),
  })
}
