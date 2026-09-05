import type { BrowserWindow } from 'electron'
import type { AppBarAdapter } from './appbar'
import type { OverlayRectangle } from '../shared/overlay'

const appBarCallbackMessage = 0x803a
const appBarPositionChanged = 1

export interface WindowsAppBarNativeBinding {
  register(windowHandle: bigint, callbackMessage: number): void
  position(
    windowHandle: bigint,
    displayBounds: OverlayRectangle,
    width: number,
  ): OverlayRectangle
  remove(windowHandle: bigint): void
}

interface RegisteredAppBar {
  windowHandle: bigint
  displayBounds: OverlayRectangle
  width: number
  positionScheduled: boolean
}

export interface WindowsCoordinateConverter {
  dipToScreenRect(
    window: BrowserWindow,
    bounds: OverlayRectangle,
  ): OverlayRectangle
  screenToDipRect(
    window: BrowserWindow,
    bounds: OverlayRectangle,
  ): OverlayRectangle
}

const identityCoordinates: WindowsCoordinateConverter = {
  dipToScreenRect: (_window, bounds) => bounds,
  screenToDipRect: (_window, bounds) => bounds,
}

export const decodeNativeWindowHandle = (value: Buffer) => {
  if (value.length === 8) return value.readBigUInt64LE()
  if (value.length === 4) return BigInt(value.readUInt32LE())
  throw new Error('Unsupported native window handle size')
}

const messageValue = (value: Buffer) =>
  value.length >= 4 ? value.readUInt32LE() : -1

export class WindowsAppBarAdapter implements AppBarAdapter {
  readonly supported = true
  readonly #registered = new WeakMap<BrowserWindow, RegisteredAppBar>()

  constructor(
    private readonly native: WindowsAppBarNativeBinding,
    private readonly coordinates: WindowsCoordinateConverter = identityCoordinates,
  ) {}

  reserve(
    window: BrowserWindow,
    displayBounds: OverlayRectangle,
    width: number,
  ) {
    let registration = this.#registered.get(window)
    let registeredNow = false
    if (!registration) {
      const windowHandle = decodeNativeWindowHandle(
        window.getNativeWindowHandle(),
      )
      const nextRegistration: RegisteredAppBar = {
        windowHandle,
        displayBounds,
        width,
        positionScheduled: false,
      }
      this.native.register(windowHandle, appBarCallbackMessage)
      this.#registered.set(window, nextRegistration)
      try {
        window.hookWindowMessage(appBarCallbackMessage, (wParam) => {
          if (
            messageValue(wParam) !== appBarPositionChanged ||
            nextRegistration.positionScheduled
          ) {
            return
          }
          nextRegistration.positionScheduled = true
          queueMicrotask(() => {
            nextRegistration.positionScheduled = false
            this.#position(window, nextRegistration)
          })
        })
      } catch (error) {
        this.native.remove(windowHandle)
        this.#registered.delete(window)
        throw error
      }
      registration = nextRegistration
      registeredNow = true
    } else {
      registration.displayBounds = displayBounds
      registration.width = width
    }

    try {
      return this.#position(window, registration)
    } catch (error) {
      if (registeredNow) this.release(window)
      throw error
    }
  }

  release(window: BrowserWindow) {
    const registration = this.#registered.get(window)
    if (!registration) return
    this.native.remove(registration.windowHandle)
    if (window.isWindowMessageHooked(appBarCallbackMessage)) {
      window.unhookWindowMessage(appBarCallbackMessage)
    }
    this.#registered.delete(window)
  }

  #position(window: BrowserWindow, registration: RegisteredAppBar) {
    const displayBounds = this.coordinates.dipToScreenRect(
      window,
      registration.displayBounds,
    )
    const edgeBounds = this.coordinates.dipToScreenRect(window, {
      ...registration.displayBounds,
      width: registration.width,
    })
    const reservedBounds = this.native.position(
      registration.windowHandle,
      displayBounds,
      edgeBounds.width,
    )
    return this.coordinates.screenToDipRect(window, reservedBounds)
  }
}
