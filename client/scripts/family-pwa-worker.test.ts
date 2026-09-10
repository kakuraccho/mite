// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

const workerSource = readFileSync(
  new URL('../apps/family-pwa/public/sw.js', import.meta.url),
  'utf8',
)
const origin = 'https://example.com'

function createWorker(base = '/mite/pwa/') {
  const appUrl = `${origin}${base}`
  const stored = new Map<string, Response>()
  const cache = {
    addAll: vi.fn(async () => {}),
    put: vi.fn(async (request: Request, response: Response) => {
      stored.set(request.url, response)
    }),
    match: vi.fn(async (request: Request | string) =>
      stored.get(typeof request === 'string' ? request : request.url),
    ),
  }
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => [
      `mite-family:${base}:v1`,
      `mite-family:${base}:v2`,
      'mite-family:/another-app/:v1',
      'another-site-cache',
    ]),
    delete: vi.fn(async () => true),
  }
  const clients = {
    claim: vi.fn(async () => {}),
    matchAll: vi.fn(async () => [
      { url: `${origin}/another-app/`, focus: vi.fn() },
    ]),
    openWindow: vi.fn(async () => {}),
  }
  const registration = {
    scope: appUrl,
    showNotification: vi.fn(async () => {}),
  }
  const fetch = vi.fn(async () => new Response('app asset'))
  type WorkerEvent = {
    request: Request
    respondWith: (promise: Promise<Response>) => void
    waitUntil: (promise: Promise<unknown>) => void
    notification: { close: () => void }
  }
  const listeners = new Map<string, (event: WorkerEvent) => void>()
  runInNewContext(workerSource, {
    URL,
    Response,
    caches,
    fetch,
    self: {
      location: { origin },
      registration,
      clients,
      skipWaiting: vi.fn(),
      addEventListener: (
        name: string,
        listener: (event: WorkerEvent) => void,
      ) => listeners.set(name, listener),
    },
  })
  const dispatch = async (name: string, request = new Request(appUrl)) => {
    const responses: Promise<Response>[] = []
    const work: Promise<unknown>[] = []
    const event = {
      request,
      respondWith: vi.fn((response: Promise<Response>) =>
        responses.push(response),
      ),
      waitUntil: (promise: Promise<unknown>) => work.push(promise),
      notification: { close: vi.fn() },
    }
    const listener = listeners.get(name)
    if (!listener) throw new Error(`Missing ${name} listener`)
    listener(event)
    const [response] = await Promise.all(responses)
    await Promise.all(work)
    return { event, response }
  }
  return {
    appUrl,
    stored,
    cache,
    caches,
    clients,
    registration,
    fetch,
    dispatch,
  }
}

it.each(['/', '/mite/pwa/'])(
  'keeps shell and notifications within %s',
  async (base) => {
    const worker = createWorker(base)
    await worker.dispatch('install')
    expect(worker.cache.addAll).toHaveBeenCalledWith([
      worker.appUrl,
      `${worker.appUrl}manifest.webmanifest`,
      `${worker.appUrl}icon.svg`,
    ])
    await worker.dispatch('push')
    expect(worker.registration.showNotification).toHaveBeenCalledWith(
      'Miteからのお知らせ',
      expect.objectContaining({
        icon: `${worker.appUrl}icon.svg`,
        badge: `${worker.appUrl}icon.svg`,
        data: { url: worker.appUrl },
      }),
    )
  },
)

it.each([
  '/v1/companion/status',
  '/mite/v1/companion/status',
  '/mite/v1/support-requests?status=PENDING',
  '/other-api',
])('leaves %s to the browser without cache interception', async (path) => {
  const worker = createWorker()
  const { event } = await worker.dispatch(
    'fetch',
    new Request(`${origin}${path}`),
  )
  expect(event.respondWith).not.toHaveBeenCalled()
  expect(worker.fetch).not.toHaveBeenCalled()
  expect(worker.caches.open).not.toHaveBeenCalled()
})

it('does not cache authenticated requests or no-store responses', async () => {
  const worker = createWorker()
  const url = `${worker.appUrl}assets/app.js`
  const { event } = await worker.dispatch(
    'fetch',
    new Request(url, {
      headers: { Authorization: 'Bearer test-only' },
    }),
  )
  expect(event.respondWith).not.toHaveBeenCalled()
  worker.fetch.mockResolvedValueOnce(
    new Response('private', {
      headers: { 'Cache-Control': 'private, no-store' },
    }),
  )
  await worker.dispatch('fetch', new Request(url))
  expect(worker.cache.put).not.toHaveBeenCalled()
})

it('serves cached assets offline and does not return HTML for missing assets', async () => {
  const worker = createWorker()
  const request = new Request(`${worker.appUrl}assets/app.js`)
  await worker.dispatch('fetch', request)
  expect(worker.cache.put).toHaveBeenCalledOnce()
  worker.fetch.mockRejectedValue(new TypeError('offline'))
  const { response } = await worker.dispatch('fetch', request)
  expect(await response?.text()).toBe('app asset')
  worker.stored.set(worker.appUrl, new Response('<html>shell</html>'))
  const missing = await worker.dispatch(
    'fetch',
    new Request(`${worker.appUrl}assets/missing.js`),
  )
  expect(missing.response?.type).toBe('error')
})

it('opens the PWA path when only another app has an open window', async () => {
  const worker = createWorker()
  await worker.dispatch('notificationclick')
  expect(worker.clients.openWindow).toHaveBeenCalledWith(worker.appUrl)
})

it('only removes old caches belonging to this PWA scope', async () => {
  const worker = createWorker()
  await worker.dispatch('activate')
  expect(worker.caches.delete).toHaveBeenCalledExactlyOnceWith(
    'mite-family:/mite/pwa/:v1',
  )
})
