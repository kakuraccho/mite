import { randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'

export const writeAtomic = async (
  filename: string,
  contents: Uint8Array | string,
) => {
  const temporary = `${filename}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx')
  try {
    try {
      await handle.writeFile(contents)
      // Windows requires a writable handle for FlushFileBuffers (fsync).
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, filename)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}
