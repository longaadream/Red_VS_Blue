(function (root) {
  'use strict'

  const STORAGE_KEY = 'rvb_piece_deck_presets'
  const SCHEMA_VERSION = 1

  function emptyStore() {
    return { version: SCHEMA_VERSION, presets: [] }
  }

  function normalizePreset(preset) {
    if (!preset || typeof preset !== 'object') return null
    const id = typeof preset.id === 'string' ? preset.id.trim() : ''
    const name = typeof preset.name === 'string' ? preset.name.trim().slice(0, 24) : ''
    const alignment = preset.alignment
    const pieceIds = Array.isArray(preset.pieceIds)
      ? preset.pieceIds.filter(function (pieceId) { return typeof pieceId === 'string' && pieceId.length > 0 })
      : []
    if (!id || !name || (alignment !== 'good' && alignment !== 'evil')) return null
    if (pieceIds.length !== 8 || new Set(pieceIds).size !== 8) return null
    return {
      id: id,
      name: name,
      alignment: alignment,
      pieceIds: pieceIds.slice(),
      updatedAt: Number.isFinite(preset.updatedAt) ? preset.updatedAt : 0
    }
  }

  function parse(raw) {
    try {
      const value = JSON.parse(raw || 'null')
      if (!value || value.version !== SCHEMA_VERSION || !Array.isArray(value.presets)) return emptyStore()
      return {
        version: SCHEMA_VERSION,
        presets: value.presets.map(normalizePreset).filter(Boolean)
      }
    } catch {
      return emptyStore()
    }
  }

  function serialize(store) {
    const presets = Array.isArray(store && store.presets)
      ? store.presets.map(normalizePreset).filter(Boolean)
      : []
    return JSON.stringify({ version: SCHEMA_VERSION, presets: presets })
  }

  function upsert(store, input) {
    const preset = normalizePreset(input)
    if (!preset) throw new Error('Invalid deck preset')
    const next = parse(serialize(store))
    const index = next.presets.findIndex(function (entry) { return entry.id === preset.id })
    if (index === -1) next.presets.push(preset)
    else next.presets[index] = preset
    return next
  }

  function remove(store, id) {
    const next = parse(serialize(store))
    next.presets = next.presets.filter(function (entry) { return entry.id !== id })
    return next
  }

  function isValidSelection(pieceIds, alignment, pieces) {
    if (alignment !== 'good' && alignment !== 'evil') return false
    if (!Array.isArray(pieceIds) || pieceIds.length !== 8 || new Set(pieceIds).size !== 8) return false
    if (!Array.isArray(pieces)) return false
    const factionById = new Map(pieces.map(function (piece) { return [piece && piece.id, piece && piece.faction] }))
    return pieceIds.every(function (pieceId) { return factionById.get(pieceId) === alignment })
  }

  root.RvBDeckPresets = Object.freeze({
    STORAGE_KEY: STORAGE_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    emptyStore: emptyStore,
    parse: parse,
    serialize: serialize,
    upsert: upsert,
    remove: remove,
    isValidSelection: isValidSelection
  })
})(typeof window !== 'undefined' ? window : globalThis)
