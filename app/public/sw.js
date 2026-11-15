// Shows the desktop's notifications, and keeps the shell openable offline: every same-origin GET outside /api/ comes
// from the desktop when it answers within a few seconds, and from the cache otherwise. A new index.html is cached
// only with the assets it references, so the next offline start never finds half an update.
const CACHE = 'switchboard-shell'
/** How long to wait for the desktop before opening from the cache. */
const NETWORK_TIMEOUT_MS = 3000

async function cacheShell(cache, index) {
  const html = await index.clone().text()
  const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(match => match[1])
  await cache.addAll(assets)
  await cache.put('/', index)
}

self.addEventListener('install', event => {
  self.skipWaiting()
  event.waitUntil(caches.open(CACHE).then(async cache => cacheShell(cache, await fetch('/', { cache: 'no-cache' }))))
})

self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return
  const navigation = event.request.mode === 'navigate'
  const key = navigation ? '/' : event.request
  event.respondWith(
    caches.open(CACHE).then(async cache => {
      // Hashed build output never changes.
      if (url.pathname.startsWith('/assets/')) {
        const hit = await cache.match(key)
        if (hit) return hit
      }
      try {
        const timeout = new Promise((_, reject) => setTimeout(reject, NETWORK_TIMEOUT_MS))
        const response = await Promise.race([fetch(event.request), timeout])
        if (response.ok) {
          event.waitUntil(navigation ? cacheShell(cache, response.clone()) : cache.put(key, response.clone()))
        }
        return response
      } catch {
        return (await cache.match(key)) ?? Response.error()
      }
    }),
  )
})

self.addEventListener('push', event => {
  const { title, body } = event.data?.json() ?? {}
  event.waitUntil(
    self.registration.showNotification(title || 'Switchboard', { body, icon: '/icon-192.png', badge: '/badge-96.png' }),
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(windows => windows[0]?.focus() ?? self.clients.openWindow('/')),
  )
})
