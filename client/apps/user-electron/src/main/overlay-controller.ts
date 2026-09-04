import type { BrowserWindow, Display } from 'electron'
import type { AppBarAdapter } from './appbar'
import {
  calculateOverlayBounds,
  overlayCollapsedWidth,
  type OverlayRectangle,
  type UserOverlayLayout,
  type UserOverlayMode,
} from '../shared/overlay'

type PrimaryDisplayProvider = () => Pick<Display, 'bounds' | 'workArea'>

const rectangle = (value: OverlayRectangle): OverlayRectangle => ({
  x: Math.round(value.x),
  y: Math.round(value.y),
  width: Math.max(1, Math.round(value.width)),
  height: Math.max(1, Math.round(value.height)),
})

export class UserOverlayController {
  #mode: UserOverlayMode = 'COLLAPSED'
  #reservedBounds: OverlayRectangle | null = null

  constructor(
    private readonly window: BrowserWindow,
    private readonly primaryDisplay: PrimaryDisplayProvider,
    private readonly appBar: AppBarAdapter,
  ) {}

  initialize(): UserOverlayLayout {
    this.#reservePrimaryEdge()
    return this.#applyBounds()
  }

  setMode(mode: UserOverlayMode): UserOverlayLayout {
    this.#mode = mode
    return this.#applyBounds()
  }

  refresh(): UserOverlayLayout {
    this.#reservePrimaryEdge()
    return this.#applyBounds()
  }

  dispose() {
    this.appBar.release(this.window)
    this.#reservedBounds = null
  }

  #reservePrimaryEdge() {
    const display = this.primaryDisplay()
    this.#reservedBounds = this.appBar.supported
      ? rectangle(
          this.appBar.reserve(
            this.window,
            rectangle(display.bounds),
            overlayCollapsedWidth,
          ),
        )
      : {
          ...rectangle(display.workArea),
          width: overlayCollapsedWidth,
        }
  }

  #applyBounds(): UserOverlayLayout {
    const display = this.primaryDisplay()
    const reservedBounds = this.#reservedBounds ?? {
      ...rectangle(display.workArea),
      width: overlayCollapsedWidth,
    }
    const bounds = calculateOverlayBounds(
      reservedBounds,
      display.bounds.width,
      this.#mode,
    )
    this.window.setBounds(bounds, false)

    return {
      mode: this.#mode,
      reservation: this.appBar.supported ? 'WINDOWS_APPBAR' : 'SIMULATED',
      bounds,
      reservedBounds,
    }
  }
}
