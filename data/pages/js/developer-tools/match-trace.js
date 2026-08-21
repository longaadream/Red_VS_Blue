(function (global) {
  'use strict'

  var TRACE_FORMAT = 'rvb-match-trace/v1'
  var TRACE_STORAGE_KEY = 'rvb_last_completed_trace'

  function sanitize(value, seen) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value !== 'object') return undefined

    seen = seen || []
    if (seen.indexOf(value) !== -1) return '[Circular]'
    seen.push(value)

    if (Array.isArray(value)) {
      var sanitizedArray = value.map(function (entry) {
        var next = sanitize(entry, seen)
        return next === undefined ? null : next
      })
      seen.pop()
      return sanitizedArray
    }

    var sanitizedObject = {}
    Object.keys(value).forEach(function (key) {
      if (isSensitiveKey(key)) return
      var next = sanitize(value[key], seen)
      if (next !== undefined) sanitizedObject[key] = next
    })
    seen.pop()
    return sanitizedObject
  }

  function isSensitiveKey(key) {
    var normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '')
    return normalized === 'auth'
      || normalized.indexOf('authorization') !== -1
      || normalized.indexOf('signature') !== -1
      || normalized.indexOf('privatekey') !== -1
      || normalized.indexOf('publickey') !== -1
      || normalized.indexOf('accountid') !== -1
      || normalized.indexOf('mnemonic') !== -1
      || normalized.indexOf('password') !== -1
      || normalized.indexOf('passphrase') !== -1
      || normalized.indexOf('credential') !== -1
      || normalized.indexOf('secret') !== -1
      || normalized.indexOf('token') !== -1
      || normalized.indexOf('cookie') !== -1
      || normalized.indexOf('sessionid') !== -1
      || normalized.indexOf('recoveryphrase') !== -1
  }

  function integerOrNull(value) {
    return Number.isSafeInteger(value) ? value : null
  }

  function stringOrNull(value) {
    return typeof value === 'string' && value ? value : null
  }

  function inferSeed(trace) {
    for (var index = 0; index < trace.length; index += 1) {
      if (Number.isInteger(trace[index] && trace[index].rootSeed)) {
        return trace[index].rootSeed >>> 0
      }
    }
    return null
  }

  function createTraceRecord(input) {
    input = input || {}
    var state = input.state
    if (!state || !state.terminalResult) {
      throw new Error('A terminal battle state is required before exporting a match trace')
    }

    var metadata = state.extensions && state.extensions.debugBattle
    var trace = sanitize(metadata && Array.isArray(metadata.actionLog) ? metadata.actionLog : [])
    var lastTrace = trace.length ? trace[trace.length - 1] : null
    var terminal = sanitize(state.terminalResult)
    var seed = Number.isInteger(input.seed) ? (input.seed >>> 0) : inferSeed(trace)
    var players = (Array.isArray(state.players) ? state.players : []).map(function (player) {
      return {
        playerId: stringOrNull(player && player.playerId),
        faction: stringOrNull(player && player.faction),
      }
    })
    var finalStateHash = stringOrNull(input.stateHash)
      || stringOrNull(lastTrace && lastTrace.postStateHash)

    return sanitize({
      format: TRACE_FORMAT,
      exportedAt: input.exportedAt || new Date().toISOString(),
      roomId: stringOrNull(input.roomId),
      seed: seed,
      authorityVersion: integerOrNull(input.authorityVersion),
      final: {
        stateVersion: integerOrNull(state._v),
        stateHash: finalStateHash,
        mapId: stringOrNull(state.map && state.map.id),
        turnNumber: integerOrNull(state.turn && state.turn.turnNumber),
        phase: stringOrNull(state.turn && state.turn.phase),
        winnerPlayerId: stringOrNull(terminal.winnerPlayerId),
        loserPlayerId: stringOrNull(terminal.loserPlayerId),
        reason: stringOrNull(terminal.reason),
        settledAt: terminal.settledAt || null,
      },
      summary: {
        commandCount: trace.length,
        playerCount: players.length,
        livingPieceCount: Array.isArray(state.pieces) ? state.pieces.length : 0,
        graveyardCount: Array.isArray(state.graveyard) ? state.graveyard.length : 0,
      },
      players: players,
      trace: trace,
    })
  }

  function assertTraceRecord(record) {
    if (!record || record.format !== TRACE_FORMAT || !record.final) {
      throw new Error('Unsupported match trace record')
    }
    return record
  }

  function storeCompletedTrace(record) {
    var checked = assertTraceRecord(record)
    localStorage.setItem(TRACE_STORAGE_KEY, JSON.stringify(checked))
    return checked
  }

  function readStoredTrace() {
    var serialized = localStorage.getItem(TRACE_STORAGE_KEY)
    if (!serialized) return null
    try {
      return assertTraceRecord(JSON.parse(serialized))
    } catch (_error) {
      return null
    }
  }

  function clearStoredTrace() {
    localStorage.removeItem(TRACE_STORAGE_KEY)
  }

  function traceFileName(record) {
    var room = String(record.roomId || 'completed-match').replace(/[^a-z0-9_-]+/gi, '-')
    var timestamp = String(record.exportedAt || '').replace(/[:.]/g, '-')
    return 'rvb-trace-' + room + (timestamp ? '-' + timestamp : '') + '.json'
  }

  function downloadTrace(record) {
    var checked = assertTraceRecord(record)
    var blob = new Blob([JSON.stringify(checked, null, 2)], { type: 'application/json;charset=utf-8' })
    var url = URL.createObjectURL(blob)
    var link = document.createElement('a')
    link.href = url
    link.download = traceFileName(checked)
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(function () { URL.revokeObjectURL(url) }, 0)
    return link.download
  }

  function readActiveBattle() {
    var serialized = localStorage.getItem('rvb_active_battle')
    if (!serialized) return null
    try {
      var value = JSON.parse(serialized)
      return value && typeof value === 'object' ? sanitize(value) : null
    } catch (_error) {
      return { invalidMarker: true }
    }
  }

  global.RvBDeveloperTools = Object.freeze({
    TRACE_FORMAT: TRACE_FORMAT,
    TRACE_STORAGE_KEY: TRACE_STORAGE_KEY,
    sanitize: sanitize,
    createTraceRecord: createTraceRecord,
    storeCompletedTrace: storeCompletedTrace,
    readStoredTrace: readStoredTrace,
    clearStoredTrace: clearStoredTrace,
    downloadTrace: downloadTrace,
    readActiveBattle: readActiveBattle,
  })
})(window)
