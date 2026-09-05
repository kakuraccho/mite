import { afterEach, describe, expect, it, vi } from 'vitest'
import { retryGuideMaterialUpload } from './retry'

afterEach(() => {
  vi.useRealTimers()
})

describe('retryGuideMaterialUpload', () => {
  it('1秒、2秒、4秒の待機後に同じ処理を最大3回再試行する', async () => {
    vi.useFakeTimers()
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('third'))
      .mockResolvedValue('uploaded')

    const result = retryGuideMaterialUpload(operation)
    expect(operation).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(operation).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(operation).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(operation).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(4_000)

    await expect(result).resolves.toBe('uploaded')
    expect(operation).toHaveBeenCalledTimes(4)
  })

  it('中断時は次の再試行へ進まない', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const operation = vi.fn(async () => {
      throw new Error('offline')
    })

    const result = retryGuideMaterialUpload(operation, controller.signal)
    controller.abort(new Error('cancelled'))

    await expect(result).rejects.toThrow('cancelled')
    expect(operation).toHaveBeenCalledOnce()
  })
})
