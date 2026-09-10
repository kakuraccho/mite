const APP_URL = new URL(self.registration.scope)
const CACHE_PREFIX = `mite-family:${APP_URL.pathname}:`
const CACHE_NAME = `${CACHE_PREFIX}v2`
const APP_SHELL = ['', 'manifest.webmanifest', 'icon.svg'].map(
  (path) => new URL(path, APP_URL).href,
)
const ASSET_PATH = new URL('assets/', APP_URL).pathname

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) ||
                (APP_URL.pathname === '/' && key === 'mite-family-v1'),
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url)
  if (
    event.request.method !== 'GET' ||
    requestUrl.origin !== self.location.origin ||
    event.request.headers.has('Authorization') ||
    (!APP_SHELL.includes(requestUrl.href) &&
      !requestUrl.pathname.startsWith(ASSET_PATH))
  )
    return
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (
          response.ok &&
          !/\bno-store\b/i.test(response.headers.get('Cache-Control') || '')
        ) {
          const copy = response.clone()
          event.waitUntil(
            caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(event.request, copy)),
          )
        }
        return response
      })
      .catch(() =>
        caches.open(CACHE_NAME).then(async (cache) => {
          const cached = await cache.match(event.request)
          if (cached) return cached
          if (event.request.mode === 'navigate') {
            const shell = await cache.match(APP_URL.href)
            if (shell) return shell
          }
          return Response.error()
        }),
      ),
  )
})

self.addEventListener('push', (event) => {
  let data
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Miteからのお知らせ', {
      body: data.body || '確認してほしい支援情報があります。',
      icon: new URL('icon.svg', APP_URL).href,
      badge: new URL('icon.svg', APP_URL).href,
      tag: data.tag || 'mite-support',
      data: { url: APP_URL.href },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((client) => {
          const url = new URL(client.url)
          return (
            url.origin === APP_URL.origin &&
            url.pathname.startsWith(APP_URL.pathname)
          )
        })
        if (existing) return existing.focus()
        return self.clients.openWindow(APP_URL.href)
      }),
  )
})
