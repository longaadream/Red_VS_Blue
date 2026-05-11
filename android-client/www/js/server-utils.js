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

  function getServerModeForUrl(url) {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\b/.test(url)) return 'local'
    if (/^http:\/\/(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(url)) return 'lan'
    return 'remote'
  }

  function saveServerUrl(url) {
    var mode = getServerModeForUrl(url)
    activateServerUrl(url, mode)
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

  function saveLocalServerUrl(url) {
    localStorage.setItem(LOCAL_SERVER_KEY, url)
    localStorage.setItem(REMOTE_SERVER_KEY, url)
    activateServerUrl(url, 'local')
    if (window.RvBBridge && typeof window.RvBBridge.saveUrl === 'function') {
      window.RvBBridge.saveUrl(url)
    }
  }

  function saveLanServerUrl(url) {
    localStorage.setItem(LAN_SERVER_KEY, url)
    localStorage.setItem(REMOTE_SERVER_KEY, url)
    activateServerUrl(url, 'lan')
    if (window.RvBBridge && typeof window.RvBBridge.saveUrl === 'function') {
      window.RvBBridge.saveUrl(url)
    }
  }

  function saveRemoteServerUrl(url) {
    localStorage.setItem(REMOTE_SERVER_KEY, url)
    activateServerUrl(url, 'remote')
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
          if (mode && mode.localUrl) return mode.localUrl
        } catch {}
      }
      if (typeof window.electronAPI.getHostInfo === 'function') {
        try {
          var host = await window.electronAPI.getHostInfo()
          if (host && host.localUrl) return host.localUrl
        } catch {}
      }
    }
    return ''
  }

  async function ensureServerMode(mode, fallbackUrl) {
    if (mode === 'local') {
      var localUrl = await detectLocalServerUrl()
      if (localUrl) {
        saveLocalServerUrl(localUrl)
        return true
      }
      if (switchServerMode('local')) return true
      if (fallbackUrl && getServerModeForUrl(fallbackUrl) === 'local') {
        saveLocalServerUrl(fallbackUrl)
        return true
      }
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
    var url = params.get('serverUrl') || params.get('url') || ''
    if (mode) return ensureServerMode(mode, url)
    mode = getActiveServerMode()
    if (mode) return ensureServerMode(mode, getServerUrl())
    return false
  }

  function appendServerParams(params) {
    params = params || new URLSearchParams()
    var mode = getActiveServerMode()
    var url = getServerUrl()
    if (mode) params.set('server', mode)
    if (url) params.set('serverUrl', url)
    return params
  }

  function clearServerUrl() {
    localStorage.removeItem(SERVER_KEY)
    localStorage.removeItem(MODE_KEY)
    localStorage.removeItem(LOCAL_SERVER_KEY)
    localStorage.removeItem(LAN_SERVER_KEY)
    localStorage.removeItem(REMOTE_SERVER_KEY)
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
    var raw = window.RvBBridge.requestMobileServer(
      method,
      path,
      body || '{}',
      JSON.stringify(headersToObject(options.headers))
    )
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
      return nativeAndroidLocalFetch(path, options)
    }

    try {
      res = await fetchWithTimeout(baseUrl + path, options)
    } catch (err) {
      if (err instanceof TypeError && isAndroidLocalMobileServer(baseUrl)) {
        return nativeAndroidLocalFetch(path, options)
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
    var urlsToTry = [cleanUrl]
    // Only add HTTP fallback candidate in non-secure contexts (avoid mixed content in Capacitor)
    if (cleanUrl.startsWith('https://') && !inSecureCtx) {
      urlsToTry.push(cleanUrl.replace('https://', 'http://'))
    }

    var lastErr = null
    var lastDetail = ''
    for (var i = 0; i < urlsToTry.length; i++) {
      var tryUrl = urlsToTry[i]
      try {
        var ctrl = new AbortController()
        var t = setTimeout(function () { ctrl.abort() }, timeoutMs)
        var res = await fetch(tryUrl + '/api/lobby', { signal: ctrl.signal })
        clearTimeout(t)
        // ANY HTTP response = server address is valid (frp is reachable)
        // Even 5xx counts — the frp proxy or server is responding
        saveServerUrl(tryUrl)
        return { success: true, url: tryUrl, status: res.status }
      } catch (e) {
        clearTimeout && clearTimeout()  // no-op if already cleared
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
    getServerUrl: getServerUrl,
    getServerUrlForMode: getServerUrlForMode,
    getActiveServerMode: getActiveServerMode,
    getServerModeForUrl: getServerModeForUrl,
    detectLocalServerUrl: detectLocalServerUrl,
    ensureServerMode: ensureServerMode,
    restoreServerFromParams: restoreServerFromParams,
    appendServerParams: appendServerParams,
    saveServerUrl: saveServerUrl,
    saveLocalServerUrl: saveLocalServerUrl,
    saveLanServerUrl: saveLanServerUrl,
    saveRemoteServerUrl: saveRemoteServerUrl,
    switchServerMode: switchServerMode,
    clearServerUrl: clearServerUrl,
    leaveCurrentRoom: leaveCurrentRoom,
    serverFetch: serverFetch,
    validateAndSaveServer: validateAndSaveServer,
  }
})()
