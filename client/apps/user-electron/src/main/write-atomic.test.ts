// @vitest-environment node
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeAtomic } from './write-atomic'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fs>()
  return { ...original, open: vi.fn(original.open) }
})

const directories: string[] = []
const makeDestination = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mite-atomic-'))
  directories.push(directory)
  return path.join(directory, 'manifest.json')
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe('writeAtomic', () => {
  it('syncs a writable handle and atomically replaces the manifest', async () => {
    const destination = await makeDestination()
    await fs.writeFile(destination, 'previous')
    const realOpen = (await vi.importActual<typeof fs>('node:fs/promises')).open
    let synced = false
    vi.mocked(fs.open).mockImplementation(async (filename, flags, mode) => {
      const handle = await realOpen(filename, flags, mode)
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        // Model the Windows restriction, which POSIX fsync does not enforce.
        if (flags === 'r')
          throw Object.assign(new Error('fsync'), { code: 'EPERM' })
        expect(await fs.readFile(destination, 'utf8')).toBe('previous')
        await sync()
        synced = true
      })
      return handle
    })
    await writeAtomic(destination, 'next')
    expect(synced).toBe(true)
    expect(await fs.readFile(destination, 'utf8')).toBe('next')
    expect(await fs.readdir(path.dirname(destination))).toEqual([
      'manifest.json',
    ])
  })

  it.each(['writeFile', 'sync'] as const)(
    'closes the handle and preserves the previous manifest when %s fails',
    async (operation) => {
      const destination = await makeDestination()
      await fs.writeFile(destination, 'previous')
      const realOpen = (await vi.importActual<typeof fs>('node:fs/promises'))
        .open
      const failure = Object.assign(new Error('disk failure'), {
        code: 'EPERM',
      })
      let closed = false
      vi.mocked(fs.open).mockImplementation(async (filename, flags, mode) => {
        const handle = await realOpen(filename, flags, mode)
        const close = handle.close.bind(handle)
        vi.spyOn(handle, operation).mockRejectedValue(failure)
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close()
          closed = true
        })
        return handle
      })
      await expect(writeAtomic(destination, 'next')).rejects.toBe(failure)
      expect(closed).toBe(true)
      expect(await fs.readFile(destination, 'utf8')).toBe('previous')
      expect(await fs.readdir(path.dirname(destination))).toEqual([
        'manifest.json',
      ])
    },
  )
})
