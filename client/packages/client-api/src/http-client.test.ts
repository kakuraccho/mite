import { describe, expect, it, vi } from 'vitest'
import type { MiteApiError } from './error'
import { HttpMiteApi } from './http-client'

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  })

describe('HttpMiteApi', () => {
  it('認証と保存済みの冪等キーを状態変更リクエストへ付ける', async () => {
    const supportRequest = {
      id: 'request_01',
      userId: 'user_demo',
      familyId: 'family_demo',
      initialScreenshotArtifactId: 'artifact_01',
      comment: 'ここが分かりません',
      status: 'PENDING',
      supportSessionId: null,
      guideContext: null,
      revision: 1,
      createdAt: '2026-09-03T00:00:00Z',
      updatedAt: '2026-09-03T00:00:00Z',
    }
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ data: supportRequest }),
    )
    const api = new HttpMiteApi({
      baseUrl: 'http://127.0.0.1:8080/',
      token: 'demo-token',
      fetch,
    })

    const result = await api.createSupportRequest(
      {
        initialScreenshotArtifactId: 'artifact_01',
        comment: 'ここが分かりません',
      },
      { idempotencyKey: 'idem_01' },
    )

    expect(result.id).toBe('request_01')
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0] ?? []
    const headers = new Headers(init?.headers)
    expect(url).toBe('http://127.0.0.1:8080/v1/support-requests')
    expect(init?.method).toBe('POST')
    expect(headers.get('authorization')).toBe('Bearer demo-token')
    expect(headers.get('idempotency-key')).toBe('idem_01')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('APIのエラーコードとRetry-Afterを呼び出し側へ渡す', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
            message: '処理中です',
            requestId: 'req_01',
          },
        },
        { status: 409, headers: { 'retry-after': '2' } },
      ),
    )
    const api = new HttpMiteApi({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'demo-token',
      fetch: fetch as typeof globalThis.fetch,
    })

    await expect(api.getSupportRequest('request_01')).rejects.toMatchObject({
      name: 'MiteApiError',
      status: 409,
      code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      requestId: 'req_01',
      retryAfterSeconds: 2,
    } satisfies Partial<MiteApiError>)
  })

  it('heartbeat・確認返答・取消を専用の契約で送る', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ data: { status: 'ONLINE' } }),
    )
    const api = new HttpMiteApi({
      baseUrl: 'https://api.example.com',
      token: 'user-token',
      fetch,
    })

    await api.recordPresenceHeartbeat()
    await api.updateSupportRequestAcknowledgement('request/1', {
      acknowledgementKind: 'UNKNOWN',
      estimatedSupportAt: null,
      expectedRevision: 2,
    })
    await api.cancelSupportRequest('request/1', 3, {
      idempotencyKey: 'cancel-key',
    })

    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/v1/presence/heartbeat',
    )
    expect(fetch.mock.calls[1]?.[0]).toBe(
      'https://api.example.com/v1/support-requests/request%2F1/acknowledgement',
    )
    expect(fetch.mock.calls[2]?.[0]).toBe(
      'https://api.example.com/v1/support-requests/request%2F1/cancel',
    )
    expect(
      new Headers(fetch.mock.calls[2]?.[1]?.headers).get('idempotency-key'),
    ).toBe('cancel-key')
  })
})

it('支援の全下書き一覧と全件確定を正しいパス・本文・キーで送る', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      jsonResponse({ data: { items: [{ id: 'draft_1' }, { id: 'draft_2' }] } }),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        data: {
          guides: [{ id: 'guide_1' }, { id: 'guide_2' }],
          supportSession: { status: 'ENDED' },
        },
      }),
    )
  const api = new HttpMiteApi({
    baseUrl: 'http://localhost:3000',
    token: 'test-token',
    fetch,
  })
  expect(await api.listSessionGuideDrafts('session/1')).toHaveLength(2)
  expect(fetch.mock.calls[0]![0]).toBe(
    'http://localhost:3000/v1/support-sessions/session%2F1/guide-drafts',
  )
  const input = {
    expectedSessionRevision: 6,
    drafts: [
      { id: 'draft_1', expectedRevision: 2 },
      { id: 'draft_2', expectedRevision: 3 },
    ],
  }
  expect(
    (
      await api.completeGuideReview('session/1', input, {
        idempotencyKey: 'review-key',
      })
    ).guides,
  ).toHaveLength(2)
  const [url, init] = fetch.mock.calls[1]!
  expect(url).toBe(
    'http://localhost:3000/v1/support-sessions/session%2F1/complete-guide-review',
  )
  expect(init?.method).toBe('POST')
  expect(JSON.parse(init?.body as string)).toEqual(input)
  expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('review-key')
})

it('shares concurrent artifact requests and reuses recently loaded bytes only within the same API instance', async () => {
  const fetch = vi.fn(async () => new Response(new Blob(['image'])))
  const options = {
    baseUrl: 'https://example.test',
    token: 'one',
    fetch: fetch as typeof globalThis.fetch,
  }
  const api = new HttpMiteApi(options)
  const [first, second] = await Promise.all([
    api.getArtifactContent('a'),
    api.getArtifactContent('a'),
  ])
  expect(first).toBe(second)
  expect(await api.getArtifactContent('a')).toBe(first)
  expect(fetch).toHaveBeenCalledOnce()
  await new HttpMiteApi({ ...options, token: 'two' }).getArtifactContent('a')
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('retries failed artifact loads and expires cached images after a minute', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockImplementation(async () => new Response(new Blob(['image'])))
  const api = new HttpMiteApi({
    baseUrl: 'https://example.test',
    token: 'one',
    fetch,
  })
  await expect(api.getArtifactContent('a')).rejects.toThrow('offline')
  const first = await api.getArtifactContent('a')
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001)
  try {
    expect(await api.getArtifactContent('a')).not.toBe(first)
  } finally {
    clock.mockRestore()
  }
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('evicts least recently used artifact bytes when the memory budget is reached', async () => {
  const fetch = vi.fn(
    async () =>
      ({
        ok: true,
        blob: async () => ({ size: 12 * 1024 * 1024 }),
      }) as Response,
  )
  const api = new HttpMiteApi({
    baseUrl: 'https://example.test',
    token: 'one',
    fetch: fetch as typeof globalThis.fetch,
  })
  await api.getArtifactContent('a')
  await api.getArtifactContent('b')
  await api.getArtifactContent('a')
  await api.getArtifactContent('c')
  expect(fetch).toHaveBeenCalledTimes(3)
  await api.getArtifactContent('b')
  expect(fetch).toHaveBeenCalledTimes(4)
})

it('sends early guide termination to the cancellation endpoint with its revision and retry key', async () => {
  const fetch = vi.fn(async () =>
    jsonResponse({ data: { id: 'run_1', status: 'CANCELLED', revision: 3 } }),
  )
  const api = new HttpMiteApi({
    baseUrl: 'https://example.test',
    token: 'one',
    fetch: fetch as typeof globalThis.fetch,
  })
  expect(
    await api.cancelGuideRun(
      'run/1',
      { expectedRevision: 2 },
      { idempotencyKey: 'cancel-key' },
    ),
  ).toMatchObject({ status: 'CANCELLED' })
  const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://example.test/v1/guide-runs/run%2F1/cancel')
  expect(options.method).toBe('POST')
  expect(JSON.parse(options.body as string)).toEqual({ expectedRevision: 2 })
  expect(new Headers(options.headers).get('Idempotency-Key')).toBe('cancel-key')
})
