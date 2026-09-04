import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

const schemaVersion = 1 as const
const maximumBytes = 10 * 1024 * 1024

interface SupportScreenshotDraftManifest {
  schemaVersion: typeof schemaVersion
  draftId: string
  capturedAt: string
  filename: string
  sha256: string
}

export interface SupportScreenshotDraft {
  draftId: string
  capturedAt: string
  bytes: Uint8Array
}

const assertSafeId = (value: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('draftId is invalid')
  }
  return value
}

const assertCapturedAt = (value: string) => {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new Error('capturedAt is invalid')
  }
  return value
}

const isManifest = (
  value: unknown,
): value is SupportScreenshotDraftManifest => {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Record<string, unknown>
  return (
    manifest.schemaVersion === schemaVersion &&
    typeof manifest.draftId === 'string' &&
    typeof manifest.capturedAt === 'string' &&
    typeof manifest.filename === 'string' &&
    /^[a-f0-9]{64}\.jpg$/.test(manifest.filename) &&
    typeof manifest.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(manifest.sha256)
  )
}

const writeAtomic = async (filename: string, contents: Uint8Array | string) => {
  const temporary = `${filename}.${randomUUID()}.tmp`
  await writeFile(temporary, contents, { flag: 'wx' })
  const handle = await open(temporary, 'r')
  await handle.sync()
  await handle.close()
  await rename(temporary, filename)
}

export class SupportScreenshotDraftStore {
  readonly #rootDirectory: string

  constructor(rootDirectory: string) {
    this.#rootDirectory = rootDirectory
  }

  async save(
    draftId: string,
    capturedAt: string,
    bytes: Uint8Array,
  ): Promise<SupportScreenshotDraft> {
    assertSafeId(draftId)
    assertCapturedAt(capturedAt)
    if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
      throw new Error('screenshot size is invalid')
    }

    const copy = Uint8Array.from(bytes)
    const sha256 = createHash('sha256').update(copy).digest('hex')
    const filename = `${sha256}.jpg`
    const directory = this.#directory(draftId)
    await mkdir(directory, { recursive: true })
    await this.#removeTemporaryFiles(directory)
    await writeAtomic(path.join(directory, filename), copy)

    const manifest: SupportScreenshotDraftManifest = {
      schemaVersion,
      draftId,
      capturedAt,
      filename,
      sha256,
    }
    await writeAtomic(
      this.#manifestPath(draftId),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
    await this.#removeSupersededImages(directory, filename)
    return { draftId, capturedAt, bytes: copy }
  }

  async load(draftId: string): Promise<SupportScreenshotDraft | null> {
    assertSafeId(draftId)
    const directory = this.#directory(draftId)
    await this.#removeTemporaryFiles(directory)
    const raw = await readFile(this.#manifestPath(draftId), 'utf8').catch(
      () => null,
    )
    if (raw === null) return null

    const parsed: unknown = JSON.parse(raw)
    if (
      !isManifest(parsed) ||
      parsed.draftId !== draftId ||
      Number.isNaN(Date.parse(parsed.capturedAt))
    ) {
      throw new Error('保存した相談画面の記録が壊れています')
    }
    const bytes = await readFile(path.join(directory, parsed.filename))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== parsed.sha256) {
      throw new Error('保存した相談画面が壊れています')
    }
    return {
      draftId,
      capturedAt: parsed.capturedAt,
      bytes: new Uint8Array(bytes),
    }
  }

  async delete(draftId: string): Promise<void> {
    assertSafeId(draftId)
    await rm(this.#directory(draftId), { recursive: true, force: true })
  }

  #directory(draftId: string) {
    return path.join(this.#rootDirectory, assertSafeId(draftId))
  }

  #manifestPath(draftId: string) {
    return path.join(this.#directory(draftId), 'manifest.json')
  }

  async #removeTemporaryFiles(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    )
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'))
        .map((entry) =>
          rm(path.join(directory, entry.name), { force: true }).catch(() => {}),
        ),
    )
  }

  async #removeSupersededImages(directory: string, currentFilename: string) {
    const entries = await readdir(directory, { withFileTypes: true })
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith('.jpg') &&
            entry.name !== currentFilename,
        )
        .map((entry) =>
          rm(path.join(directory, entry.name), { force: true }).catch(() => {}),
        ),
    )
  }
}
