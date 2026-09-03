import { describe, expect, it, vi } from 'vitest'
import { MiteApiError, type GuideDraft, type MiteApi } from '@mite/api-client'
import { DraftSaveQueue } from './draft-save-queue'

const draft = (revision = 1): GuideDraft => ({
  id: 'draft_01',
  supportSessionId: 'session_01',
  title: '最初の手順',
  steps: [
    {
      position: 1,
      artifactId: 'artifact_01',
      instruction: '最初の説明',
    },
  ],
  status: 'EDITING',
  revision,
  createdAt: '2026-09-03T10:00:00Z',
  updatedAt: '2026-09-03T10:00:00Z',
})

const deferred = <TValue>() => {
  let resolve: (value: TValue) => void = () => undefined
  let reject: (reason?: unknown) => void = () => undefined
  const promise = new Promise<TValue>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('DraftSaveQueue', () => {
  it('500ms待って保存し、送信中の変更は応答revisionで直列送信する', async () => {
    vi.useFakeTimers()
    const first = deferred<GuideDraft>()
    const second = deferred<GuideDraft>()
    const updateGuideDraft = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const api = { updateGuideDraft } as unknown as MiteApi
    const queue = new DraftSaveQueue(api, draft())

    queue.edit({ title: '変更1', steps: draft().steps })
    await vi.advanceTimersByTimeAsync(499)
    expect(updateGuideDraft).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(updateGuideDraft).toHaveBeenCalledWith(
      'draft_01',
      expect.objectContaining({ expectedRevision: 1, title: '変更1' }),
    )

    queue.edit({ title: '変更2', steps: draft().steps })
    first.resolve({ ...draft(2), title: '変更1' })
    await vi.runAllTicks()
    await Promise.resolve()
    expect(updateGuideDraft).toHaveBeenCalledTimes(2)
    expect(updateGuideDraft).toHaveBeenLastCalledWith(
      'draft_01',
      expect.objectContaining({ expectedRevision: 2, title: '変更2' }),
    )

    second.resolve({ ...draft(3), title: '変更2' })
    await vi.runAllTicks()
    await Promise.resolve()
    expect(queue.getSnapshot()).toMatchObject({
      status: 'SAVED',
      hasPendingChanges: false,
      draft: { revision: 3, title: '変更2' },
    })
    queue.dispose()
    vi.useRealTimers()
  })

  it('競合時は最新下書きを取得して編集中の内容を置き換える', async () => {
    vi.useFakeTimers()
    const conflict = new MiteApiError(409, {
      error: {
        code: 'REVISION_CONFLICT',
        message: 'conflict',
        requestId: 'request_01',
      },
    })
    const latest = { ...draft(4), title: '別の画面で更新された手順' }
    const api = {
      updateGuideDraft: vi.fn().mockRejectedValue(conflict),
      getGuideDraft: vi.fn().mockResolvedValue(latest),
    } as unknown as MiteApi
    const queue = new DraftSaveQueue(api, draft())

    queue.edit({ title: '競合する変更', steps: draft().steps })
    await vi.advanceTimersByTimeAsync(500)
    await vi.runAllTicks()
    await Promise.resolve()

    expect(api.getGuideDraft).toHaveBeenCalledWith('draft_01')
    expect(queue.getSnapshot()).toMatchObject({
      status: 'CONFLICT',
      hasPendingChanges: false,
      draft: { revision: 4, title: '別の画面で更新された手順' },
    })
    queue.dispose()
    vi.useRealTimers()
  })

  it('PATCH応答が不明でもGET内容が一致すれば保存済みとして確定する', async () => {
    vi.useFakeTimers()
    const saved = { ...draft(2), title: '応答を失った変更' }
    const api = {
      updateGuideDraft: vi.fn().mockRejectedValue(new TypeError('offline')),
      getGuideDraft: vi.fn().mockResolvedValue(saved),
    } as unknown as MiteApi
    const queue = new DraftSaveQueue(api, draft())

    queue.edit({ title: saved.title, steps: saved.steps })
    await vi.advanceTimersByTimeAsync(500)
    await vi.runAllTicks()
    await Promise.resolve()

    expect(api.getGuideDraft).toHaveBeenCalledWith('draft_01')
    expect(queue.getSnapshot()).toMatchObject({
      status: 'SAVED',
      hasPendingChanges: false,
      draft: { revision: 2, title: saved.title },
    })
    queue.dispose()
    vi.useRealTimers()
  })
})
