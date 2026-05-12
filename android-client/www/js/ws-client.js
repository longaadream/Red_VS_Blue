;(function () {
  'use strict'

  var _ws = null
  var _roomId = null
  var _playerId = null
  var _mode = 'lan'          // 'lan' | 'relay'
  var _handlers = {}
  var _reconnectTimer = null
  var _shouldReconnect = false
  var _wsPort = 3001
  var _portFetched = false

  function getServerUrl() {
    return (window.RvBUtils && window.RvBUtils.getServerUrl)
      ? window.RvBUtils.getServerUrl()
      : (localStorage.getItem('rvb_server_url') || '')
  }

  function buildWsUrl() {
    var base = getServerUrl()
    if (!base) return null
    var scheme = base.startsWith('https://') ? 'wss://' : 'ws://'
    var withoutScheme = base.replace(/^https?:\/\//, '').replace(/\/$/, '')

    if (_mode === 'relay') {
      // Same host:port as HTTP, just different path
      return scheme + withoutScheme + '/ws/rooms/' + _roomId
    } else {
      // LAN: separate WS port
      var host = withoutScheme.replace(/:\d+$/, '').replace(/\/.*$/, '')
      return scheme + host + ':' + _wsPort
    }
  }

  function fetchPortAndConnect(roomId) {
    if (_portFetched) { _doConnect(roomId); return }
    var base = getServerUrl()
    if (!base) { _doConnect(roomId); return }
    fetch(base + '/api/ws-info')
      .then(function (r) { return r.json() })
      .then(function (d) { if (d && d.wsPort) _wsPort = d.wsPort; _portFetched = true })
      .catch(function () {})
      .finally(function () { _doConnect(roomId) })
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

    _ws.onopen = function () {
      if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null }
      _ws.send(JSON.stringify({ type: 'subscribe', roomId: _roomId, playerId: _playerId }))
      _emit('connect')
    }

    _ws.onmessage = function (e) {
      try { _emit('message', JSON.parse(e.data)) } catch {}
    }

    _ws.onclose = function () {
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
      fetchPortAndConnect(roomId)
    }
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

  function on(event, handler) {
    _handlers[event] = handler
  }

  function isConnected() {
    return _ws !== null && _ws.readyState === 1
  }

  window.RvBWs = { connect: connect, disconnect: disconnect, send: send, on: on, isConnected: isConnected }
})()
