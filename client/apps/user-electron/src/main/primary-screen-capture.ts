import { BrowserWindow, desktopCapturer, screen } from 'electron'
import { assertScreenCaptureAvailable } from './capture-environment'

const thumbnailSize = { width: 1920, height: 1080 }

// Windows excludes protected Mite windows from both still images and media.
// The development fallback hides them only while acquiring a still image.
let thumbnailQueue: Promise<unknown> = Promise.resolve()
const getSources = (withThumbnail: boolean) => {
  const capture = async () => {
    const hidden =
      process.platform === 'win32' || !withThumbnail
        ? []
        : BrowserWindow.getAllWindows().filter((window) => window.isVisible())
    try {
      for (const window of hidden) window.hide()
      if (hidden.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100))
      }
      return await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: withThumbnail ? thumbnailSize : { width: 0, height: 0 },
      })
    } finally {
      for (const window of hidden) {
        if (!window.isDestroyed()) window.showInactive()
      }
    }
  }
  // Source identity lookup does not hide windows or generate images and need
  // not wait for a slow still capture already in progress.
  if (!withThumbnail) return capture()
  const current = thumbnailQueue.catch(() => {}).then(capture)
  thumbnailQueue = current
  return current
}

export class PrimaryScreenCapture {
  #sharingTarget: { sourceId: string; displayId: string } | null = null

  async #primarySource(withThumbnail: boolean) {
    assertScreenCaptureAvailable()
    const displayId = String(screen.getPrimaryDisplay().id)
    const sources = await getSources(withThumbnail)
    const source = sources.find(
      (candidate) => candidate.display_id === displayId,
    )
    // Never substitute the first enumerated source: it may be another monitor.
    if (!source || String(screen.getPrimaryDisplay().id) !== displayId) {
      throw new Error('画面全体を取得できません。もう一度試してください。')
    }
    if (withThumbnail && source.thumbnail.isEmpty()) {
      throw new Error('画面を取得できません')
    }
    return source
  }

  async prepareScreenShare() {
    this.#sharingTarget = null
    const source = await this.#primarySource(false)
    this.#sharingTarget = {
      sourceId: source.id,
      displayId: source.display_id,
    }
    return {
      name: '画面全体',
    }
  }

  async sharingSource(withThumbnail = false) {
    assertScreenCaptureAvailable()
    const target = this.#sharingTarget
    if (!target) throw new Error('画面共有を始めてください')
    const source = await this.#primarySource(withThumbnail)
    if (
      this.#sharingTarget !== target ||
      source.id !== target.sourceId ||
      source.display_id !== target.displayId
    ) {
      throw new Error('画面の設定が変わりました。画面共有を再開してください。')
    }
    return source
  }

  async jpeg(forSharing = false) {
    const source = forSharing
      ? await this.sharingSource(true)
      : await this.#primarySource(true)
    const size = source.thumbnail.getSize()
    const ratio = Math.min(1, 1920 / size.width, 1080 / size.height)
    const thumbnail =
      ratio < 1
        ? source.thumbnail.resize({
            width: Math.max(1, Math.round(size.width * ratio)),
            height: Math.max(1, Math.round(size.height * ratio)),
            quality: 'best',
          })
        : source.thumbnail
    return thumbnail.toJPEG(80)
  }
}
