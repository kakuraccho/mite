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
})
