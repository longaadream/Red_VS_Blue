const CACHE_NAME = 'rvb-v2-lobby-routing'
const STATIC_ASSETS = [
  './',
  './index.html',
  './lobby.html',
  './login.html',
  './battle.html',
  './training.html',
  './piece-selection.html',
  './pieces.html',
  './maps.html',
  './pack.html',
  './history.html',
  './js/server-utils.js',
  './js/pack-fetch.js',
]

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
    .then(() => self.clients.matchAll({ type: 'window' }))
    .then(clients => {
      clients.forEach(client => {
        const url = new URL(client.url)
        if (!url.searchParams.has('rvb_sw_refresh')) {
          url.searchParams.set('rvb_sw_refresh', Date.now().toString())
          client.navigate(url.toString()).catch(() => {})
        }
      })
    })
  )
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  // API 请求永远走网络，不缓存
  if (url.pathname.startsWith('/api/')) return

  // 资源包内容：优先读缓存（pack-fetch.js 会自行管理）
  if (url.pathname.includes('/data/')) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    )
    return
  }

  // HTML/JS/CSS：网络优先，失败时回退缓存
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
        }
        return res
      })
      .catch(() => caches.match(event.request))
  )
})
