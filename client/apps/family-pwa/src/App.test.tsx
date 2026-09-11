import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  HttpMiteApi,
  MiteApiError,
  type SupportRequest,
} from '@mite/client-api'
import { App } from './App'

const pendingRequest: SupportRequest = {
  id: 'request_01',
  userId: 'user_demo',
  familyId: 'family_demo',
  initialScreenshotArtifactId: 'artifact_01',
  comment: '画面の操作を教えてください',
  status: 'PENDING',
  supportSessionId: null,
  guideContext: null,
  acknowledgementKind: null,
  acknowledgedAt: null,
  estimatedSupportAt: null,
  revision: 1,
  createdAt: '2026-09-11T00:00:00Z',
  updatedAt: '2026-09-11T00:00:00Z',
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  vi.spyOn(HttpMiteApi.prototype, 'getCompanionStatus').mockResolvedValue({
    user: { id: 'user_demo', role: 'USER', displayName: '利用者' },
    presence: {
      userId: 'user_demo',
      status: 'ONLINE',
      connectedSince: '2026-09-11T00:00:00Z',
      lastSeenAt: '2026-09-11T00:01:00Z',
      updatedAt: '2026-09-11T00:01:00Z',
      revision: 1,
    },
  })
  vi.spyOn(HttpMiteApi.prototype, 'listSupportRequests').mockResolvedValue([
    pendingRequest,
  ])
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const signIn = async (token = 'test-family-token') => {
  fireEvent.change(screen.getByLabelText('家族用トークン'), {
    target: { value: token },
  })
  fireEvent.click(screen.getByRole('button', { name: 'はじめる' }))
  await act(() => vi.advanceTimersByTimeAsync(0))
}

const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

it('トークンをURLへ載せず初回設定画面から開始する', () => {
  render(<App />)
  expect(
    screen.getByRole('heading', { name: '家族用トークンを設定' }),
  ).toBeVisible()
  expect(screen.getByLabelText('家族用トークン')).toHaveAttribute(
    'type',
    'password',
  )
})

it('取得が終わるまで依頼なしと表示しない', async () => {
  vi.mocked(HttpMiteApi.prototype.listSupportRequests).mockReturnValue(
    deferred<SupportRequest[]>().promise,
  )
  render(<App />)
  await signIn()
  expect(
    screen.getByRole('heading', { name: '依頼を確認しています' }),
  ).toBeVisible()
  expect(screen.queryByText('新しい依頼はありません')).not.toBeInTheDocument()
})

it('GETが5秒を超えても取得結果を表示できる', async () => {
  vi.mocked(HttpMiteApi.prototype.listSupportRequests).mockImplementation(
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve([pendingRequest]), 6_000)
      }),
  )
  render(<App />)
  await signIn()
  await act(() => vi.advanceTimersByTimeAsync(12_000))
  expect(screen.getByText(pendingRequest.comment)).toBeVisible()
})

it('返答成功前に開始したGETが遅れて届いても返答済み表示を戻さない', async () => {
  render(<App />)
  await signIn()
  const stale = deferred<SupportRequest[]>()
  vi.mocked(HttpMiteApi.prototype.listSupportRequests).mockReturnValueOnce(
    stale.promise,
  )
  await click('更新')
  vi.spyOn(
    HttpMiteApi.prototype,
    'updateSupportRequestAcknowledgement',
  ).mockResolvedValue({
    ...pendingRequest,
    acknowledgementKind: 'NOW',
    revision: 2,
  })
  await click('今から確認する')
  expect(screen.getByText('返答済み: 今から確認します')).toBeVisible()
  await act(async () => {
    stale.resolve([pendingRequest])
  })
  expect(screen.getByText('返答済み: 今から確認します')).toBeVisible()
  await click('更新')
  expect(screen.getByText('返答済み: 今から確認します')).toBeVisible()
})

it('新しい一覧で消えた依頼を遅れた古い一覧で再表示しない', async () => {
  render(<App />)
  await signIn()
  const stale = deferred<SupportRequest[]>()
  vi.mocked(HttpMiteApi.prototype.listSupportRequests)
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValueOnce([])
  await click('更新')
  await click('更新')
  expect(screen.getByText('新しい依頼はありません')).toBeVisible()
  await act(async () => {
    stale.resolve([pendingRequest])
  })
  expect(screen.getByText('新しい依頼はありません')).toBeVisible()
})

it('返答待ちの間に一覧から消えた依頼をPATCH応答で再表示しない', async () => {
  render(<App />)
  await signIn()
  const acknowledgement = deferred<SupportRequest>()
  vi.spyOn(
    HttpMiteApi.prototype,
    'updateSupportRequestAcknowledgement',
  ).mockReturnValue(acknowledgement.promise)
  await click('今から確認する')
  vi.mocked(HttpMiteApi.prototype.listSupportRequests).mockResolvedValueOnce([])
  await click('更新')
  await act(async () => {
    acknowledgement.resolve({
      ...pendingRequest,
      acknowledgementKind: 'NOW',
      revision: 2,
    })
  })
  expect(screen.getByText('新しい依頼はありません')).toBeVisible()
})

it('返答の失敗を再取得成功や自動更新で消さず、再試行できる', async () => {
  render(<App />)
  await signIn()
  const send = vi
    .spyOn(HttpMiteApi.prototype, 'updateSupportRequestAcknowledgement')
    .mockRejectedValueOnce(
      new MiteApiError(409, {
        error: {
          code: 'REVISION_CONFLICT',
          message: '依頼が更新されています',
          requestId: 'test-error',
        },
      }),
    )
    .mockResolvedValueOnce({
      ...pendingRequest,
      acknowledgementKind: 'NOW',
      revision: 3,
    })
  vi.mocked(HttpMiteApi.prototype.listSupportRequests).mockResolvedValue([
    { ...pendingRequest, revision: 2 },
  ])
  await click('今から確認する')
  expect(screen.getByRole('alert')).toHaveTextContent('依頼が更新されています')
  await act(() => vi.advanceTimersByTimeAsync(5_000))
  expect(screen.getByRole('alert')).toHaveTextContent('依頼が更新されています')
  await click('今から確認する')
  expect(send.mock.calls[1]?.[1].expectedRevision).toBe(2)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByText('返答済み: 今から確認します')).toBeVisible()
})

it('通信失敗では表示を保持し、focus時の再取得で復旧する', async () => {
  render(<App />)
  await signIn()
  vi.mocked(HttpMiteApi.prototype.listSupportRequests).mockRejectedValueOnce(
    new Error('offline'),
  )
  await act(() => vi.advanceTimersByTimeAsync(5_000))
  expect(screen.getByText(pendingRequest.comment)).toBeVisible()
  expect(screen.getByRole('alert')).toBeVisible()
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('トークン変更時に以前の依頼と遅れて届く応答を引き継がない', async () => {
  render(<App />)
  await signIn()
  const previous = deferred<SupportRequest[]>()
  vi.mocked(HttpMiteApi.prototype.listSupportRequests).mockReturnValueOnce(
    previous.promise,
  )
  await click('更新')
  await click('設定')
  vi.mocked(HttpMiteApi.prototype.listSupportRequests).mockReturnValue(
    deferred<SupportRequest[]>().promise,
  )
  await signIn('another-family-token')
  expect(screen.queryByText(pendingRequest.comment)).not.toBeInTheDocument()
  await act(async () => {
    previous.resolve([pendingRequest])
  })
  expect(screen.queryByText(pendingRequest.comment)).not.toBeInTheDocument()
})
