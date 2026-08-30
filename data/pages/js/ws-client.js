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
  var _subscribed = false
  var _authoritySyncing = false
  var _authoritySyncTimer = null
  var _authoritySyncRequestId = null
  var AUTHORITY_SYNC_TIMEOUT_MS = 8000
  var BATTLE_AUTHORITY_PROTOCOL_VERSION = 3
  var BATTLE_AUTHORITY_BUILD_ID = 'rvb-authority-v3-chunked-sha256-1'

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
    var base = String(getServerUrl() || '').trim().replace(/\/+$/, '')
    if (!base) return null
    return base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') + '/ws/rooms/' + _roomId
  }

  async function buildSubscribeMessage() {
    var roomId = String(_roomId || '').trim().toLowerCase()
    var playerId = String(_playerId || '').trim().toLowerCase()
    var message = {
      type: 'subscribe',
      roomId: roomId,
      playerId: playerId,
      protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
      authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
      profileIdentity: null,
    }
    var storedProfile = null
    var profileIdentity = null
    if (roomId !== '__lobby') {
      storedProfile = localStorage.getItem('rvb_game_profile_identity')
      try {
        profileIdentity = storedProfile ? JSON.parse(storedProfile) : null
      } catch (e) {
        throw new Error('Stored game profile identity is malformed')
      }
      if (!profileIdentity || typeof profileIdentity !== 'object' || Array.isArray(profileIdentity)) {
        throw new Error('Game profile identity is required for battle subscriptions')
      }
    }
    message.profileIdentity = profileIdentity
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
      protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
      authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
      timestamp: Date.now(),
    }
    return {
      type: 'subscribe',
      roomId: roomId,
      playerId: playerId,
      protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
      authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
      profileIdentity: profileIdentity,
      publicKey: publicKey,
      payload: payload,
      signature: await window.RvBIdentity.sign(payload),
    }
  }

  function _doConnect(roomId) {
    if (_ws && (_ws.readyState === 0 || _ws.readyState === 1)) return
    var url = buildWsUrl()
    if (!url) return

    var socket
    try {
      socket = new WebSocket(url)
      _ws = socket
      _subscribed = false
    } catch (e) {
      _scheduleReconnect(roomId)
      return
    }

    socket.onopen = async function () {
      if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null }
      try {
        var subscribeMessage = await buildSubscribeMessage()
        if (_ws !== socket || socket.readyState !== 1) return
        socket.send(JSON.stringify(subscribeMessage))
      } catch (e) {
        console.error('[WS] subscribe failed', e)
        _emit('error', e)
        _shouldReconnect = false
        if (_ws === socket) socket.close()
      }
    }

    socket.onmessage = function (e) {
      if (_ws !== socket) return
      try {
        var msg = JSON.parse(e.data)
        if (msg && msg.type === 'battleProtocolUnsupported') {
          _shouldReconnect = false
          var protocolError = new Error('客户端与服务端对局协议不兼容，请双方更新到同一验收版本')
          protocolError.code = msg.code || 'BATTLE_PROTOCOL_UNSUPPORTED'
          protocolError.context = msg
          _emit('error', protocolError)
          socket.close()
          return
        }
        if (msg && msg.type === 'subscribed' && !_subscribed) {
          _subscribed = true
          _emit('connect')
        }
        if (msg && msg.type === 'rpcResult' && msg.requestId && _pending[msg.requestId]) {
          var pending = _pending[msg.requestId]
          delete _pending[msg.requestId]
          clearTimeout(pending.timer)
          if (msg.ok) pending.resolve(msg.data)
          else pending.reject(makeRpcError(msg))
          return
        }
        if (msg && msg.type === 'actionError' && msg.code === 'ROOM_VERSION_CONFLICT') {
          requestAuthoritySync('room-version-conflict')
        }
        var completesAuthoritySync = _authoritySyncing
          && msg
          && (msg.type === 'stateUpdate' || msg.type === 'battleSnapshot')
          && msg.requestId === _authoritySyncRequestId
        if (completesAuthoritySync) _releaseAuthoritySync()
        _emit('message', msg)
        if (completesAuthoritySync) _emit('authoritySyncComplete', msg)
      } catch {}
    }

    socket.onclose = function () {
      if (_ws !== socket) return
      _ws = null
      _subscribed = false
      _releaseAuthoritySync()
      _emit('disconnect')
      if (_shouldReconnect) _scheduleReconnect(_roomId)
    }

    socket.onerror = function () {}
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

  function _releaseAuthoritySync() {
    if (!_authoritySyncing) return false
    _authoritySyncing = false
    if (_authoritySyncTimer) clearTimeout(_authoritySyncTimer)
    _authoritySyncTimer = null
    _authoritySyncRequestId = null
    return true
  }

  function requestAuthoritySync(reason) {
    if (_authoritySyncing) return false
    if (!_subscribed || !_ws || _ws.readyState !== 1) return false
    _authoritySyncing = true
    _authoritySyncRequestId = 'authority-sync-' + (_reqSeq++) + '-' + Date.now()
    try {
      _ws.send(JSON.stringify({
        type: 'requestBattleSnapshot',
        requestId: _authoritySyncRequestId,
      }))
    } catch (error) {
      _releaseAuthoritySync()
      return false
    }
    _authoritySyncTimer = setTimeout(function () {
      if (!_releaseAuthoritySync()) return
      _emit('authoritySyncTimeout', { reason: reason || 'unknown' })
    }, AUTHORITY_SYNC_TIMEOUT_MS)
    _emit('authoritySyncStart', { reason: reason || 'unknown' })
    return true
  }

  function makeRpcError(message) {
    var error = new Error(message && message.error ? message.error : 'WebSocket RPC failed')
    if (message && message.code) error.code = message.code
    if (message && message.context) error.context = message.context
    if (message && message.status) error.status = message.status
    return error
  }

  // Relay subscriptions require signed identity. A local/private URL entered
  // through the remote connector is still a LAN authority unless relay=1 was
  // explicitly requested for local Relay development.
  function resolveTransportMode(mode) {
    if (mode !== 'relay') return 'lan'
    try {
      var params = new URLSearchParams(window.location.search || '')
      if (params.get('relay') === '1') return 'relay'
    } catch {}
    var base = getServerUrl()
    var withoutScheme = String(base || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
    var isLocalOrLan = /^(localhost|127\.0\.0\.1)(:\d+)?\b/.test(withoutScheme) ||
      /^(10\.|26\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(withoutScheme)
    return isLocalOrLan ? 'lan' : 'relay'
  }

  function connect(roomId, playerId, mode) {
    _roomId = roomId
    _playerId = playerId || null
    _mode = resolveTransportMode(mode || 'lan')
    _shouldReconnect = true
    _doConnect(roomId)
  }

  function disconnect() {
    _shouldReconnect = false
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null }
    var socket = _ws
    _ws = null
    _subscribed = false
    _releaseAuthoritySync()
    if (socket) { try { socket.close() } catch {} }
  }

  function send(msg) {
    if (_authoritySyncing && msg && (msg.type === 'action' || msg.type === 'gameOver')) {
      _emit('authoritySyncBlocked', msg)
      return false
    }
    if (_subscribed && _ws && _ws.readyState === 1) {
      try {
        _ws.send(JSON.stringify(msg))
        return true
      } catch {}
    }
    return false
  }

  function request(method, data, timeoutMs) {
    timeoutMs = timeoutMs || 5000
    return new Promise(function (resolve, reject) {
      if (!_subscribed || !_ws || _ws.readyState !== 1) {
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

  function requestAt(baseUrl, method, data, timeoutMs) {
    timeoutMs = timeoutMs || 5000
    return new Promise(function (resolve, reject) {
      var base = String(baseUrl || '').trim().replace(/\/+$/, '')
      if (base && !/^[a-z]+:\/\//i.test(base)) base = 'http://' + base
      var url = base.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:') + '/ws/rooms/__lobby'
      var requestId = 'probe-' + (_reqSeq++) + '-' + Date.now()
      var socket = null
      var settled = false
      var timer = setTimeout(function () {
        finish(new Error('WebSocket request timeout: ' + method))
      }, timeoutMs)

      function finish(error, value) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (socket) {
          try { socket.close() } catch {}
        }
        if (error) reject(error)
        else resolve(value)
      }

      if (!base) {
        finish(new Error('Server URL is required'))
        return
      }
      try {
        socket = new WebSocket(url)
      } catch (error) {
        finish(error)
        return
      }
      socket.onopen = function () {
        try {
          socket.send(JSON.stringify({ type: 'rpc', requestId: requestId, method: method, data: data || {} }))
        } catch (error) {
          finish(error)
        }
      }
      socket.onmessage = function (event) {
        try {
          var message = JSON.parse(event.data)
          if (!message || message.type !== 'rpcResult' || message.requestId !== requestId) return
          if (message.ok) finish(null, message.data)
          else finish(makeRpcError(message))
        } catch (error) {
          finish(error)
        }
      }
      socket.onerror = function () { finish(new Error('WebSocket connection failed')) }
      socket.onclose = function () {
        if (!settled) finish(new Error('WebSocket closed before response'))
      }
    })
  }

  function catalogIdentityErrorMessage(error) {
    return error && error.message ? String(error.message) : String(error || 'Unknown error')
  }

  function isTransientCatalogIdentityError(error) {
    var message = catalogIdentityErrorMessage(error)
    return message === 'WebSocket request timeout: catalog.identity' ||
      message === 'WebSocket connection failed' ||
      message === 'WebSocket closed before response'
  }

  function serverOriginForDiagnostics(baseUrl) {
    try {
      var normalized = String(baseUrl || '').trim()
      if (normalized && !/^[a-z]+:\/\//i.test(normalized)) normalized = 'http://' + normalized
      return new URL(normalized).origin
    } catch {
      return '[invalid server URL]'
    }
  }

  async function requestCatalogIdentityAt(baseUrl, scope) {
    var maxAttempts = 2
    var timeoutMs = 5000
    var retryDelayMs = 250
    var label = String(scope || 'server')
    var origin = serverOriginForDiagnostics(baseUrl)

    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await requestAt(baseUrl, 'catalog.identity', {}, timeoutMs)
      } catch (error) {
        var transient = isTransientCatalogIdentityError(error)
        var reason = catalogIdentityErrorMessage(error)
        if (transient && attempt < maxAttempts) {
          console.warn('[profile] retrying catalog.identity', {
            scope: label,
            origin: origin,
            attempt: attempt,
            maxAttempts: maxAttempts,
            reason: reason,
          })
          await new Promise(function (resolve) { setTimeout(resolve, retryDelayMs) })
          continue
        }

        var wrapped = new Error(
          'Profile Identity request failed [' + label + '] ' + origin +
          ' (attempt ' + attempt + '/' + maxAttempts + '): ' + reason,
        )
        wrapped.code = error && error.code
          ? error.code
          : (transient ? 'PROFILE_IDENTITY_TRANSPORT_FAILED' : 'PROFILE_IDENTITY_REQUEST_FAILED')
        wrapped.context = {
          scope: label,
          origin: origin,
          attempt: attempt,
          maxAttempts: maxAttempts,
          reason: reason,
        }
        throw wrapped
      }
    }
    throw new Error('Profile Identity request failed without an attempt')
  }

  // Event handlers are registered once per page.

  function on(event, handler) {
    _handlers[event] = handler
  }

  function isConnected() {
    return _subscribed && _ws !== null && _ws.readyState === 1
  }

  function isAuthoritySyncing() {
    return _authoritySyncing
  }

  window.RvBWs = {
    connect: connect,
    disconnect: disconnect,
    send: send,
    request: request,
    requestAt: requestAt,
    requestAuthoritySync: requestAuthoritySync,
    requestCatalogIdentityAt: requestCatalogIdentityAt,
    on: on,
    isConnected: isConnected,
    isAuthoritySyncing: isAuthoritySyncing,
  }
})()
