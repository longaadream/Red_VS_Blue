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

  function _doConnect(roomId) {
    if (_ws && (_ws.readyState === 0 || _ws.readyState === 1)) return
    var url = buildWsUrl()
    if (!url) return

    try {
      _ws = new WebSocket(url)
    } catch (e) {
      _scheduleReconnect(roomId)
      return
    }

    _ws.onopen = async function () {
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
          else pending.reject(makeRpcError(msg))
          return
        }
        _emit('message', msg)
      } catch {}
    }

    _ws.onclose = function () {
      _ws = null
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

  // Event handlers are registered once per page.

  function on(event, handler) {
    _handlers[event] = handler
  }

  function isConnected() {
    return _ws !== null && _ws.readyState === 1
  }

  window.RvBWs = { connect: connect, disconnect: disconnect, send: send, request: request, requestAt: requestAt, on: on, isConnected: isConnected }
})()
