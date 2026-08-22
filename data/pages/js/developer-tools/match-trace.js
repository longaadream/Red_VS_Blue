(function (global) {
  'use strict'

  var TRACE_FORMAT = 'rvb-match-trace/v2'
  var LEGACY_TRACE_FORMAT = 'rvb-match-trace/v1'
  var REPLAY_FORMAT = 'rvb-battle-replay/v2'
  var TRACE_STORAGE_KEY = 'rvb_last_completed_trace_v2'
  var LEGACY_TRACE_STORAGE_KEY = 'rvb_last_completed_trace'
  var TRACE_DB_NAME = 'rvb-developer-tools'
  var TRACE_DB_STORE = 'match-traces'
  var TRACE_DB_KEY = 'latest-v2'
  var MAX_TRACE_BYTES = 32 * 1024 * 1024
  var MAX_TRACE_DEPTH = 48
  var MAX_TRACE_NODES = 750000
  var MAX_ARRAY_ENTRIES = 100000
  var MAX_STRING_LENGTH = 2 * 1024 * 1024

  var SHA256_INITIAL_STATE = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]
  var SHA256_ROUND_CONSTANTS = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]

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
      || normalized.indexOf('databaseurl') !== -1
      || normalized.indexOf('environment') !== -1
      || normalized.indexOf('localpath') !== -1
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
    var replay = sanitize(metadata && metadata.replay)
    if (!replay || replay.format !== REPLAY_FORMAT || !replay.initialState || !Array.isArray(replay.frames)) {
      throw new Error('This completed match does not contain Trace v2 replay checkpoints')
    }

    var actionTrace = sanitize(metadata && Array.isArray(metadata.actionLog) ? metadata.actionLog : [])
    var lastTrace = actionTrace.length ? actionTrace[actionTrace.length - 1] : null
    var terminal = sanitize(state.terminalResult)
    var frames = replay.frames
    var finalFrame = frames.length ? frames[frames.length - 1] : null
    var seed = Number.isInteger(input.seed) ? (input.seed >>> 0) : inferSeed(actionTrace)
    var players = (Array.isArray(state.players) ? state.players : []).map(function (player) {
      return {
        playerId: stringOrNull(player && player.playerId),
        faction: stringOrNull(player && player.faction),
      }
    })
    var finalStateHash = stringOrNull(input.stateHash)
      || stringOrNull(finalFrame && finalFrame.postStateHash)
      || stringOrNull(lastTrace && lastTrace.postStateHash)
      || stringOrNull(replay.initialStateHash)

    var record = sanitize({
      format: TRACE_FORMAT,
      schemaVersion: 2,
      exportedAt: input.exportedAt || new Date().toISOString(),
      roomId: stringOrNull(input.roomId),
      seed: seed,
      authorityVersion: integerOrNull(input.authorityVersion),
      integrity: {
        algorithm: 'sha256-stable-json',
        checkpointHashFields: true,
      },
      content: createContentSnapshot(state, replay),
      initialStateHash: replay.initialStateHash,
      initialCheckpointHash: replay.initialCheckpointHash || hashStable(replay.initialState),
      initialState: replay.initialState,
      frames: frames,
      final: {
        stateVersion: integerOrNull(state._v),
        stateHash: finalStateHash,
        checkpointHash: finalFrame
          ? (finalFrame.postCheckpointHash || hashStable(finalFrame.postState))
          : (replay.initialCheckpointHash || hashStable(replay.initialState)),
        mapId: stringOrNull(state.map && state.map.id),
        turnNumber: integerOrNull(state.turn && state.turn.turnNumber),
        phase: stringOrNull(state.turn && state.turn.phase),
        winnerPlayerId: stringOrNull(terminal.winnerPlayerId),
        loserPlayerId: stringOrNull(terminal.loserPlayerId),
        reason: stringOrNull(terminal.reason),
        settledAt: terminal.settledAt || null,
      },
      summary: {
        commandCount: frames.length,
        eventCount: frames.reduce(function (total, frame) {
          return total + (Array.isArray(frame.events) ? frame.events.length : 0)
        }, 0),
        playerCount: players.length,
        livingPieceCount: Array.isArray(state.pieces) ? state.pieces.length : 0,
        graveyardCount: Array.isArray(state.graveyard) ? state.graveyard.length : 0,
      },
      players: players,
    })
    return assertTraceRecord(record)
  }

  function createContentSnapshot(state, replay) {
    var pieceMap = {}
    var skillMap = {}
    var states = [replay.initialState]
    replay.frames.forEach(function (frame) {
      if (frame && frame.postState) states.push(frame.postState)
    })
    states.push(state)

    states.forEach(function (snapshot) {
      ;(Array.isArray(snapshot && snapshot.pieces) ? snapshot.pieces : []).forEach(function (piece) {
        var templateId = stringOrNull(piece && piece.templateId) || stringOrNull(piece && piece.instanceId)
        if (!templateId || pieceMap[templateId]) return
        pieceMap[templateId] = {
          templateId: templateId,
          name: stringOrNull(piece.name) || templateId,
          imageId: safeAssetId(piece.image || piece.portrait || templateId),
          faction: stringOrNull(piece.faction),
          stats: sanitize(piece.stats || {
            maxHp: piece.maxHp,
            attack: piece.attack,
            defense: piece.defense,
            moveRange: piece.moveRange,
          }),
          skillIds: (Array.isArray(piece.skills) ? piece.skills : []).map(function (skill) {
            return typeof skill === 'string' ? skill : String(skill && (skill.skillId || skill.id) || '')
          }).filter(Boolean),
        }
      })
      var skills = snapshot && snapshot.skillsById
      if (skills && typeof skills === 'object') {
        Object.keys(skills).forEach(function (skillId) {
          if (skillMap[skillId]) return
          var skill = skills[skillId] || {}
          skillMap[skillId] = {
            skillId: skillId,
            name: stringOrNull(skill.name) || skillId,
            description: stringOrNull(skill.description),
            cost: sanitize(skill.cost || null),
            cooldown: integerOrNull(skill.cooldown),
          }
        })
      }
    })

    return {
      pieces: Object.keys(pieceMap).sort().map(function (key) { return pieceMap[key] }),
      skills: Object.keys(skillMap).sort().map(function (key) { return skillMap[key] }),
    }
  }

  function safeAssetId(value) {
    if (typeof value !== 'string' || !value) return null
    if (/^\s*(?:https?:|javascript:|vbscript:|data:)/i.test(value)) return null
    return value.slice(0, 512)
  }

  function assertTraceRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('Trace must be a JSON object')
    }
    if (record.format === LEGACY_TRACE_FORMAT) {
      throw new Error('Trace v1 是旧诊断格式，不包含状态检查点，无法可视化回放')
    }
    if (record.format !== TRACE_FORMAT) {
      throw new Error('Unsupported match trace version: ' + String(record.format || 'missing'))
    }

    inspectUntrustedValue(record)
    requireObject(record.initialState, 'initialState')
    requireBattleCheckpoint(record.initialState, 'initialState')
    if (!Array.isArray(record.frames)) throw new Error('Trace frames must be an array')
    if (record.frames.length > 10000) throw new Error('Trace contains too many command frames')
    requireObject(record.content, 'content')
    validateContentSnapshot(record.content)
    requireObject(record.final, 'final')

    var initialCheckpointHash = requireHash(
      record.initialCheckpointHash || record.initialStateHash,
      'initialCheckpointHash',
    )
    var actualInitialHash = hashStable(record.initialState)
    if (actualInitialHash !== initialCheckpointHash) {
      throw new Error('Initial checkpoint hash mismatch')
    }
    var previousState = record.initialState
    var previousAuthorityHash = requireHash(record.initialStateHash, 'initialStateHash')
    var previousCheckpointHash = initialCheckpointHash

    record.frames.forEach(function (frame, index) {
      requireObject(frame, 'frames[' + index + ']')
      if (frame.index !== index) throw new Error('Trace frame index is not contiguous at ' + index)
      if (!Number.isSafeInteger(frame.traceIndex) || frame.traceIndex < 0) {
        throw new Error('Trace frame traceIndex is invalid at ' + index)
      }
      requireObject(frame.action, 'frames[' + index + '].action')
      if (typeof frame.actionType !== 'string' || !frame.actionType) {
        throw new Error('Trace frame actionType is missing at ' + index)
      }
      requireObject(frame.postState, 'frames[' + index + '].postState')
      requireBattleCheckpoint(frame.postState, 'frames[' + index + '].postState')
      if (!Array.isArray(frame.events)) throw new Error('Trace frame events must be an array at ' + index)
      frame.events.forEach(function (event, eventIndex) {
        requireObject(event, 'frames[' + index + '].events[' + eventIndex + ']')
        if (typeof event.type !== 'string' || !event.type) {
          throw new Error('Trace event type is missing at frame ' + index + ', event ' + eventIndex)
        }
      })
      if (!Array.isArray(frame.randomStreams)) throw new Error('Trace frame randomStreams must be an array at ' + index)
      frame.randomStreams.forEach(function (stream, streamIndex) {
        requireObject(stream, 'frames[' + index + '].randomStreams[' + streamIndex + ']')
        if (typeof stream.name !== 'string' || !stream.name
          || !Number.isSafeInteger(stream.startCursor) || stream.startCursor < 0
          || !Number.isSafeInteger(stream.endCursor) || stream.endCursor < stream.startCursor) {
          throw new Error('Trace random stream is invalid at frame ' + index + ', stream ' + streamIndex)
        }
      })

      var preAuthorityHash = requireHash(frame.preStateHash, 'frames[' + index + '].preStateHash')
      var postAuthorityHash = requireHash(frame.postStateHash, 'frames[' + index + '].postStateHash')
      var preCheckpointHash = requireHash(
        frame.preCheckpointHash || frame.preStateHash,
        'frames[' + index + '].preCheckpointHash',
      )
      var postCheckpointHash = requireHash(
        frame.postCheckpointHash || frame.postStateHash,
        'frames[' + index + '].postCheckpointHash',
      )
      if (preAuthorityHash !== previousAuthorityHash) {
        throw new Error('Trace authority hash chain mismatch at frame ' + index)
      }
      if (preCheckpointHash !== previousCheckpointHash || hashStable(previousState) !== preCheckpointHash) {
        throw new Error('Trace checkpoint chain mismatch at frame ' + index)
      }
      if (hashStable(frame.postState) !== postCheckpointHash) {
        throw new Error('Trace post-state checkpoint hash mismatch at frame ' + index)
      }

      previousState = frame.postState
      previousAuthorityHash = postAuthorityHash
      previousCheckpointHash = postCheckpointHash
    })

    if (record.final.stateHash && record.final.stateHash !== previousAuthorityHash) {
      throw new Error('Trace final authority hash mismatch')
    }
    if (record.final.checkpointHash && record.final.checkpointHash !== previousCheckpointHash) {
      throw new Error('Trace final checkpoint hash mismatch')
    }
    return record
  }

  function validateContentSnapshot(content) {
    if (!Array.isArray(content.pieces) || !Array.isArray(content.skills)) {
      throw new Error('Trace content snapshot must contain piece and skill arrays')
    }
    if (content.pieces.length > 2048 || content.skills.length > 8192) {
      throw new Error('Trace content snapshot contains too many entries')
    }
    content.pieces.forEach(function (piece, index) {
      requireObject(piece, 'content.pieces[' + index + ']')
      if (typeof piece.templateId !== 'string' || !piece.templateId || piece.templateId.length > 256) {
        throw new Error('Trace content piece templateId is invalid at ' + index)
      }
      if (piece.imageId != null) {
        if (typeof piece.imageId !== 'string'
          || piece.imageId.length > 512
          || piece.imageId.indexOf('..') !== -1
          || !/^[a-z0-9_./-]+$/i.test(piece.imageId)) {
          throw new Error('Trace content piece imageId is unsafe at ' + index)
        }
      }
    })
    content.skills.forEach(function (skill, index) {
      requireObject(skill, 'content.skills[' + index + ']')
      if (typeof skill.skillId !== 'string' || !skill.skillId || skill.skillId.length > 256) {
        throw new Error('Trace content skillId is invalid at ' + index)
      }
    })
  }

  function requireObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(label + ' must be an object')
    }
  }

  function requireBattleCheckpoint(value, label) {
    requireObject(value.map, label + '.map')
    if (!Number.isSafeInteger(value.map.width) || !Number.isSafeInteger(value.map.height)) {
      throw new Error(label + ' has an invalid map')
    }
    if (!Array.isArray(value.map.tiles) || !Array.isArray(value.pieces) || !Array.isArray(value.players)) {
      throw new Error(label + ' is missing battle collections')
    }
    requireObject(value.turn, label + '.turn')
  }

  function requireHash(value, label) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
      throw new Error(label + ' must be a SHA-256 hash')
    }
    return value.toLowerCase()
  }

  function inspectUntrustedValue(rootValue) {
    var serialized = JSON.stringify(rootValue)
    if (utf8Length(serialized) > MAX_TRACE_BYTES) throw new Error('Trace exceeds the 32 MiB size limit')

    var nodes = 0
    var stack = [{ value: rootValue, depth: 0 }]
    while (stack.length) {
      var entry = stack.pop()
      var value = entry.value
      nodes += 1
      if (nodes > MAX_TRACE_NODES) throw new Error('Trace contains too many values')
      if (entry.depth > MAX_TRACE_DEPTH) throw new Error('Trace exceeds the maximum nesting depth')
      if (typeof value === 'string') {
        if (value.length > MAX_STRING_LENGTH) throw new Error('Trace contains an oversized string')
        if (/^\s*(?:javascript:|vbscript:|data\s*:\s*text\/html)/i.test(value)) {
          throw new Error('Trace contains a dangerous URL or executable payload')
        }
        if (/^\s*https?:\/\//i.test(value)) {
          throw new Error('Trace contains an external URL, which is not allowed')
        }
        continue
      }
      if (!value || typeof value !== 'object') continue
      if (Array.isArray(value)) {
        if (value.length > MAX_ARRAY_ENTRIES) throw new Error('Trace contains an oversized array')
        for (var arrayIndex = value.length - 1; arrayIndex >= 0; arrayIndex -= 1) {
          stack.push({ value: value[arrayIndex], depth: entry.depth + 1 })
        }
        continue
      }
      Object.keys(value).forEach(function (key) {
        var normalized = key.toLowerCase()
        if (normalized === '__proto__' || normalized === 'prototype' || normalized === 'constructor') {
          throw new Error('Trace contains a dangerous object key')
        }
        if (isSensitiveKey(key)) throw new Error('Trace contains a sensitive field: ' + key)
        stack.push({ value: value[key], depth: entry.depth + 1 })
      })
    }
  }

  function parseTraceText(text) {
    if (typeof text !== 'string') throw new Error('Trace file must contain JSON text')
    if (utf8Length(text) > MAX_TRACE_BYTES) throw new Error('Trace exceeds the 32 MiB size limit')
    var parsed
    try {
      parsed = JSON.parse(text)
    } catch (_error) {
      throw new Error('Trace JSON is damaged or invalid')
    }
    return assertTraceRecord(parsed)
  }

  function importTraceFile(file) {
    if (!file || typeof file.text !== 'function') return Promise.reject(new Error('请选择 Trace JSON 文件'))
    if (Number.isFinite(file.size) && file.size > MAX_TRACE_BYTES) {
      return Promise.reject(new Error('Trace exceeds the 32 MiB size limit'))
    }
    return file.text().then(parseTraceText).then(function (record) {
      return storeCompletedTrace(record)
    })
  }

  function storeCompletedTrace(record) {
    var checked = assertTraceRecord(record)
    if (!global.indexedDB) {
      localStorage.setItem(TRACE_STORAGE_KEY, JSON.stringify(checked))
      localStorage.removeItem(LEGACY_TRACE_STORAGE_KEY)
      return Promise.resolve(checked)
    }
    return writeIndexedTrace(checked).then(function () {
      localStorage.removeItem(LEGACY_TRACE_STORAGE_KEY)
      return checked
    })
  }

  function readStoredTrace() {
    if (!global.indexedDB) return Promise.resolve(readLocalTrace())
    return readIndexedTrace().then(function (record) {
      if (!record) return readLocalTrace()
      try {
        return assertTraceRecord(record)
      } catch (_error) {
        return null
      }
    }).catch(function () {
      return readLocalTrace()
    })
  }

  function readLocalTrace() {
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
    localStorage.removeItem(LEGACY_TRACE_STORAGE_KEY)
    if (!global.indexedDB) return Promise.resolve()
    return deleteIndexedTrace().catch(function () {})
  }

  function openTraceDatabase() {
    return new Promise(function (resolve, reject) {
      var request = global.indexedDB.open(TRACE_DB_NAME, 1)
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains(TRACE_DB_STORE)) {
          request.result.createObjectStore(TRACE_DB_STORE)
        }
      }
      request.onsuccess = function () { resolve(request.result) }
      request.onerror = function () { reject(request.error || new Error('Cannot open Trace storage')) }
    })
  }

  function runIndexedRequest(mode, operation) {
    return openTraceDatabase().then(function (database) {
      return new Promise(function (resolve, reject) {
        var settled = false
        var requestResult
        var transaction = database.transaction(TRACE_DB_STORE, mode)
        var store = transaction.objectStore(TRACE_DB_STORE)
        var request = operation(store)
        request.onsuccess = function () { requestResult = request.result }
        request.onerror = function () {
          if (settled) return
          settled = true
          database.close()
          reject(request.error || new Error('Trace storage request failed'))
        }
        transaction.oncomplete = function () {
          if (settled) return
          settled = true
          database.close()
          resolve(requestResult)
        }
        transaction.onerror = function () {
          if (settled) return
          settled = true
          database.close()
          reject(transaction.error || new Error('Trace storage transaction failed'))
        }
      })
    })
  }

  function writeIndexedTrace(record) {
    return runIndexedRequest('readwrite', function (store) { return store.put(record, TRACE_DB_KEY) })
  }

  function readIndexedTrace() {
    return runIndexedRequest('readonly', function (store) { return store.get(TRACE_DB_KEY) })
  }

  function deleteIndexedTrace() {
    return runIndexedRequest('readwrite', function (store) { return store.delete(TRACE_DB_KEY) })
  }

  function traceFileName(record) {
    var room = String(record.roomId || 'completed-match').replace(/[^a-z0-9_-]+/gi, '-')
    var timestamp = String(record.exportedAt || '').replace(/[:.]/g, '-')
    return 'rvb-trace-v2-' + room + (timestamp ? '-' + timestamp : '') + '.json'
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

  function stableJson(value) {
    return JSON.stringify(sortForStableJson(value))
  }

  function sortForStableJson(value) {
    if (Array.isArray(value)) return value.map(sortForStableJson)
    if (!value || typeof value !== 'object') return value
    var sorted = {}
    Object.keys(value).sort().forEach(function (key) {
      sorted[key] = sortForStableJson(value[key])
    })
    return sorted
  }

  function hashStable(value) {
    return sha256Hex(stableJson(value))
  }

  function sha256Hex(value) {
    var bytes = encodeUtf8(value)
    var bitLength = bytes.length * 8
    bytes.push(0x80)
    while (bytes.length % 64 !== 56) bytes.push(0)

    var highBitLength = Math.floor(bitLength / 0x100000000)
    var lowBitLength = bitLength >>> 0
    var shift
    for (shift = 24; shift >= 0; shift -= 8) bytes.push((highBitLength >>> shift) & 0xff)
    for (shift = 24; shift >= 0; shift -= 8) bytes.push((lowBitLength >>> shift) & 0xff)

    var hash = SHA256_INITIAL_STATE.slice()
    var words = new Uint32Array(64)
    for (var offset = 0; offset < bytes.length; offset += 64) {
      var index
      for (index = 0; index < 16; index += 1) {
        var byteOffset = offset + index * 4
        words[index] = (
          (bytes[byteOffset] << 24)
          | (bytes[byteOffset + 1] << 16)
          | (bytes[byteOffset + 2] << 8)
          | bytes[byteOffset + 3]
        ) >>> 0
      }
      for (index = 16; index < 64; index += 1) {
        var word15 = words[index - 15]
        var word2 = words[index - 2]
        var sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3)
        var sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10)
        words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0
      }

      var a = hash[0]
      var b = hash[1]
      var c = hash[2]
      var d = hash[3]
      var e = hash[4]
      var f = hash[5]
      var g = hash[6]
      var h = hash[7]

      for (index = 0; index < 64; index += 1) {
        var sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
        var choice = (e & f) ^ (~e & g)
        var temp1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0
        var sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
        var majority = (a & b) ^ (a & c) ^ (b & c)
        var temp2 = (sum0 + majority) >>> 0
        h = g
        g = f
        f = e
        e = (d + temp1) >>> 0
        d = c
        c = b
        b = a
        a = (temp1 + temp2) >>> 0
      }

      hash[0] = (hash[0] + a) >>> 0
      hash[1] = (hash[1] + b) >>> 0
      hash[2] = (hash[2] + c) >>> 0
      hash[3] = (hash[3] + d) >>> 0
      hash[4] = (hash[4] + e) >>> 0
      hash[5] = (hash[5] + f) >>> 0
      hash[6] = (hash[6] + g) >>> 0
      hash[7] = (hash[7] + h) >>> 0
    }
    return hash.map(function (word) { return word.toString(16).padStart(8, '0') }).join('')
  }

  function encodeUtf8(value) {
    var bytes = []
    for (var index = 0; index < value.length; index += 1) {
      var codePoint = value.charCodeAt(index)
      if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
        var low = value.charCodeAt(index + 1)
        if (low >= 0xdc00 && low <= 0xdfff) {
          codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00)
          index += 1
        } else {
          codePoint = 0xfffd
        }
      } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
        codePoint = 0xfffd
      }
      if (codePoint <= 0x7f) bytes.push(codePoint)
      else if (codePoint <= 0x7ff) bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f))
      else if (codePoint <= 0xffff) {
        bytes.push(0xe0 | (codePoint >>> 12), 0x80 | ((codePoint >>> 6) & 0x3f), 0x80 | (codePoint & 0x3f))
      } else {
        bytes.push(
          0xf0 | (codePoint >>> 18),
          0x80 | ((codePoint >>> 12) & 0x3f),
          0x80 | ((codePoint >>> 6) & 0x3f),
          0x80 | (codePoint & 0x3f),
        )
      }
    }
    return bytes
  }

  function utf8Length(value) {
    return encodeUtf8(String(value)).length
  }

  function rotateRight(value, bits) {
    return (value >>> bits) | (value << (32 - bits))
  }

  global.RvBDeveloperTools = Object.freeze({
    TRACE_FORMAT: TRACE_FORMAT,
    LEGACY_TRACE_FORMAT: LEGACY_TRACE_FORMAT,
    TRACE_STORAGE_KEY: TRACE_STORAGE_KEY,
    MAX_TRACE_BYTES: MAX_TRACE_BYTES,
    sanitize: sanitize,
    stableJson: stableJson,
    hashStable: hashStable,
    createTraceRecord: createTraceRecord,
    assertTraceRecord: assertTraceRecord,
    parseTraceText: parseTraceText,
    importTraceFile: importTraceFile,
    storeCompletedTrace: storeCompletedTrace,
    readStoredTrace: readStoredTrace,
    clearStoredTrace: clearStoredTrace,
    downloadTrace: downloadTrace,
    readActiveBattle: readActiveBattle,
  })
})(window)
