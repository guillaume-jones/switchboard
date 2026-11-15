// Keeps the shell openable offline: every same-origin GET outside /api/ is answered from the cache and refreshed
// in the background. A new index.html is cached only with the assets it references, so the next offline start
// never finds half an update.
const CACHE = 'switchboard-shell'

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
      const hit = await cache.match(key)
      const fresh = fetch(event.request).then(async response => {
        if (response.ok) await (navigation ? cacheShell(cache, response.clone()) : cache.put(key, response.clone()))
        return response
      })
      if (!hit) return fresh
      event.waitUntil(fresh.catch(() => {}))
      return hit
    }),
  )
})
