import type { BrowserWindow, Display } from 'electron'
import type { AppBarAdapter } from './appbar'
import {
  calculateOverlayBounds,
  calculateGuideBounds,
  overlayCollapsedWidth,
  type OverlayRectangle,
  type UserOverlayLayout,
  type UserOverlayMode,
} from '../shared/overlay'

type PrimaryDisplayProvider = () => Pick<Display, 'bounds' | 'workArea'>

export function collapseOverlayOnBlur(
  window: Pick<BrowserWindow, 'on' | 'webContents'>,
  controller: UserOverlayController,
) {
  window.on('blur', () => {
    if (controller.mode === 'GUIDE') return
    controller.setMode('COLLAPSED')
    window.webContents.send('overlay:collapsed')
  })
}

const rectangle = (value: OverlayRectangle): OverlayRectangle => ({
  x: Math.round(value.x),
  y: Math.round(value.y),
  width: Math.max(1, Math.round(value.width)),
  height: Math.max(1, Math.round(value.height)),
})

export class UserOverlayController {
  #mode: UserOverlayMode = 'COLLAPSED'
  #guideBounds: OverlayRectangle | null = null

  get mode() {
    return this.#mode
  }
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
    if (this.#mode === 'GUIDE') this.#guideBounds = this.window.getBounds()
    this.#mode = mode
    this.window.setMovable(mode === 'GUIDE')
    return this.#applyBounds()
  }

  refresh(): UserOverlayLayout {
    if (this.#mode === 'GUIDE') this.#guideBounds = this.window.getBounds()
    this.#reservePrimaryEdge()
    return this.#applyBounds()
  }

  keepGuideInWorkArea() {
    if (this.#mode !== 'GUIDE') return
    const current = this.window.getBounds()
    this.#guideBounds = calculateGuideBounds(
      this.primaryDisplay().workArea,
      current,
    )
    if (
      Object.keys(current).some(
        (key) =>
          current[key as keyof OverlayRectangle] !==
          this.#guideBounds?.[key as keyof OverlayRectangle],
      )
    ) {
      this.window.setBounds(this.#guideBounds, false)
    }
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
    const bounds =
      this.#mode === 'GUIDE'
        ? calculateGuideBounds(display.workArea, this.#guideBounds)
        : calculateOverlayBounds(
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
