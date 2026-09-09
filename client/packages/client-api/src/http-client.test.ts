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
