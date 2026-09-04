;(function () {
  'use strict'

  var _client = null
  var _room = null
  var _roomId = null
  var _playerId = null
  var _handlers = {}
  var _createInFlight = {}
  var _reqSeq = 1
  var _generation = 0
  var _lobbyPollTimer = null
  var _shouldReconnect = false
  var _subscribed = false
  var _authoritySyncing = false
  var _authoritySyncTimer = null
  var _authoritySyncRequestId = null
  var _connectPromise = null
  var _lastConnectionError = null
  var AUTHORITY_SYNC_TIMEOUT_MS = 3000
  var RECONNECT_TOKEN_PREFIX = 'rvb_colyseus_reconnect:'

  function getServerUrl() {
    if (window.RvBUtils && window.RvBUtils.getConnectionConfig) {
      var cfg = window.RvBUtils.getConnectionConfig()
      if (cfg && cfg.url) return cfg.url
    }
    return (window.RvBUtils && window.RvBUtils.getServerUrl)
      ? window.RvBUtils.getServerUrl()
      : (localStorage.getItem('rvb_server_url') || '')
  }

  function normalizedBaseUrl(value) {
    var base = String(value || '').trim().replace(/\/+$/, '')
    if (base && !/^[a-z]+:\/\//i.test(base)) base = 'http://' + base
    return base
  }

  function requireSdk() {
    if (!window.Colyseus || typeof window.Colyseus.Client !== 'function') {
      throw new Error('Colyseus SDK 未加载，请重新安装或更新客户端')
    }
    return window.Colyseus
  }

  function createClient(baseUrl) {
    var Colyseus = requireSdk()
    var base = normalizedBaseUrl(baseUrl || getServerUrl())
    if (!base) throw new Error('Server URL is required')
    return new Colyseus.Client(base)
  }

  function reconnectTokenKey() {
    return RECONNECT_TOKEN_PREFIX + normalizedBaseUrl(getServerUrl()) + ':' + _roomId + ':' + _playerId
  }

  function readReconnectToken() {
    try { return window.sessionStorage.getItem(reconnectTokenKey()) || '' } catch { return '' }
  }

  function rememberReconnectToken(room) {
    try {
      if (room && room.reconnectionToken) window.sessionStorage.setItem(reconnectTokenKey(), room.reconnectionToken)
    } catch {}
  }

  function clearReconnectToken() {
    try { window.sessionStorage.removeItem(reconnectTokenKey()) } catch {}
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms) })
  }

  async function reconnectStoredRoom(client, token, generation) {
    var delays = [0, 80, 200, 400, 800]
    var lastError
    for (var attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) await delay(delays[attempt])
      if (generation !== _generation || !_shouldReconnect) return null
      try {
        return await client.reconnect(token)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError || new Error('Colyseus reconnect failed')
  }

  function storedProfileIdentity() {
    try {
      var raw = localStorage.getItem('rvb_game_profile_identity')
      var value = raw ? JSON.parse(raw) : null
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null
    } catch {
      return null
    }
  }

  function pageParams() {
    try { return new URLSearchParams(window.location.search || '') } catch { return new URLSearchParams() }
  }

  function currentIdentity() {
    try {
      return window.RvBIdentity && typeof window.RvBIdentity.getIdentity === 'function'
        ? (window.RvBIdentity.getIdentity() || {})
        : {}
    } catch {
      return {}
    }
  }

  function joinOptions(playerId) {
    var params = pageParams()
    var identity = currentIdentity()
    var profileIdentity = storedProfileIdentity()
    if (!profileIdentity) throw new Error('Game profile identity is required for Colyseus admission')
    return {
      product: true,
      playerId: String(playerId || identity.id || '').trim().toLowerCase(),
      playerName: params.get('playerName') || identity.displayName || '',
      accountId: identity.accountId || undefined,
      alignment: params.get('alignment') || undefined,
      profileIdentity: profileIdentity,
    }
  }

  function _emit(event, data) {
    if (_handlers[event]) {
      try { _handlers[event](data) } catch (error) { console.error('[Colyseus]', event, error) }
    }
  }

  function emitRoomMessage(type, payload) {
    var message = payload && typeof payload === 'object'
      ? Object.assign({}, payload, { type: payload.type || type })
      : { type: type, data: payload }
    if (_authoritySyncing && type === 'stateUpdate') {
      message.requestId = _authoritySyncRequestId
      _releaseAuthoritySync()
      _emit('message', message)
      _emit('authoritySyncComplete', message)
      return
    }
    _emit('message', message)
  }

  function registerRoomHandlers(room, generation) {
    room.onMessage('roomUpdate', function (message) {
      if (generation === _generation) emitRoomMessage('roomUpdate', message)
    })
    room.onMessage('battleSnapshot', function (message) {
      if (generation === _generation) emitRoomMessage('stateUpdate', message)
    })
    room.onMessage('battleTransition', function (message) {
      if (generation === _generation) emitRoomMessage('battleTransition', message)
    })
    room.onMessage('battleReceipt', function (message) {
      if (generation === _generation) {
        emitRoomMessage(message && message.kind === 'rejected' ? 'actionError' : 'battleReceipt', message)
      }
    })
    room.onMessage('battleDurable', function (message) {
      if (generation === _generation) emitRoomMessage('battleDurable', message)
    })
    room.onError(function (code, message) {
      if (generation !== _generation) return
      var error = new Error(message || 'Colyseus room error')
      error.code = code
      _emit('error', error)
    })
    room.onDrop(function () {
      if (generation !== _generation) return
      _subscribed = false
      _releaseAuthoritySync()
      _emit('disconnect', { reconnecting: true })
    })
    room.onReconnect(function () {
      if (generation !== _generation || !_shouldReconnect || room !== _room) return
      _subscribed = true
      rememberReconnectToken(room)
      _emit('connect', { reconnected: true })
      void resyncConnectedRoom(room, generation)
    })
    room.onLeave(function () {
      if (generation !== _generation) return
      _room = null
      _subscribed = false
      clearReconnectToken()
      _releaseAuthoritySync()
      _emit('disconnect', { terminal: true })
    })
  }

  function configureNativeReconnection(room) {
    room.reconnection.enabled = true
    room.reconnection.minUptime = 0
    room.reconnection.minDelay = 100
    room.reconnection.maxDelay = 2000
    room.reconnection.maxRetries = 20
    // Gameplay clicks are rejected while dropped; never replay newly queued input.
    room.reconnection.maxEnqueuedMessages = 0
  }

  async function resyncConnectedRoom(room, generation) {
    try {
      var snapshot = await request('rooms.get', { roomId: _roomId }, 5000)
      if (generation !== _generation || room !== _room || !_subscribed) return
      var role = snapshot && snapshot.hostId && String(snapshot.hostId).toLowerCase() === _playerId ? 'host' : 'guest'
      emitRoomMessage('subscribed', { role: role })
      room.send('battleResync', {})
    } catch (error) {
      if (generation === _generation && room === _room) _emit('error', error)
    }
  }

  async function connectRoom(generation) {
    try {
      _client = createClient()
      var token = readReconnectToken()
      var room
      if (token && typeof _client.reconnect === 'function') {
        try {
          room = await reconnectStoredRoom(_client, token, generation)
        } catch {
          clearReconnectToken()
          if (generation !== _generation || !_shouldReconnect) return false
          room = await _client.joinById(_roomId, joinOptions(_playerId))
        }
      } else {
        room = await _client.joinById(_roomId, joinOptions(_playerId))
      }
      if (!room) return false
      if (generation !== _generation || !_shouldReconnect) {
        try { await room.leave() } catch {}
        return false
      }
      _room = room
      _lastConnectionError = null
      rememberReconnectToken(room)
      configureNativeReconnection(room)
      registerRoomHandlers(room, generation)
      _subscribed = true
      _emit('connect')
      await resyncConnectedRoom(room, generation)
      return true
    } catch (error) {
      if (generation !== _generation) return
      _subscribed = false
      _lastConnectionError = error instanceof Error ? error : new Error(String(error))
      _emit('error', error)
      return false
    }
  }

  function connectLobby(generation) {
    _client = createClient()
    _subscribed = true
    setTimeout(function () {
      if (generation !== _generation || !_subscribed) return
      _emit('connect')
      pollLobby(generation)
    }, 0)
  }

  function pollLobby(generation) {
    if (generation !== _generation || !_subscribed || _roomId !== '__lobby') return
    requestAt(getServerUrl(), 'rooms.list', {}, 5000).then(function (data) {
      if (generation === _generation) emitRoomMessage('lobbyUpdate', data)
    }).catch(function () {})
    _lobbyPollTimer = setTimeout(function () { pollLobby(generation) }, 2000)
  }

  function connect(roomId, playerId) {
    disconnect()
    _roomId = String(roomId || '').trim()
    _playerId = String(playerId || '').trim().toLowerCase() || null
    _lastConnectionError = null
    _shouldReconnect = true
    var generation = ++_generation
    if (_roomId === '__lobby') connectLobby(generation)
    else {
      var pending = connectRoom(generation)
      _connectPromise = pending
      pending.finally(function () {
        if (_connectPromise === pending) _connectPromise = null
      })
    }
  }

  function disconnect() {
    _shouldReconnect = false
    _generation += 1
    if (_lobbyPollTimer) { clearTimeout(_lobbyPollTimer); _lobbyPollTimer = null }
    var room = _room
    _room = null
    _client = null
    _subscribed = false
    _connectPromise = null
    _releaseAuthoritySync()
    if (room) {
      clearReconnectToken()
      try { void room.leave() } catch {}
    }
  }

  async function waitForConnection(timeoutMs) {
    if (_subscribed && _room) return
    var pending = _connectPromise
    if (pending) await withTimeout(pending, timeoutMs || 5000, 'room connect')
    if (_subscribed && _room) return
    if (_lastConnectionError) throw _lastConnectionError
    throw new Error('Colyseus room not connected')
  }

  function send(message) {
    if (_authoritySyncing && message && message.type === 'action') {
      _emit('authoritySyncBlocked', message)
      return false
    }
    if (!_subscribed || !_room) return false
    try {
      if (message && message.type === 'action') {
        _room.send('battleCommand', message)
      } else if (message && message.type === 'requestBattleSnapshot') {
        _room.send('battleResync', {})
      } else if (message && message.type === 'roomState') {
        request('rooms.get', { roomId: _roomId }, 5000).catch(function () {})
      } else if (message && message.type === 'roomAction') {
        request('rooms.action', Object.assign({}, message, {
          roomId: _roomId,
          playerId: message.playerId || _playerId,
          profileIdentity: message.profileIdentity || storedProfileIdentity(),
        }), 5000).then(function (data) {
          emitRoomMessage('roomActionResult', Object.assign({ success: true }, data || {}))
        }).catch(function (error) {
          emitRoomMessage('roomActionResult', { success: false, error: error.message, code: error.code })
        })
      } else {
        return false
      }
      return true
    } catch {
      return false
    }
  }

  function request(method, data, timeoutMs) {
    if (_roomId === '__lobby') return requestAt(getServerUrl(), method, data, timeoutMs)
    timeoutMs = timeoutMs || 5000
    if (!_subscribed || !_room) return Promise.reject(new Error('Colyseus room not connected'))
    var payload = Object.assign({}, data || {})
    if (method === 'rooms.action') {
      payload.playerId = payload.playerId || _playerId
      payload.profileIdentity = payload.profileIdentity || storedProfileIdentity()
    }
    return _room.request('roomRpc', { method: method, data: payload }, { timeout: timeoutMs })
  }

  async function requestAt(baseUrl, method, data, timeoutMs) {
    var base = normalizedBaseUrl(baseUrl)
    var payload = data || {}
    timeoutMs = timeoutMs || 5000
    if (!base) throw new Error('Server URL is required')
    if (method === 'system.health') return fetchJson(base + '/healthz', timeoutMs)
    if (method === 'catalog.identity') return fetchJson(base + '/catalog/identity', timeoutMs)
    if (method === 'catalog.maps') return fetchJson(base + '/catalog/maps', timeoutMs)
    if (method === 'catalog.pieces') return fetchJson(base + '/catalog/pieces', timeoutMs)
    if (method === 'catalog.skills') return fetchJson(base + '/catalog/skills', timeoutMs)
    if (method === 'catalog.card') return fetchJson(base + '/catalog/cards/' + encodeURIComponent(String(payload.cardId || '')), timeoutMs)
    if (method === 'battleReports.get') {
      var reportPayload = await fetchJson(base + '/battle-reports/' + encodeURIComponent(String(payload.battleId || payload.roomId || '')), timeoutMs)
      return reportPayload && reportPayload.report ? reportPayload.report : reportPayload
    }
    if (method === 'battleReports.list') {
      return fetchJson(base + '/battle-reports?playerId=' + encodeURIComponent(String(payload.playerId || '')), timeoutMs)
    }

    var client = createClient(base)
    if (method === 'rooms.list') {
      return fetchJson(base + '/rooms', timeoutMs)
    }
    if (method === 'rooms.get') {
      var detail = await fetchJson(base + '/rooms/' + encodeURIComponent(String(payload.roomId || '')), timeoutMs)
      return detail && detail.room ? detail.room : detail
    }
    if (method === 'rooms.create') {
      var hostId = String(payload.hostId || payload.playerId || '').trim().toLowerCase()
      if (!hostId) throw makeRpcError({ code: 'PLAYER_ID_REQUIRED', error: 'Player ID is required to create a room' })
      var createFlightKey = base + '|' + hostId
      if (_createInFlight[createFlightKey]) return _createInFlight[createFlightKey]
      var creationKey = hostId + ':' + Date.now() + '-' + (_reqSeq++)
      _createInFlight[createFlightKey] = (async function () {
        var room = await withTimeout(client.create('battle', {
          product: true,
          creationKey: creationKey,
          name: payload.name,
          mapId: payload.mapId,
          visibility: payload.visibility,
          mode: payload.mode,
          playerId: hostId,
          playerName: payload.hostName || payload.playerName,
          profileIdentity: payload.profileIdentity || storedProfileIdentity(),
        }), timeoutMs, method)
        try {
          return await roomRpc(room, 'rooms.get', { roomId: room.roomId }, timeoutMs)
        } finally {
          try { await room.leave() } catch {}
        }
      })()
      try {
        return await _createInFlight[createFlightKey]
      } finally {
        delete _createInFlight[createFlightKey]
      }
    }
    if (method === 'rooms.action' && (payload.action === 'join' || payload.action === 'rejoin')) {
      var admission = joinOptions(payload.playerId)
      admission.playerName = payload.playerName || admission.playerName
      admission.alignment = payload.alignment || admission.alignment
      admission.profileIdentity = payload.profileIdentity || admission.profileIdentity
      var joinedRoom = await withTimeout(client.joinById(payload.roomId, admission), timeoutMs, method)
      try {
        var joinedSnapshot = await roomRpc(joinedRoom, 'rooms.get', { roomId: payload.roomId }, timeoutMs)
        return { success: true, room: joinedSnapshot }
      } finally {
        try { await joinedRoom.leave() } catch {}
      }
    }
    if (method === 'rooms.delete') {
      var deleteRoom = await withTimeout(client.joinById(payload.roomId, {
        product: true,
        playerId: payload.playerId,
        playerName: currentIdentity().displayName,
        profileIdentity: payload.profileIdentity || storedProfileIdentity(),
      }), timeoutMs, method)
      try {
        return await roomRpc(deleteRoom, 'rooms.delete', payload, timeoutMs)
      } finally {
        try { await deleteRoom.leave() } catch {}
      }
    }
    throw makeRpcError({ code: 'ROOM_RPC_UNSUPPORTED', error: 'Unsupported Colyseus request: ' + method })
  }

  function roomRpc(room, method, data, timeoutMs) {
    return room.request('roomRpc', { method: method, data: data || {} }, { timeout: timeoutMs || 5000 })
  }

  async function fetchJson(url, timeoutMs) {
    var controller = new AbortController()
    var timer = setTimeout(function () { controller.abort() }, timeoutMs || 5000)
    var diagnosticUrl = requestUrlForDiagnostics(url)
    try {
      var response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
      var body = await response.json().catch(function () { return {} })
      if (!response.ok) throw makeRpcError(body)
      return body
    } catch (error) {
      if (controller.signal.aborted) {
        throw makeRpcError({
          code: 'COLYSEUS_HTTP_TIMEOUT',
          error: 'Colyseus HTTP request timed out: ' + diagnosticUrl,
          context: { url: diagnosticUrl, timeoutMs: timeoutMs || 5000 },
        })
      }
      if (error && error.code) throw error
      throw makeRpcError({
        code: 'COLYSEUS_HTTP_UNAVAILABLE',
        error: 'Unable to reach Colyseus HTTP endpoint: ' + diagnosticUrl,
        context: { url: diagnosticUrl, cause: error && error.message ? error.message : String(error) },
      })
    } finally {
      clearTimeout(timer)
    }
  }

  function requestUrlForDiagnostics(value) {
    try {
      var parsed = new URL(value)
      parsed.username = ''
      parsed.password = ''
      parsed.search = ''
      parsed.hash = ''
      return parsed.toString().replace(/\/$/, '')
    } catch {
      return '[invalid request URL]'
    }
  }

  function withTimeout(promise, timeoutMs, label) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('Colyseus request timeout: ' + label)) }, timeoutMs || 5000)
      Promise.resolve(promise).then(function (value) {
        clearTimeout(timer)
        resolve(value)
      }, function (error) {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  function requestAuthoritySync(reason, clientActionId) {
    if (_authoritySyncing || !_subscribed || !_room) return false
    _authoritySyncing = true
    _authoritySyncRequestId = 'authority-sync-' + (_reqSeq++) + '-' + Date.now()
    _room.send('battleResync', {})
    _authoritySyncTimer = setTimeout(function () {
      if (!_releaseAuthoritySync()) return
      _emit('authoritySyncTimeout', { reason: reason || 'unknown' })
    }, AUTHORITY_SYNC_TIMEOUT_MS)
    _emit('authoritySyncStart', Object.assign(
      { reason: reason || 'unknown' },
      clientActionId ? { clientActionId: String(clientActionId) } : {}
    ))
    return true
  }

  function requestAuthorityReceiptSync(reason, clientActionId) {
    if (!clientActionId) return requestAuthoritySync(reason)
    if (_authoritySyncing || !_subscribed || !_room) return false
    _authoritySyncing = true
    _authoritySyncRequestId = 'authority-receipt-' + (_reqSeq++) + '-' + Date.now()
    _emit('authoritySyncStart', { reason: reason || 'unknown', clientActionId: String(clientActionId) })
    var room = _room
    _authoritySyncTimer = setTimeout(function () {
      if (!_releaseAuthoritySync()) return
      _emit('authoritySyncTimeout', { reason: reason || 'unknown', clientActionId: String(clientActionId) })
    }, AUTHORITY_SYNC_TIMEOUT_MS)
    room.request('battleReceiptRequest', { clientActionId: String(clientActionId) }, { timeout: AUTHORITY_SYNC_TIMEOUT_MS - 250 })
      .then(function (result) {
        if (room !== _room || !_releaseAuthoritySync()) return
        if (result && result.receipt) {
          emitRoomMessage('battleReceipt', { kind: 'lookup', receipt: result.receipt })
        } else {
          emitRoomMessage('actionError', {
            code: 'BATTLE_RECEIPT_UNKNOWN',
            error: '服务端未找到该指令，已明确取消本地等待；请根据最新状态重新操作',
            receipt: {
              clientActionId: String(clientActionId),
              status: 'rejected',
              code: 'BATTLE_RECEIPT_UNKNOWN',
              message: '服务端未找到该指令',
            },
          })
        }
        if (result && result.snapshot) emitRoomMessage('stateUpdate', result.snapshot)
        _emit('authoritySyncComplete', result)
      })
      .catch(function () {
        if (!_releaseAuthoritySync()) return
        _emit('authoritySyncTimeout', { reason: reason || 'unknown', clientActionId: String(clientActionId) })
      })
    return true
  }

  function _releaseAuthoritySync() {
    if (!_authoritySyncing) return false
    _authoritySyncing = false
    if (_authoritySyncTimer) clearTimeout(_authoritySyncTimer)
    _authoritySyncTimer = null
    _authoritySyncRequestId = null
    return true
  }

  function makeRpcError(message) {
    var error = new Error(message && (message.error || message.message) ? (message.error || message.message) : 'Colyseus request failed')
    if (message && message.code) error.code = message.code
    if (message && message.context) error.context = message.context
    if (message && message.status) error.status = message.status
    return error
  }

  function catalogIdentityErrorMessage(error) {
    return error && error.message ? String(error.message) : String(error || 'Unknown error')
  }

  function isTransientCatalogIdentityError(error) {
    var code = error && error.code ? String(error.code) : ''
    return code === 'COLYSEUS_HTTP_TIMEOUT'
      || code === 'COLYSEUS_HTTP_UNAVAILABLE'
      || /(?:timeout|network|fetch|connect|closed|unavailable|unable to reach)/i.test(catalogIdentityErrorMessage(error))
  }

  function serverOriginForDiagnostics(baseUrl) {
    try { return new URL(normalizedBaseUrl(baseUrl)).origin } catch { return '[invalid server URL]' }
  }

  async function requestCatalogIdentityAt(baseUrl, scope) {
    var maxAttempts = 2
    var label = String(scope || 'server')
    var origin = serverOriginForDiagnostics(baseUrl)
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await requestAt(baseUrl, 'catalog.identity', {}, 5000)
      } catch (error) {
        var transient = isTransientCatalogIdentityError(error)
        if (transient && attempt < maxAttempts) {
          await new Promise(function (resolve) { setTimeout(resolve, 250) })
          continue
        }
        var wrapped = new Error('Profile Identity request failed [' + label + '] ' + origin + ' (attempt ' + attempt + '/' + maxAttempts + '): ' + catalogIdentityErrorMessage(error))
        wrapped.code = transient
          ? 'PROFILE_IDENTITY_TRANSPORT_FAILED'
          : (error && error.code ? error.code : 'PROFILE_IDENTITY_REQUEST_FAILED')
        wrapped.context = { scope: label, origin: origin, attempt: attempt, maxAttempts: maxAttempts, reason: catalogIdentityErrorMessage(error) }
        throw wrapped
      }
    }
  }

  function on(event, handler) { _handlers[event] = handler }
  function isConnected() { return _subscribed }
  function isAuthoritySyncing() { return _authoritySyncing }

  window.RvBColyseus = {
    connect: connect,
    disconnect: disconnect,
    send: send,
    request: request,
    requestAt: requestAt,
    requestAuthoritySync: requestAuthoritySync,
    requestAuthorityReceiptSync: requestAuthorityReceiptSync,
    requestCatalogIdentityAt: requestCatalogIdentityAt,
    on: on,
    isConnected: isConnected,
    waitForConnection: waitForConnection,
    isAuthoritySyncing: isAuthoritySyncing,
  }
})()
