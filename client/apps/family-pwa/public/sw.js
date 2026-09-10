const CACHE_PREFIX = 'mite-family-'
const APP_ROOT = new URL('./', self.registration.scope)
const CACHE_NAME = `${CACHE_PREFIX}v2:${APP_ROOT.pathname}`
const appUrl = (path = '') => new URL(path, APP_ROOT).toString()
const APP_SHELL = [appUrl(), appUrl('manifest.webmanifest'), appUrl('icon.svg')]

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
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
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
    !requestUrl.pathname.startsWith(APP_ROOT.pathname)
  )
    return
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
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
        caches
          .match(event.request)
          .then((cached) => cached || caches.match(appUrl())),
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
      icon: appUrl('icon.svg'),
      badge: appUrl('icon.svg'),
      tag: data.tag || 'mite-support',
      data: { url: appUrl() },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((client) =>
          client.url.startsWith(self.registration.scope),
        )
        if (existing) return existing.focus()
        return self.clients.openWindow(appUrl())
      }),
  )
})
