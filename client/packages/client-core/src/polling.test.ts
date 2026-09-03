import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPolling } from './polling'

afterEach(() => {
  vi.useRealTimers()
})

describe('startPolling', () => {
  it('処理完了から5秒後に再取得し、stop後は再取得しない', async () => {
    vi.useFakeTimers()
    const task = vi.fn(async () => undefined)
    const controller = startPolling(task)

    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(task).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(task).toHaveBeenCalledTimes(2)

    controller.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('再取得エラーを通知してポーリングを継続する', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const task = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined)
    const controller = startPolling(task, { onError })

    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(task).toHaveBeenCalledTimes(2)
    controller.stop()
  })
})
