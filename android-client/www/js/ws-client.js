/**
 * ws-client.js — WebSocket client for RED vs BLUE
 * Exposes window.RvBWs = { connect, disconnect, on, isConnected }
 *
 * Usage:
 *   RvBWs.on('message', msg => { ... })
 *   RvBWs.on('connect', () => { ... })
 *   RvBWs.on('disconnect', () => { ... })
 *   RvBWs.connect(roomId)   // subscribe to a room
 *   RvBWs.disconnect()
 */
;(function () {
  'use strict'

  var _ws = null
  var _roomId = null
  var _handlers = {}
  var _reconnectTimer = null
  var _shouldReconnect = false
  var _wsPort = 3001   // default, overridden by /api/ws-info
  var _portFetched = false

  function getServerUrl() {
    return (window.RvBUtils && window.RvBUtils.getServerUrl)
      ? window.RvBUtils.getServerUrl()
      : (localStorage.getItem('rvb_server_url') || '')
  }

  // Derive ws[s]://host:WS_PORT from the stored http(s):// URL.
  function buildWsUrl() {
    var base = getServerUrl()
    if (!base) return null
    var scheme = base.startsWith('https://') ? 'wss://' : 'ws://'
    // Strip existing scheme and port, then append WS port.
    var host = base.replace(/^https?:\/\//, '').replace(/:\d+$/, '').replace(/\/.*$/, '')
    return scheme + host + ':' + _wsPort
  }

  // Fetch WS port from server once, then (re)connect.
  function fetchPortAndConnect(roomId) {
    if (_portFetched) { _doConnect(roomId); return }
    var base = getServerUrl()
    if (!base) { _doConnect(roomId); return }
    fetch(base + '/api/ws-info')
      .then(function (r) { return r.json() })
      .then(function (d) {
        if (d && d.wsPort) _wsPort = d.wsPort
        _portFetched = true
      })
      .catch(function () {})
      .finally(function () { _doConnect(roomId) })
  }

  function _doConnect(roomId) {
    if (_ws && (_ws.readyState === 0 || _ws.readyState === 1)) return  // CONNECTING or OPEN
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
      _ws.send(JSON.stringify({ type: 'subscribe', roomId: _roomId }))
      _emit('connect')
    }

    _ws.onmessage = function (e) {
      try { _emit('message', JSON.parse(e.data)) } catch {}
    }

    _ws.onclose = function () {
      _emit('disconnect')
      _scheduleReconnect(_roomId)
    }

    _ws.onerror = function () {}  // onclose fires after onerror
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

  function connect(roomId) {
    _roomId = roomId
    _shouldReconnect = true
    fetchPortAndConnect(roomId)
  }

  function disconnect() {
    _shouldReconnect = false
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null }
    if (_ws) { try { _ws.close() } catch {} _ws = null }
  }

  function on(event, handler) {
    _handlers[event] = handler
  }

  function isConnected() {
    return _ws !== null && _ws.readyState === 1  // OPEN
  }

  window.RvBWs = { connect: connect, disconnect: disconnect, on: on, isConnected: isConnected }
})()
