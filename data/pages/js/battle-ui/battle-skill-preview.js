;(function (root) {
  'use strict'

  const MAX_CACHE_ENTRIES = 16
  const MAX_DIAGNOSTIC_ENTRIES = 64
  const RESULT_STATUSES = { ready: true, unavailable: true, 'needs-input': true }

  function clock() {
    if (root.performance && typeof root.performance.now === 'function') return root.performance.now()
    return Date.now()
  }

  function sameValue(left, right) {
    return left === right || (left !== left && right !== right)
  }

  function sameRequest(left, right) {
    return !!left && !!right
      && left.snapshot === right.snapshot
      && sameValue(left.key, right.key)
      && sameValue(left.revision, right.revision)
      && sameValue(left.viewerId, right.viewerId)
  }

  function isPromise(value) {
    return !!value && (typeof value === 'object' || typeof value === 'function')
      && typeof value.then === 'function'
  }

  function normalizedResult(value) {
    if (value && typeof value === 'object' && RESULT_STATUSES[value.status]) return value
    return { status: 'unavailable', reason: 'invalid-result', value: value }
  }

  function create(options) {
    const input = options || {}
    const compute = typeof input.compute === 'function' ? input.compute : function () {
      return { status: 'unavailable', reason: 'compute-unavailable' }
    }
    const show = typeof input.show === 'function' ? input.show : function () {}
    const restore = typeof input.restore === 'function' ? input.restore : function () {}
    const notice = typeof input.notice === 'function' ? input.notice : function () {}
    const onError = typeof input.onError === 'function' ? input.onError : function () {}

    let disposed = false
    let generation = 0
    let serial = 0
    let requestCount = 0
    let current = null
    const cache = []
    const diagnostics = []

    function findCached(request) {
      const index = cache.findIndex(function (entry) { return sameRequest(entry.request, request) })
      if (index < 0) return null
      const entry = cache[index]
      cache.splice(index, 1)
      cache.unshift(entry)
      return entry
    }

    function remember(request, result) {
      const existing = cache.findIndex(function (entry) { return sameRequest(entry.request, request) })
      if (existing >= 0) cache.splice(existing, 1)
      cache.unshift({ request: request, result: result })
      if (cache.length > MAX_CACHE_ENTRIES) cache.length = MAX_CACHE_ENTRIES
    }

    function activeRecord(record) {
      return !disposed && current === record && record.generation === generation
    }

    function updateDiagnostic(record, fields) {
      Object.assign(record.diagnostic, fields)
    }

    function restoreCurrent() {
      const record = current
      if (!record || record.restored || (!record.pending && !record.displayed)) return false
      record.restored = true
      record.displayed = false
      restore()
      return true
    }

    function settleResult(record, value) {
      const result = normalizedResult(value)
      record.pending = false
      record.result = result
      if (!disposed) remember(record.request, result)
      const durationMs = Math.max(0, clock() - record.startedAt)
      updateDiagnostic(record, {
        status: result.status,
        durationMs: durationMs,
        elapsedMs: durationMs,
      })

      if (!activeRecord(record)) {
        updateDiagnostic(record, { stale: true })
        return result
      }

      if (result.status === 'ready') {
        record.displayed = true
        updateDiagnostic(record, { displayed: true, shown: true })
        show(result, record.request)
      } else {
        record.displayed = true
        updateDiagnostic(record, { displayed: true, shown: true })
        notice(result)
      }
      return result
    }

    function settleError(record, error) {
      record.pending = false
      record.error = error
      const result = { status: 'unavailable', reason: 'compute-error', error: error }
      record.result = result
      if (!disposed) remember(record.request, result)
      const durationMs = Math.max(0, clock() - record.startedAt)
      updateDiagnostic(record, {
        status: result.status,
        durationMs: durationMs,
        elapsedMs: durationMs,
      })

      // Errors remain observable through the supplied hook.  A stale request
      // still reports its failure, but cannot alter the current preview lane.
      onError(error, record.request)
      if (activeRecord(record)) {
        record.displayed = true
        updateDiagnostic(record, { displayed: true, shown: true })
        notice(result)
      }
      else updateDiagnostic(record, { stale: true })
      return result
    }

    function request(requestInput) {
      if (disposed) return undefined
      const request = requestInput || {}

      if (current && sameRequest(current.request, request)) {
        return current.promise || current.result
      }

      if (current) restoreCurrent()
      generation += 1

      const record = {
        id: ++serial,
        request: request,
        generation: generation,
        startedAt: clock(),
        pending: true,
        displayed: false,
        restored: false,
        result: undefined,
        promise: null,
        diagnostic: {
          id: serial,
          key: request.key,
          revision: request.revision,
          viewerId: request.viewerId,
          status: 'pending',
          durationMs: 0,
          elapsedMs: 0,
          displayed: false,
          shown: false,
          stale: false,
          cached: false,
        },
      }
      requestCount += 1
      diagnostics.push(record.diagnostic)
      if (diagnostics.length > MAX_DIAGNOSTIC_ENTRIES) diagnostics.shift()
      current = record

      const cached = findCached(request)
      if (cached) {
        record.pending = false
        record.result = cached.result
        record.diagnostic.cached = true
        record.diagnostic.status = cached.result.status
        record.diagnostic.durationMs = 0
        record.diagnostic.elapsedMs = 0
        if (cached.result.status === 'ready') {
          record.displayed = true
          record.diagnostic.displayed = true
          record.diagnostic.shown = true
          show(cached.result, record.request)
        } else {
          record.displayed = true
          record.diagnostic.displayed = true
          record.diagnostic.shown = true
          notice(cached.result)
        }
        return cached.result
      }

      let computed
      try {
        computed = compute(request)
      } catch (error) {
        return settleError(record, error)
      }

      if (!isPromise(computed)) return settleResult(record, computed)

      record.promise = Promise.resolve(computed).then(function (result) {
        return settleResult(record, result)
      }, function (error) {
        return settleError(record, error)
      })
      return record.promise
    }

    function clear() {
      if (disposed) return
      restoreCurrent()
      generation += 1
      current = null
    }

    function dispose() {
      if (disposed) return
      restoreCurrent()
      disposed = true
      generation += 1
      current = null
      cache.length = 0
      diagnostics.length = 0
      requestCount = 0
    }

    function getDiagnostics() {
      return {
        disposed: disposed,
        active: current ? {
          id: current.id,
          key: current.request.key,
          revision: current.request.revision,
          pending: current.pending,
          displayed: current.displayed,
        } : null,
        cacheSize: cache.length,
        requestCount: requestCount,
        requests: diagnostics.map(function (entry) { return Object.assign({}, entry) }),
      }
    }

    return {
      request: request,
      clear: clear,
      dispose: dispose,
      getDiagnostics: getDiagnostics,
    }
  }

  root.BattleSkillPreview = { create: create }
})(typeof window !== 'undefined' ? window : globalThis)
