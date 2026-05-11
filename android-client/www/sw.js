const CACHE_NAME = 'rvb-v4-room-ready'
const STATIC_ASSETS = [
  './',
  './index.html',
  './lobby.html',
  './room.html',
  './login.html',
  './battle.html',
  './training.html',
  './piece-selection.html',
  './pieces.html',
  './maps.html',
  './pve.html',
  './pack.html',
  './history.html',
  './js/server-utils.js',
  './js/pack-fetch.js',
  './js/pve-api.js',
]

// 检测当前作用域是否是 file://（Electron 桌面版）—— Cache API 不支持 file://，整体跳过
const IS_FILE_SCHEME = (self.location && self.location.protocol === 'file:')

self.addEventListener('install', event => {
  if (IS_FILE_SCHEME) {
    // file:// 下 cache.addAll 会报错，直接 skipWaiting 让 SW 处于「无缓存透传」状态
    event.waitUntil(self.skipWaiting())
    return
  }
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()) // 任何 addAll 失败也不阻塞 SW 启动
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
  // file:// 下 SW 无法操作缓存，全部透传（不调用 respondWith，让浏览器走默认 file 加载）
  if (IS_FILE_SCHEME) return

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
