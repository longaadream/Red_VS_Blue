/**
 * server-utils.js — shared server connection utilities
 * Included by: index.html, login.html, lobby.html, training.html, piece-selection.html
 *
 * Key feature: automatic HTTPS→HTTP fallback.
 * If the saved URL is https:// and the fetch fails (SSL error, no TLS on frp),
 * it transparently retries with http:// and updates the saved URL.
 */
;(function () {
  'use strict'

  var SERVER_KEY = 'rvb_server_url'
  var MODE_KEY = 'rvb_lobby_server_mode'
  var LOCAL_SERVER_KEY = 'rvb_local_server_url'
  var LAN_SERVER_KEY = 'rvb_lan_server_url'
  var REMOTE_SERVER_KEY = 'rvb_remote_server_url'
  var WS_PORT_KEY = 'rvb_ws_port'

  function normalizeServerUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '')
  }

  function getServerUrl() {
    var mode = localStorage.getItem(MODE_KEY) || ''
    var expectedUrl = getServerUrlForMode(mode)
    if (expectedUrl) {
      var currentUrl = localStorage.getItem(SERVER_KEY) || ''
      if (currentUrl !== expectedUrl) activateServerUrl(expectedUrl, mode)
      return expectedUrl
    }
    return localStorage.getItem(SERVER_KEY) || ''
  }

  function getServerUrlForMode(mode) {
    if (mode === 'local') return localStorage.getItem(LOCAL_SERVER_KEY) || ''
    if (mode === 'lan') return localStorage.getItem(LAN_SERVER_KEY) || ''
    if (mode === 'remote') return localStorage.getItem(REMOTE_SERVER_KEY) || ''
    return ''
  }

  function getActiveServerMode() {
    var savedMode = localStorage.getItem(MODE_KEY) || ''
    if (savedMode && getServerUrlForMode(savedMode)) return savedMode
    var currentUrl = localStorage.getItem(SERVER_KEY) || ''
    return currentUrl ? getServerModeForUrl(currentUrl) : savedMode
  }

  function activateServerUrl(url, mode) {
    localStorage.setItem(SERVER_KEY, url)
    localStorage.setItem(MODE_KEY, mode)
  }

  function isLocalOrLanUrl(url) {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\b/.test(url) ||
      /^http:\/\/(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(url)
  }

  function shouldTryHttpsForHttp(url) {
    return /^http:\/\//.test(url) && !isLocalOrLanUrl(url)
  }

  async function fetchServerProbe(baseUrl, timeoutMs) {
    var ctrl = new AbortController()
    var t = setTimeout(function () { ctrl.abort() }, timeoutMs)
    try {
      return await fetch(baseUrl + '/api/ping', { signal: ctrl.signal })
    } finally {
      clearTimeout(t)
    }
  }

  function getServerModeForUrl(url) {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\b/.test(url)) return 'local'
    if (/^http:\/\/(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(url)) return 'lan'
    return 'remote'
  }

  function saveWsPort(wsPort) {
    var n = parseInt(wsPort, 10)
    if (Number.isFinite(n) && n > 0 && n <= 65535) {
      localStorage.setItem(WS_PORT_KEY, String(n))
      return n
    }
    return null
  }

  function getConfiguredWsPort(search) {
    try {
      var params = search instanceof URLSearchParams
        ? search
        : new URLSearchParams(search || (window.location && window.location.search) || '')
      var fromQuery = saveWsPort(params.get('wsPort') || params.get('ws_port'))
      if (fromQuery) return fromQuery
    } catch {}
    return saveWsPort(localStorage.getItem(WS_PORT_KEY))
  }

  function saveServerConfig(config) {
    config = config || {}
    var url = normalizeServerUrl(config.url || config.serverUrl)
    if (!url) return false
    var mode = config.mode || getServerModeForUrl(url)
    var wsPort = config.wsPort || config.ws_port
    if (mode === 'local') saveLocalServerUrl(url, wsPort)
    else if (mode === 'lan') saveLanServerUrl(url, wsPort)
    else if (mode === 'remote') saveRemoteServerUrl(url, wsPort)
    else saveServerUrl(url, wsPort)
    return true
  }

  function getConnectionConfig(search) {
    var params = null
    try {
      params = search instanceof URLSearchParams
        ? search
        : new URLSearchParams(search || (window.location && window.location.search) || '')
    } catch {}
    var url = ''
    var mode = ''
    if (params) {
      url = normalizeServerUrl(params.get('serverUrl') || params.get('url') || '')
      mode = params.get('server') || ''
    }
    if (!url) url = getServerUrl()
    if (!mode) mode = getActiveServerMode() || getServerModeForUrl(url)
    return { mode: mode, url: url, serverUrl: url, wsPort: getConfiguredWsPort(params) }
  }

  function saveServerUrl(url, wsPort) {
    url = normalizeServerUrl(url)
    var mode = getServerModeForUrl(url)
    activateServerUrl(url, mode)
    if (wsPort) saveWsPort(wsPort)
    if (mode === 'remote') {
      localStorage.setItem(REMOTE_SERVER_KEY, url)
    } else if (mode === 'local') {
      localStorage.setItem(LOCAL_SERVER_KEY, url)
      localStorage.setItem(REMOTE_SERVER_KEY, url)
    } else if (mode === 'lan') {
      localStorage.setItem(LAN_SERVER_KEY, url)
      localStorage.setItem(REMOTE_SERVER_KEY, url)
    }
    if (window.RvBBridge && typeof window.RvBBridge.saveUrl === 'function') {
      window.RvBBridge.saveUrl(url)
    }
  }

  function saveLocalServerUrl(url, wsPort) {
    url = normalizeServerUrl(url)
    localStorage.setItem(LOCAL_SERVER_KEY, url)
    localStorage.setItem(REMOTE_SERVER_KEY, url)
    activateServerUrl(url, 'local')
    if (wsPort) saveWsPort(wsPort)
    if (window.RvBBridge && typeof window.RvBBridge.saveUrl === 'function') {
      window.RvBBridge.saveUrl(url)
    }
  }

  function saveLanServerUrl(url, wsPort) {
    url = normalizeServerUrl(url)
    localStorage.setItem(LAN_SERVER_KEY, url)
    localStorage.setItem(REMOTE_SERVER_KEY, url)
    activateServerUrl(url, 'lan')
    if (wsPort) saveWsPort(wsPort)
    if (window.RvBBridge && typeof window.RvBBridge.saveUrl === 'function') {
      window.RvBBridge.saveUrl(url)
    }
  }

  function saveRemoteServerUrl(url, wsPort) {
    url = normalizeServerUrl(url)
    localStorage.setItem(REMOTE_SERVER_KEY, url)
    activateServerUrl(url, 'remote')
    if (wsPort) saveWsPort(wsPort)
    if (window.RvBBridge && typeof window.RvBBridge.saveUrl === 'function') {
      window.RvBBridge.saveUrl(url)
    }
  }

  function switchServerMode(mode) {
    var url = getServerUrlForMode(mode)
    if (!url) return false
    activateServerUrl(url, mode)
    return true
  }

  function parseBridgeJson(raw) {
    try { return JSON.parse(raw || '{}') } catch { return {} }
  }

  async function detectLocalServerUrl() {
    if (window.RvBBridge) {
      if (typeof window.RvBBridge.getMobileServerStatus === 'function') {
        var status = parseBridgeJson(window.RvBBridge.getMobileServerStatus())
        if (status && status.running) return 'http://localhost:7878'
      }
      return 'http://localhost:7878'
    }
    if (window.electronAPI) {
      if (typeof window.electronAPI.getMode === 'function') {
        try {
          var mode = await window.electronAPI.getMode()
          if (mode && mode.wsPort) saveWsPort(mode.wsPort)
          if (mode && mode.localUrl) return mode.localUrl
        } catch {}
      }
      if (typeof window.electronAPI.getHostInfo === 'function') {
        try {
          var host = await window.electronAPI.getHostInfo()
          if (host && host.wsPort) saveWsPort(host.wsPort)
          if (host && host.localUrl) return host.localUrl
        } catch {}
      }
    }
    return ''
  }

  async function ensureServerMode(mode, fallbackUrl) {
    if (mode === 'local') {
      if (fallbackUrl && getServerModeForUrl(fallbackUrl) === 'local') {
        saveLocalServerUrl(fallbackUrl)
        return true
      }
      var localUrl = await detectLocalServerUrl()
      if (localUrl) {
        saveLocalServerUrl(localUrl)
        return true
      }
      if (switchServerMode('local')) return true
      return false
    }
    if (mode === 'lan') {
      if (fallbackUrl && getServerModeForUrl(fallbackUrl) === 'lan') {
        saveLanServerUrl(fallbackUrl)
        return true
      }
      return switchServerMode('lan')
    }
    if (mode === 'remote') {
      if (fallbackUrl && getServerModeForUrl(fallbackUrl) === 'remote') {
        saveRemoteServerUrl(fallbackUrl)
        return true
      }
      return switchServerMode('remote')
    }
    return false
  }

  async function restoreServerFromParams(search) {
    var params = search instanceof URLSearchParams
      ? search
      : new URLSearchParams(search || (window.location && window.location.search) || '')
    var mode = params.get('server') || ''
    var url = normalizeServerUrl(params.get('serverUrl') || params.get('url') || '')
    var wsPort = params.get('wsPort') || params.get('ws_port') || ''
    if (url) return saveServerConfig({ mode: mode || getServerModeForUrl(url), url: url, wsPort: wsPort })
    if (mode) return ensureServerMode(mode, url)
    mode = getActiveServerMode()
    if (mode) return ensureServerMode(mode, getServerUrl())
    return false
  }

  function appendServerParams(params) {
    params = params || new URLSearchParams()
    var mode = getActiveServerMode()
    var url = getServerUrl()
    var wsPort = getConfiguredWsPort()
    if (mode) params.set('server', mode)
    if (url) params.set('serverUrl', url)
    if (wsPort) params.set('wsPort', String(wsPort))
    return params
  }

  function clearServerUrl() {
    localStorage.removeItem(SERVER_KEY)
    localStorage.removeItem(MODE_KEY)
    localStorage.removeItem(LOCAL_SERVER_KEY)
    localStorage.removeItem(LAN_SERVER_KEY)
    localStorage.removeItem(REMOTE_SERVER_KEY)
    localStorage.removeItem(WS_PORT_KEY)
    if (window.RvBBridge && typeof window.RvBBridge.clearUrl === 'function') {
      window.RvBBridge.clearUrl()
    }
  }

  async function leaveCurrentRoom() {
    var mode = localStorage.getItem(MODE_KEY) || getServerModeForUrl(getServerUrl())
    if (mode) return ensureServerMode(mode, getServerUrl())
    return false
  }

  function fetchWithTimeout(url, options, timeoutMs) {
    options = options || {}
    timeoutMs = timeoutMs || options.timeoutMs || 10000
    var ctrl = new AbortController()
    var timer = setTimeout(function () { ctrl.abort() }, timeoutMs)
    var fetchOptions = {}
    Object.keys(options).forEach(function (key) {
      if (key !== 'timeoutMs') fetchOptions[key] = options[key]
    })
    fetchOptions.signal = options.signal || ctrl.signal
    return fetch(url, fetchOptions).finally(function () { clearTimeout(timer) })
  }

  function asConnectionError(baseUrl, err) {
    var message = err && err.name === 'AbortError'
      ? '服务器响应超时'
      : ((err && err.message) || 'Failed to fetch')
    var out = new Error('无法连接服务器：' + message + '（服务器：' + baseUrl + '）')
    out.code = err && err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR'
    out.cause = err
    return out
  }

  function isAndroidLocalMobileServer(baseUrl) {
    return !!(
      window.RvBBridge &&
      typeof window.RvBBridge.requestMobileServer === 'function' &&
      /^http:\/\/(localhost|127\.0\.0\.1):7878\b/.test(baseUrl)
    )
  }

  function headersToObject(headers) {
    var out = {}
    if (!headers) return out
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      headers.forEach(function (value, key) { out[key] = value })
      return out
    }
    if (Array.isArray(headers)) {
      headers.forEach(function (pair) { if (pair && pair.length >= 2) out[pair[0]] = pair[1] })
      return out
    }
    Object.keys(headers).forEach(function (key) { out[key] = headers[key] })
    return out
  }

  async function nativeAndroidLocalFetch(path, options) {
    options = options || {}
    var method = (options.method || 'GET').toUpperCase()
    var body = typeof options.body === 'string'
      ? options.body
      : (options.body ? JSON.stringify(options.body) : '{}')
    var headersJson = JSON.stringify(headersToObject(options.headers))
    var raw
    if (typeof window.RvBBridge.requestMobileServerAsync === 'function') {
      raw = await new Promise(function (resolve, reject) {
        var callbackId = 'cb' + Date.now().toString(36) + Math.random().toString(36).slice(2)
        var timer = setTimeout(function () {
          delete window._rvbMobileServerCallbacks[callbackId]
          reject(new Error('Request timeout'))
        }, options.timeoutMs || 30000)
        window._rvbMobileServerCallbacks = window._rvbMobileServerCallbacks || {}
        window._rvbMobileServerCallbacks[callbackId] = function (responseJson) {
          clearTimeout(timer)
          delete window._rvbMobileServerCallbacks[callbackId]
          resolve(responseJson || '{}')
        }
        try {
          window.RvBBridge.requestMobileServerAsync(
            method,
            path,
            body || '{}',
            headersJson,
            callbackId
          )
        } catch (e) {
          clearTimeout(timer)
          delete window._rvbMobileServerCallbacks[callbackId]
          reject(e)
        }
      })
    } else
    if (typeof window.RvBBridge.beginMobileServerRequest === 'function' &&
        typeof window.RvBBridge.appendMobileServerRequestChunk === 'function' &&
        typeof window.RvBBridge.finishMobileServerRequest === 'function') {
      var reqId = window.RvBBridge.beginMobileServerRequest(method, path, headersJson)
      var payload = body || '{}'
      var chunkSize = 48 * 1024
      for (var i = 0; i < payload.length; i += chunkSize) {
        window.RvBBridge.appendMobileServerRequestChunk(reqId, payload.slice(i, i + chunkSize))
      }
      raw = window.RvBBridge.finishMobileServerRequest(reqId)
      try {
        var maybeChunked = JSON.parse(raw || '{}')
        if (maybeChunked && maybeChunked._bridgeChunked && maybeChunked.responseId &&
            typeof window.RvBBridge.getMobileServerResponseChunkCount === 'function' &&
            typeof window.RvBBridge.getMobileServerResponseChunk === 'function') {
          var responseId = maybeChunked.responseId
          var count = Number(window.RvBBridge.getMobileServerResponseChunkCount(responseId) || 0)
          var assembled = ''
          for (var j = 0; j < count; j++) {
            assembled += window.RvBBridge.getMobileServerResponseChunk(responseId, j)
          }
          if (typeof window.RvBBridge.clearMobileServerResponse === 'function') {
            window.RvBBridge.clearMobileServerResponse(responseId)
          }
          raw = assembled
        }
      } catch {}
    } else {
      raw = window.RvBBridge.requestMobileServer(
        method,
        path,
        body || '{}',
        headersJson
      )
    }
    var payload
    try { payload = JSON.parse(raw || '{}') } catch { payload = { error: raw || '' } }
    var status = Number(payload._status || 200)
    delete payload._status
    return {
      ok: status >= 200 && status < 300,
      status: status,
      headers: { get: function (name) { return name && name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : '' } },
      json: async function () { return payload },
      text: async function () { return JSON.stringify(payload) },
    }
  }

  function getAndroidMobileServerStatus() {
    if (!window.RvBBridge || typeof window.RvBBridge.getMobileServerStatus !== 'function') {
      return { ok: false, running: false }
    }
    return parseBridgeJson(window.RvBBridge.getMobileServerStatus())
  }

  function getAndroidMobileServerDebugText() {
    if (!window.RvBBridge || typeof window.RvBBridge.getMobileServerDebugStatus !== 'function') return ''
    try {
      var dbg = parseBridgeJson(window.RvBBridge.getMobileServerDebugStatus())
      var engine = dbg && dbg.engine ? dbg.engine : {}
      return [
        'stage=' + (dbg.stage || ''),
        'running=' + !!dbg.running,
        'starting=' + !!dbg.starting,
        'selfTest=' + (dbg.selfTest || ''),
        'engine=' + (engine.lastEvent || 'none'),
        engine.lastError ? ('engineError=' + engine.lastError) : '',
        dbg.lastError ? ('error=' + dbg.lastError) : '',
      ].filter(Boolean).join('; ')
    } catch {
      return ''
    }
  }

  function ensureAndroidMobileServer(timeoutMs) {
    timeoutMs = timeoutMs || 65000
    if (!window.RvBBridge || typeof window.RvBBridge.startMobileServer !== 'function') {
      return Promise.resolve({ ok: false, running: false })
    }

    var status = getAndroidMobileServerStatus()
    if (status && status.running) return Promise.resolve(status)

    return new Promise(function (resolve, reject) {
      var done = false
      var previousReady = window._onMobileServerReady
      var startedAt = Date.now()
      var timer = null
      var poller = null

      function finish(err, value) {
        if (done) return
        done = true
        clearTimeout(timer)
        clearInterval(poller)
        if (window._onMobileServerReady === onReady) window._onMobileServerReady = previousReady
        if (err) reject(err)
        else resolve(value)
      }

      function onReady(nextStatus) {
        if (typeof previousReady === 'function') {
          try { previousReady(nextStatus) } catch {}
        }
        if (nextStatus && (nextStatus.running || nextStatus.ok)) {
          finish(null, nextStatus)
        } else {
          finish(new Error((nextStatus && nextStatus.error) || 'Mobile server failed to start'))
        }
      }

      window._onMobileServerReady = onReady
      timer = setTimeout(function () {
        var detail = getAndroidMobileServerDebugText()
        finish(new Error('Mobile server startup timeout' + (detail ? ' (' + detail + ')' : '')))
      }, timeoutMs)

      poller = setInterval(function () {
        var current = getAndroidMobileServerStatus()
        if (current && current.running) finish(null, current)
        else if (Date.now() - startedAt > timeoutMs) {
          var detail = getAndroidMobileServerDebugText()
          finish(new Error('Mobile server startup timeout' + (detail ? ' (' + detail + ')' : '')))
        }
      }, 500)

      try {
        var startStatus = parseBridgeJson(window.RvBBridge.startMobileServer() || '{}')
        if (startStatus && (startStatus.running || startStatus.ok)) finish(null, startStatus)
        else if (startStatus && startStatus.error) finish(new Error(startStatus.error))
      } catch (e) {
        finish(e)
      }
    })
  }

  function ensureAndroidMobileEngine(timeoutMs) {
    timeoutMs = timeoutMs || 65000
    if (!window.RvBBridge) return Promise.resolve({ ok: false, ready: false })
    if (typeof window.RvBBridge.getMobileServerDebugStatus === 'function') {
      var debug = parseBridgeJson(window.RvBBridge.getMobileServerDebugStatus())
      if (debug && debug.engine && debug.engine.ready) return Promise.resolve({ ok: true, ready: true })
    }
    if (typeof window.RvBBridge.startMobileEngine !== 'function') {
      return ensureAndroidMobileServer(timeoutMs)
    }

    return new Promise(function (resolve, reject) {
      var done = false
      var previousReady = window._onMobileServerReady
      var timer = null
      var poller = null

      function finish(err, value) {
        if (done) return
        done = true
        clearTimeout(timer)
        clearInterval(poller)
        if (window._onMobileServerReady === onReady) window._onMobileServerReady = previousReady
        if (err) reject(err)
        else resolve(value)
      }

      function onReady(nextStatus) {
        if (typeof previousReady === 'function') {
          try { previousReady(nextStatus) } catch {}
        }
        if (nextStatus && (nextStatus.ready || nextStatus.running || nextStatus.ok)) {
          finish(null, nextStatus)
        } else if (nextStatus && nextStatus.error) {
          finish(new Error(nextStatus.error))
        }
      }

      window._onMobileServerReady = onReady
      timer = setTimeout(function () {
        var detail = getAndroidMobileServerDebugText()
        finish(new Error('Mobile engine startup timeout' + (detail ? ' (' + detail + ')' : '')))
      }, timeoutMs)

      poller = setInterval(function () {
        var debug = typeof window.RvBBridge.getMobileServerDebugStatus === 'function'
          ? parseBridgeJson(window.RvBBridge.getMobileServerDebugStatus())
          : {}
        if (debug && debug.engine && debug.engine.ready) finish(null, { ok: true, ready: true })
      }, 500)

      try {
        var startStatus = parseBridgeJson(window.RvBBridge.startMobileEngine() || '{}')
        if (startStatus && (startStatus.ready || startStatus.ok)) finish(null, startStatus)
        else if (startStatus && startStatus.error) finish(new Error(startStatus.error))
      } catch (e) {
        finish(e)
      }
    })
  }

  async function mobileServerFetch(path, options) {
    await ensureAndroidMobileEngine()
    return nativeAndroidLocalFetch(path, options)
  }

  /**
   * Drop-in replacement for fetch() that targets the saved server URL.
   * path: e.g. '/api/auth/login'
   * options: same as fetch() options
   *
   * On TypeError (SSL failure, network unreachable), automatically retries
   * with HTTP if the saved URL was HTTPS, and saves the working URL.
   *
   * After getting a response, checks Content-Type. If the server returns HTML
   * instead of JSON (frp portal page, proxy error, etc.), throws a clear error
   * instead of letting JSON.parse fail with a cryptic message.
   */
  async function serverFetch(path, options) {
    var baseUrl = getServerUrl()
    if (!baseUrl) {
      var e = new Error('未连接服务器')
      e.code = 'NO_SERVER'
      throw e
    }
    options = options || {}

    // In a secure context (Capacitor https://localhost), fetching http:// remote
    // servers may be blocked as mixed content. Upgrade stale http:// URLs to
    // https:// — but only for non-local addresses. Local servers (localhost,
    // 127.x, LAN IPs) always run plain HTTP and must NOT be upgraded.
    var inSecureCtx = typeof window !== 'undefined' && window.isSecureContext
    var isLocalAddr = /localhost|127\.0\.0\.1/.test(baseUrl) ||
      /^http:\/\/(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(baseUrl)
    if (inSecureCtx && !isLocalAddr && baseUrl.startsWith('http://')) {
      baseUrl = baseUrl.replace('http://', 'https://')
      saveServerUrl(baseUrl)
    }

    var res
    if (isAndroidLocalMobileServer(baseUrl)) {
      return mobileServerFetch(path, options)
    }

    try {
      res = await fetchWithTimeout(baseUrl + path, options)
    } catch (err) {
      if (err instanceof TypeError && isAndroidLocalMobileServer(baseUrl)) {
        return mobileServerFetch(path, options)
      }
      // Only fall back to HTTP in non-secure contexts; in secure contexts
      // (Capacitor androidScheme=https) mixed-content blocks http:// fetches.
      if (err instanceof TypeError && baseUrl.startsWith('https://') && !inSecureCtx) {
        var httpUrl = baseUrl.replace('https://', 'http://')
        try {
          res = await fetchWithTimeout(httpUrl + path, options)
        } catch (httpErr) {
          throw asConnectionError(httpUrl, httpErr)
        }
        // HTTP worked — persist the corrected URL so future calls don't retry
        saveServerUrl(httpUrl)
      } else {
        throw asConnectionError(baseUrl, err)
      }
    }

    // Guard: if response is HTML (frp portal / proxy error page), throw early
    var ct = res.headers.get('content-type') || ''
    if (ct.includes('text/html')) {
      var htmlErr = new Error(
        'frp 代理返回了 HTML 页面（状态 ' + res.status + '），' +
        '请确认 frp 客户端已启动且隧道指向游戏服务器端口'
      )
      htmlErr.code = 'HTML_RESPONSE'
      htmlErr.status = res.status
      throw htmlErr
    }

    return res
  }

  /**
   * Validate a server URL and save it.
   * Tries HTTPS (as entered), then HTTP (auto-fallback).
   * Also auto-prepends http:// if the user forgot the scheme.
   *
   * "Success" = any HTTP response was received (even 5xx counts — frp proxy
   * is reachable even if the backend returned an error).
   * "Failure" = network-level error (TypeError: no connection at all).
   *
   * Returns { success, url } or { success: false, error, isTimeout, detail }
   */
  async function validateAndSaveServer(rawUrl, timeoutMs) {
    timeoutMs = timeoutMs || 10000
    var cleanUrl = rawUrl.trim().replace(/\/$/, '')

    // Auto-add scheme if missing
    if (cleanUrl && !cleanUrl.startsWith('http')) cleanUrl = 'http://' + cleanUrl

    var inSecureCtx = typeof window !== 'undefined' && window.isSecureContext
    var urlsToTry = []
    if (shouldTryHttpsForHttp(cleanUrl)) {
      urlsToTry.push(cleanUrl.replace('http://', 'https://'))
    }
    urlsToTry.push(cleanUrl)
    // Only add HTTP fallback candidate in non-secure contexts (avoid mixed content in Capacitor)
    if (cleanUrl.startsWith('https://') && !inSecureCtx) {
      urlsToTry.push(cleanUrl.replace('https://', 'http://'))
    }

    var lastErr = null
    var lastDetail = ''
    for (var i = 0; i < urlsToTry.length; i++) {
      var tryUrl = urlsToTry[i]
      try {
        var res = await fetchServerProbe(tryUrl, timeoutMs)
        var ct = res.headers.get('content-type') || ''
        if (!res.ok || ct.includes('text/html')) {
          throw new Error('probe failed: HTTP ' + res.status)
        }
        // ANY HTTP response = server address is valid (frp is reachable)
        // Even 5xx counts — the frp proxy or server is responding
        saveServerUrl(tryUrl)
        return { success: true, url: tryUrl, status: res.status }
      } catch (e) {
        lastErr = e
        lastDetail = tryUrl + ' → ' + (e.name === 'AbortError' ? 'timeout' : e.message)
      }
    }

    return {
      success: false,
      error: lastErr,
      isTimeout: lastErr && lastErr.name === 'AbortError',
      detail: lastDetail,
    }
  }

  // Expose globally
  window.RvBUtils = {
    SERVER_KEY: SERVER_KEY,
    WS_PORT_KEY: WS_PORT_KEY,
    getServerUrl: getServerUrl,
    getConnectionConfig: getConnectionConfig,
    getConfiguredWsPort: getConfiguredWsPort,
    getServerUrlForMode: getServerUrlForMode,
    getActiveServerMode: getActiveServerMode,
    getServerModeForUrl: getServerModeForUrl,
    detectLocalServerUrl: detectLocalServerUrl,
    ensureServerMode: ensureServerMode,
    restoreServerFromParams: restoreServerFromParams,
    appendServerParams: appendServerParams,
    saveServerConfig: saveServerConfig,
    saveServerUrl: saveServerUrl,
    saveLocalServerUrl: saveLocalServerUrl,
    saveLanServerUrl: saveLanServerUrl,
    saveRemoteServerUrl: saveRemoteServerUrl,
    switchServerMode: switchServerMode,
    clearServerUrl: clearServerUrl,
    leaveCurrentRoom: leaveCurrentRoom,
    ensureAndroidMobileServer: ensureAndroidMobileServer,
    ensureAndroidMobileEngine: ensureAndroidMobileEngine,
    getAndroidMobileServerDebugText: getAndroidMobileServerDebugText,
    mobileServerFetch: mobileServerFetch,
    serverFetch: serverFetch,
    validateAndSaveServer: validateAndSaveServer,
  }
})()
