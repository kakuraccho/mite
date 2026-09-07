import { describe, expect, it, vi } from 'vitest'
import { createCaptureSessionQueue } from './capture-session-queue'

describe('capture session queue', () => {
  it('waits for the last image before reading the upload manifest or deleting the session', async () => {
    const enqueue = createCaptureSessionQueue()
    const order: string[] = []
    let finish!: () => void
    const pendingImage = new Promise<void>((resolve) => {
      finish = resolve
    })
    const save = enqueue('session_01', async () => {
      await pendingImage
      order.push('image and manifest saved')
    })
    const read = enqueue('session_01', async () => {
      order.push('manifest read')
    })
    const remove = enqueue('session_01', async () => {
      order.push('directory removed')
    })
    await enqueue('session_02', async () => {})
    expect(order).toEqual([])
    finish()
    await Promise.all([save, read, remove])
    expect(order).toEqual([
      'image and manifest saved',
      'manifest read',
      'directory removed',
    ])
  })

  it('allows initialization to retry after a failed write', async () => {
    const enqueue = createCaptureSessionQueue()
    const failure = new Error('fsync failed')
    const failed = enqueue('session_01', async () => {
      throw failure
    })
    const retry = vi.fn(async () => 'manifest')
    const recovered = enqueue('session_01', retry)
    await expect(failed).rejects.toBe(failure)
    await expect(recovered).resolves.toBe('manifest')
    expect(retry).toHaveBeenCalledOnce()
  })
})
