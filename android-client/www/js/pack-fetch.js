/**
 * pack-fetch.js - IDB-first data fetch for resource pack support
 *
 * Android WebView does not always apply Service Worker interception reliably.
 * This script patches same-origin `./data/**` reads so imported pack files in
 * IndexedDB are returned before falling back to bundled APK assets.
 */
;(function () {
  const IDB_NAME = 'rvb-pack'
  const IDB_STORE = 'files'
  const nativeFetch = window.fetch.bind(window)

  let dbHandle = null
  let opening = null

  function openDb () {
    if (dbHandle) return Promise.resolve(dbHandle)
    if (opening) return opening
    opening = new Promise(function (resolve) {
      try {
        var req = indexedDB.open(IDB_NAME, 1)
        req.onupgradeneeded = function (e) {
          e.target.result.createObjectStore(IDB_STORE)
        }
        req.onsuccess = function (e) {
          dbHandle = e.target.result
          resolve(dbHandle)
        }
        req.onerror = function () { resolve(null) }
      } catch (_) {
        resolve(null)
      }
    })
    return opening
  }

  function toKey (path) {
    return ('/' + String(path).replace(/^\.\//, '')).replace(/\/{2,}/g, '/')
  }

  function isPackPath (value) {
    if (typeof value !== 'string') return false
    if (/^(https?:|capacitor:|file:|data:|blob:)/i.test(value)) return false
    return /^\.?\/?(data\/|.*\.html$)/.test(value)
  }

  async function readPackFile (path) {
    try {
      var db = await openDb()
      if (!db) return null
      return await new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_STORE, 'readonly')
          var req = tx.objectStore(IDB_STORE).get(toKey(path))
          req.onsuccess = function (e) { resolve(e.target.result || null) }
          req.onerror = function () { resolve(null) }
        } catch (_) {
          resolve(null)
        }
      })
    } catch (_) {
      return null
    }
  }

  function toUint8Array (data) {
    if (data instanceof Uint8Array) return data
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    return new Uint8Array(data || [])
  }

  window.fetchPackJson = async function fetchPackJson (path) {
    var file = await readPackFile(path)
    console.log('[pack-fetch] fetchPackJson called for:', path, 'file:', file ? 'found' : 'not found')
    if (file && file.data) {
      return JSON.parse(new TextDecoder().decode(toUint8Array(file.data)))
    }
    console.log('[pack-fetch] falling back to network for:', path)
    var res = await nativeFetch(path)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json()
  }

  window.fetchPackHtml = async function fetchPackHtml (pageName) {
    var file = await readPackFile(pageName)
    if (file && file.data) {
      return new TextDecoder().decode(toUint8Array(file.data))
    }
    var res = await nativeFetch(pageName)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.text()
  }

  window.fetch = async function patchedFetch (input, init) {
    var method = init && init.method ? String(init.method).toUpperCase() : 'GET'
    var path = typeof input === 'string' ? input : (input && input.url ? input.url : '')

    console.log('[pack-fetch] patchedFetch called for:', path, 'method:', method, 'isPackPath:', isPackPath(path))

    if (method === 'GET' && isPackPath(path)) {
      var file = await readPackFile(path)
      console.log('[pack-fetch] file check:', file ? 'found in IDB' : 'not in IDB')
      if (file && file.data) {
        return new Response(file.data, {
          status: 200,
          headers: {
            'Content-Type': file.mime || 'application/octet-stream',
            'X-Pack-Override': '1'
          }
        })
      }
    }

    return nativeFetch(input, init)
  }

  console.log('[pack-fetch] script loaded')
})()