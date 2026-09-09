import { BrowserWindow, screen, type IpcMainEvent } from 'electron'
import {
  isDesktopMarkList,
  isDesktopGuidance,
  type DesktopMark,
  type DesktopGuidance,
} from '../shared/marking-overlay'
import { isTrustedRendererUrl } from './security'

export class MarkingOverlay {
  readonly window: BrowserWindow
  #marks: DesktopMark[] = []
  #guidance: DesktopGuidance | null = null
  #ready = false
  #visible = false
  #timer: ReturnType<typeof setTimeout> | null = null

  constructor(url: string, preload: string) {
    this.window = new BrowserWindow({
      ...screen.getPrimaryDisplay().bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      alwaysOnTop: true,
      hasShadow: false,
      roundedCorners: false,
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    this.window.setIgnoreMouseEvents(true)
    this.window.setAlwaysOnTop(true, 'screen-saver')
    if (process.platform === 'win32') this.window.setContentProtection(true)
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.window.webContents.on('will-navigate', (event) =>
      event.preventDefault(),
    )
    this.window.webContents.on('did-start-loading', () => {
      this.#ready = false
      this.#setVisible(false)
    })
    this.window.webContents.on('render-process-gone', () => this.clear())
    this.window.once('closed', () => {
      if (this.#timer) clearTimeout(this.#timer)
    })
    void this.window.loadURL(url)
  }

  rendererReady(event: IpcMainEvent) {
    if (
      event.sender !== this.window.webContents ||
      event.senderFrame !== this.window.webContents.mainFrame ||
      !isTrustedRendererUrl(event.senderFrame?.url ?? '')
    )
      return
    this.#ready = true
    this.#render()
  }

  setMarks(value: unknown) {
    if (!isDesktopMarkList(value)) throw new Error('Invalid marking positions')
    this.#marks = value.map(({ id, x, y, expiresAt }) => ({
      id,
      x,
      y,
      expiresAt,
    }))
    this.#render()
  }

  setGuidance(value: unknown) {
    if (value !== null && !isDesktopGuidance(value))
      throw new Error('Invalid guidance')
    this.#guidance =
      value === null
        ? null
        : {
            ...value,
            keys: [...value.keys],
            expiresAt: Math.min(value.expiresAt, Date.now() + 2_000),
          }
    if (this.#guidance) this.#marks = []
    this.#render()
  }

  clear() {
    this.#guidance = null
    this.setMarks([])
  }

  refresh() {
    if (this.window.isDestroyed()) return
    this.window.setBounds(screen.getPrimaryDisplay().bounds, false)
    // A display change invalidates positions received for the old geometry.
    this.clear()
  }

  dispose() {
    if (this.#timer) clearTimeout(this.#timer)
    this.#marks = []
    this.#guidance = null
    if (!this.window.isDestroyed()) this.window.destroy()
  }

  #setVisible(visible: boolean) {
    if (visible === this.#visible) return
    this.#visible = visible
    if (visible) this.window.showInactive()
    else this.window.hide()
  }

  #render() {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    if (this.window.isDestroyed()) return
    const now = Date.now()
    this.#marks = this.#marks.filter((mark) => mark.expiresAt > now)
    if (this.#guidance && this.#guidance.expiresAt <= now) this.#guidance = null
    if (this.#ready)
      this.window.webContents.send('guidance:changed', this.#guidance)
    if (this.#ready)
      this.window.webContents.send('marking:changed', this.#marks)
    this.#setVisible(this.#ready && (!!this.#marks.length || !!this.#guidance))
    if (this.#marks.length || this.#guidance) {
      const delay = Math.min(
        ...this.#marks.map((mark) => mark.expiresAt - now),
        this.#guidance ? this.#guidance.expiresAt - now : Infinity,
      )
      this.#timer = setTimeout(
        () => this.#render(),
        Math.min(delay, 2_147_483_647),
      )
    }
  }
}
