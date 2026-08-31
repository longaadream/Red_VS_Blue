/**
 * Thin browser transport for the server-authoritative PVE prototype.
 *
 * The server owns content resolution, Run state, legal commands, random seeds,
 * battle outcomes, and transitions. This client only transports a selected
 * legal command and remembers the last Run ID for navigation.
 */
;(function () {
  'use strict'

  const API_ROOT = '/api/pve'
  const LAST_RUN_STORAGE_KEY = 'rvb_pve_last_run_id'
  const LEGACY_RUN_STORAGE_KEY = 'rvb_pve_run'

  class PveApiError extends Error {
    constructor(message, status, code) {
      super(message)
      this.name = 'PveApiError'
      this.status = status
      this.code = code || null
    }
  }

  function errorDetails(payload, response) {
    const serverError = payload && payload.error
    if (typeof serverError === 'string') {
      return {
        message: typeof payload.message === 'string' ? payload.message : serverError,
        code: typeof payload.code === 'string' ? payload.code : serverError,
      }
    }
    if (serverError && typeof serverError === 'object') {
      return {
        message: typeof serverError.message === 'string'
          ? serverError.message
          : 'PVE request failed with HTTP ' + response.status,
        code: typeof serverError.code === 'string' ? serverError.code : null,
      }
    }
    return {
      message: 'PVE request failed with HTTP ' + response.status,
      code: null,
    }
  }

  async function requestJson(path, init) {
    const options = Object.assign({
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    }, init || {})

    if (options.body) {
      options.headers = Object.assign(
        { 'Content-Type': 'application/json' },
        options.headers || {},
      )
    }

    const response = await fetch(API_ROOT + path, options)
    let payload = null
    try {
      payload = await response.json()
    } catch {
      if (response.ok) {
        throw new PveApiError('PVE server returned invalid JSON', response.status)
      }
    }

    if (!response.ok) {
      const details = errorDetails(payload, response)
      throw new PveApiError(details.message, response.status, details.code)
    }
    return payload
  }

  function requireRunId(runId) {
    if (typeof runId !== 'string' || !runId.trim()) {
      throw new TypeError('A non-empty PVE Run ID is required')
    }
    return runId.trim()
  }

  function unwrapView(payload) {
    const view = payload && payload.view ? payload.view : payload
    if (!view || typeof view !== 'object') {
      throw new PveApiError('PVE server response is missing its public view', 200)
    }
    return view
  }

  function getLastRunId() {
    try {
      return localStorage.getItem(LAST_RUN_STORAGE_KEY)
    } catch {
      return null
    }
  }

  function rememberRunId(runId) {
    const value = requireRunId(runId)
    try {
      localStorage.setItem(LAST_RUN_STORAGE_KEY, value)
    } catch {
      // URL recovery remains available when storage is unavailable.
    }
  }

  function hasLegacyRun() {
    try {
      return localStorage.getItem(LEGACY_RUN_STORAGE_KEY) !== null
    } catch {
      return false
    }
  }

  function createCommandId() {
    if (!window.crypto || typeof window.crypto.randomUUID !== 'function') {
      throw new PveApiError('This browser cannot create an idempotency command ID', 0)
    }
    return 'pve-command-' + window.crypto.randomUUID()
  }

  function buildCommand(view, legalCommand) {
    const runId = requireRunId(view && view.runId)
    if (!view || !Number.isSafeInteger(view.revision) || view.revision < 0) {
      throw new TypeError('The public PVE view has no valid revision')
    }
    if (!legalCommand || typeof legalCommand.type !== 'string') {
      throw new TypeError('A server-provided legal command is required')
    }
    const parameters = legalCommand.parameters
    if (
      parameters !== undefined
      && (
        parameters === null
        || typeof parameters !== 'object'
        || Array.isArray(parameters)
      )
    ) {
      throw new TypeError('Legal command parameters must be an object')
    }
    return Object.assign({}, parameters || {}, {
      schemaVersion: 'rvb-pve-command/v1',
      runId,
      commandId: createCommandId(),
      expectedRevision: view.revision,
      type: legalCommand.type,
    })
  }

  async function loadCatalog() {
    return requestJson('')
  }

  async function createRun(campaignId) {
    if (typeof campaignId !== 'string' || !campaignId.trim()) {
      throw new TypeError('A campaign ID is required')
    }
    const payload = await requestJson('/runs', {
      method: 'POST',
      body: JSON.stringify({ campaignId: campaignId.trim() }),
    })
    const view = unwrapView(payload)
    rememberRunId(view.runId)
    return { view, transition: payload && payload.transition }
  }

  async function loadRun(runId) {
    const id = requireRunId(runId)
    const payload = await requestJson('/runs/' + encodeURIComponent(id))
    const view = unwrapView(payload)
    rememberRunId(view.runId)
    return { view, transition: payload && payload.transition }
  }

  async function submitLegalCommand(view, legalCommand) {
    const runId = requireRunId(view && view.runId)
    const command = buildCommand(view, legalCommand)
    const payload = await requestJson(
      '/runs/' + encodeURIComponent(runId) + '/commands',
      {
        method: 'POST',
        body: JSON.stringify(command),
      },
    )
    const nextView = unwrapView(payload)
    rememberRunId(nextView.runId)
    return { view: nextView, transition: payload && payload.transition }
  }

  window.RvBPve = Object.freeze({
    loadCatalog,
    createRun,
    loadRun,
    submitLegalCommand,
    getLastRunId,
    rememberRunId,
    hasLegacyRun,
  })
})()
