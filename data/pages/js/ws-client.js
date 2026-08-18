;(function () {
  'use strict'

  var _ws = null
  var _roomId = null
  var _playerId = null
  var _mode = 'lan'          // 'lan' | 'relay'
  var _handlers = {}
  var _pending = {}
  var _reqSeq = 1
  var _reconnectTimer = null
  var _shouldReconnect = false
  var _wsPort = 3001

  function parsePort(value) {
    var n = parseInt(value, 10)
    return Number.isFinite(n) && n > 0 && n <= 65535 ? n : null
  }

  function readExplicitQueryWsPort() {
    try {
      var params = new URLSearchParams(window.location.search || '')
      return parsePort(params.get('wsPort') || params.get('ws_port'))
    } catch {
      return null
    }
  }

  function readConfiguredWsPort() {
    if (window.RvBUtils && window.RvBUtils.getConfiguredWsPort) {
      var fromConfig = parsePort(window.RvBUtils.getConfiguredWsPort())
      if (fromConfig) return fromConfig
    }
    try {
      var params = new URLSearchParams(window.location.search || '')
      var fromQuery = parsePort(params.get('wsPort') || params.get('ws_port'))
      if (fromQuery) return fromQuery
    } catch {}
    try {
      var fromStorage = parsePort(localStorage.getItem('rvb_ws_port'))
      if (fromStorage) return fromStorage
    } catch {}
    return null
  }

  function getServerUrl() {
    if (window.RvBUtils && window.RvBUtils.getConnectionConfig) {
      var cfg = window.RvBUtils.getConnectionConfig()
      if (cfg && cfg.url) return cfg.url
    }
    return (window.RvBUtils && window.RvBUtils.getServerUrl)
      ? window.RvBUtils.getServerUrl()
      : (localStorage.getItem('rvb_server_url') || '')
  }

  function buildWsUrl() {
    var urls = buildWsUrlCandidates()
    return urls[0] || null
  }

  function pushUnique(list, value) {
    if (value && list.indexOf(value) === -1) list.push(value)
  }

  function buildWsUrlCandidates() {
    var base = getServerUrl()
    if (!base) return []
    var scheme = base.startsWith('https://') ? 'wss://' : 'ws://'
    var withoutScheme = base.replace(/^https?:\/\//, '').replace(/\/$/, '')
    var host = withoutScheme.replace(/:\d+$/, '').replace(/\/.*$/, '')
    var explicitPort = readConfiguredWsPort()
    var basePortMatch = withoutScheme.match(/:(\d+)(?:\/|$)/)
    var basePort = basePortMatch ? parsePort(basePortMatch[1]) : null
    var isLocalOrLan = /^(localhost|127\.0\.0\.1)(:\d+)?\b/.test(withoutScheme) ||
      /^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(withoutScheme)
    var urls = []

    if (explicitPort) pushUnique(urls, scheme + host + ':' + explicitPort + '/ws/rooms/' + _roomId)

    // Prefer the same public port for NAT/frp users who expose a single HTTP port.
    if (base.startsWith('http://') && !isLocalOrLan) {
      pushUnique(urls, 'wss://' + withoutScheme + '/ws/rooms/' + _roomId)
    }
    pushUnique(urls, scheme + withoutScheme + '/ws/rooms/' + _roomId)

    if (_mode === 'relay') {
      if (basePort) pushUnique(urls, scheme + host + ':' + (basePort + 1) + '/ws/rooms/' + _roomId)
      pushUnique(urls, scheme + host + ':' + _wsPort + '/ws/rooms/' + _roomId)
    } else {
      if (basePort) pushUnique(urls, scheme + host + ':' + (basePort + 1) + '/ws/rooms/' + _roomId)
      pushUnique(urls, scheme + host + ':' + _wsPort + '/ws/rooms/' + _roomId)
    }
    return urls
  }

  async function buildSubscribeMessage() {
    var roomId = String(_roomId || '').trim().toLowerCase()
    var playerId = String(_playerId || '').trim().toLowerCase()
    var message = { type: 'subscribe', roomId: roomId, playerId: playerId }
    if (_mode !== 'relay') return message

    if (!window.RvBIdentity || typeof window.RvBIdentity.sign !== 'function') {
      throw new Error('Signed identity is required for Relay WebSocket subscriptions')
    }
    var identity = window.RvBIdentity.getIdentity && window.RvBIdentity.getIdentity()
    if (!identity || String(identity.id || '').toLowerCase() !== playerId) {
      throw new Error('Active identity does not match the Relay WebSocket player')
    }
    var publicKey = window.RvBIdentity.getPublicKey && window.RvBIdentity.getPublicKey()
    if (!publicKey) throw new Error('Relay WebSocket identity has no public key')

    var payload = {
      type: 'battle-subscribe',
      roomId: roomId,
      playerId: playerId,
      timestamp: Date.now(),
    }
    return {
      type: 'subscribe',
      roomId: roomId,
      playerId: playerId,
      publicKey: publicKey,
      payload: payload,
      signature: await window.RvBIdentity.sign(payload),
    }
  }

  async function connectWithHttpPortProbe(roomId) {
    var configured = readConfiguredWsPort()
    if (configured) _wsPort = configured

    var base = getServerUrl()
    var withoutScheme = String(base || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
    var basePortMatch = withoutScheme.match(/:(\d+)(?:\/|$)/)
    var basePort = basePortMatch ? parsePort(basePortMatch[1]) : null
    var isLocalOrLan = /^(localhost|127\.0\.0\.1)(:\d+)?\b/.test(withoutScheme) ||
      /^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(withoutScheme)
    var shouldProbe = !configured || (
      !readExplicitQueryWsPort() &&
      configured === 3000 &&
      basePort === 3000 &&
      isLocalOrLan
    )
    if (!shouldProbe) {
      _doConnect(roomId)
      return
    }

    if (base && typeof fetch === 'function') {
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null
      var timeout = controller ? setTimeout(function () { controller.abort() }, 1500) : null
      try {
        var response = await fetch(base.replace(/\/$/, '') + '/api/ws-info', {
          cache: 'no-store',
          signal: controller ? controller.signal : undefined,
        })
        if (response.ok) {
          var info = await response.json()
          var discovered = parsePort(info && info.wsPort)
          if (discovered) {
            _wsPort = discovered
            try { localStorage.setItem('rvb_ws_port', String(discovered)) } catch {}
          }
        }
      } catch {}
      finally {
        if (timeout) clearTimeout(timeout)
      }
    }

    _doConnect(roomId)
  }

  function _doConnect(roomId, candidateIndex) {
    if (_ws && (_ws.readyState === 0 || _ws.readyState === 1)) return
    candidateIndex = candidateIndex || 0
    var candidates = buildWsUrlCandidates()
    var url = candidates[candidateIndex]
    if (!url) return

    var opened = false
    try {
      _ws = new WebSocket(url)
    } catch (e) {
      if (candidateIndex + 1 < candidates.length) _doConnect(roomId, candidateIndex + 1)
      else _scheduleReconnect(roomId)
      return
    }

    _ws.onopen = async function () {
      opened = true
      if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null }
      try {
        var subscribeMessage = await buildSubscribeMessage()
        if (!_ws || _ws.readyState !== 1) return
        _ws.send(JSON.stringify(subscribeMessage))
        _emit('connect')
      } catch (e) {
        console.error('[WS] subscribe failed', e)
        _emit('error', e)
        _shouldReconnect = false
        if (_ws) _ws.close()
      }
    }

    _ws.onmessage = function (e) {
      try {
        var msg = JSON.parse(e.data)
        if (msg && msg.type === 'rpcResult' && msg.requestId && _pending[msg.requestId]) {
          var pending = _pending[msg.requestId]
          delete _pending[msg.requestId]
          clearTimeout(pending.timer)
          if (msg.ok) pending.resolve(msg.data)
          else pending.reject(new Error(msg.error || 'WebSocket RPC failed'))
          return
        }
        _emit('message', msg)
      } catch {}
    }

    _ws.onclose = function () {
      if (!opened && candidateIndex + 1 < candidates.length) {
        _ws = null
        _doConnect(roomId, candidateIndex + 1)
        return
      }
      _emit('disconnect')
      if (_shouldReconnect) _scheduleReconnect(_roomId)
    }

    _ws.onerror = function () {}
  }

  function _scheduleReconnect(roomId) {
    if (!_shouldReconnect || _reconnectTimer) return
    _reconnectTimer = setTimeout(function () {
      _reconnectTimer = null
      if (_shouldReconnect) _doConnect(roomId)
    }, 3000)
  }

  function _emit(event, data) {
    if (_handlers[event]) {
      try { _handlers[event](data) } catch (e) { console.error('[WS]', event, e) }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  // connect(roomId, playerId, mode)
  // mode: 'relay' for online relay server, 'lan' (default) for local LAN server
  function connect(roomId, playerId, mode) {
    _roomId = roomId
    _playerId = playerId || null
    _mode = mode || 'lan'
    _shouldReconnect = true
    if (_mode === 'relay') {
      _doConnect(roomId)
    } else {
      connectWithHttpPortProbe(roomId)
    }
  }

  function setWsPort(port) {
    var parsed = parsePort(port)
    if (!parsed) return false
    _wsPort = parsed
    try { localStorage.setItem('rvb_ws_port', String(parsed)) } catch {}
    return true
  }

  function disconnect() {
    _shouldReconnect = false
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null }
    if (_ws) { try { _ws.close() } catch {} _ws = null }
  }

  function send(msg) {
    if (_ws && _ws.readyState === 1) {
      try { _ws.send(JSON.stringify(msg)) } catch {}
    }
  }

  function request(method, data, timeoutMs) {
    timeoutMs = timeoutMs || 5000
    return new Promise(function (resolve, reject) {
      if (!_ws || _ws.readyState !== 1) {
        reject(new Error('WebSocket not connected'))
        return
      }
      var requestId = 'r' + (_reqSeq++) + '-' + Date.now()
      var timer = setTimeout(function () {
        if (_pending[requestId]) {
          delete _pending[requestId]
          reject(new Error('WebSocket request timeout: ' + method))
        }
      }, timeoutMs)
      _pending[requestId] = { resolve: resolve, reject: reject, timer: timer }
      try {
        _ws.send(JSON.stringify({ type: 'rpc', requestId: requestId, method: method, data: data || {} }))
      } catch (e) {
        clearTimeout(timer)
        delete _pending[requestId]
        reject(e)
      }
    })
  }

  function on(event, handler) {
    _handlers[event] = handler
  }

  function isConnected() {
    return _ws !== null && _ws.readyState === 1
  }

  window.RvBWs = { connect: connect, disconnect: disconnect, send: send, request: request, on: on, isConnected: isConnected, setWsPort: setWsPort }
})()
