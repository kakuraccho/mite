import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SupportScreenshotDraftStore } from './support-screenshot-draft'

const temporaryDirectories: string[] = []

const makeStore = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mite-draft-test-'))
  temporaryDirectories.push(directory)
  return { directory, store: new SupportScreenshotDraftStore(directory) }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('SupportScreenshotDraftStore', () => {
  it('persists and reloads the exact screenshot bytes', async () => {
    const { store } = await makeStore()
    const bytes = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])

    await store.save('draft_01', '2026-09-04T10:00:00Z', bytes)
    const restored = await store.load('draft_01')

    expect(restored).toEqual({
      draftId: 'draft_01',
      capturedAt: '2026-09-04T10:00:00Z',
      bytes,
    })
  })

  it('keeps the previous complete draft until a replacement manifest exists', async () => {
    const { directory, store } = await makeStore()
    const original = new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9])
    await store.save('draft_01', '2026-09-04T10:00:00Z', original)

    await writeFile(
      path.join(directory, 'draft_01', 'orphan.jpg'),
      new Uint8Array([9]),
    )

    expect(await store.load('draft_01')).toEqual({
      draftId: 'draft_01',
      capturedAt: '2026-09-04T10:00:00Z',
      bytes: original,
    })
  })

  it('detects altered screenshot bytes and deletes completed drafts', async () => {
    const { directory, store } = await makeStore()
    await store.save(
      'draft_01',
      '2026-09-04T10:00:00Z',
      new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]),
    )
    const manifest = JSON.parse(
      await readFile(path.join(directory, 'draft_01', 'manifest.json'), 'utf8'),
    ) as { filename: string }
    await writeFile(
      path.join(directory, 'draft_01', manifest.filename),
      new Uint8Array([0]),
    )

    await expect(store.load('draft_01')).rejects.toThrow(
      '保存した相談画面が壊れています',
    )
    await store.delete('draft_01')
    await expect(store.load('draft_01')).resolves.toBeNull()
  })
})
