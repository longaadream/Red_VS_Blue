/**
 * pve-api.js
 *
 * Public interface for PVE development.
 * Keep PVE-specific data under data/pve/ and PVE-specific UI under pve.html.
 * This file intentionally avoids PVP room, account, WebSocket and server logic.
 */
;(function () {
  'use strict'

  async function fetchJson(path) {
    if (window.fetchPackJson && /^\.?\/?data\//.test(path)) {
      return window.fetchPackJson(path)
    }
    const res = await fetch(path)
    if (!res.ok) throw new Error('HTTP ' + res.status + ' while loading ' + path)
    return res.json()
  }

  function pvePath(type, id) {
    return './data/pve/' + type + '/' + id + '.json'
  }

  async function loadManifest() {
    return fetchJson('./data/pve/manifest.json')
  }

  async function loadIds(type) {
    const manifest = await loadManifest()
    const value = manifest[type]
    return Array.isArray(value) ? value : []
  }

  async function loadMany(type) {
    const ids = await loadIds(type)
    const items = []
    for (const id of ids) {
      try { items.push(await fetchJson(pvePath(type, id))) } catch (e) { console.warn('[PVE] skip bad ' + type + ':', id, e) }
    }
    return items
  }

  function createRunState(options) {
    options = options || {}
    return {
      id: 'pve-run-' + Date.now().toString(36),
      mode: 'pve',
      chapterId: options.chapterId || null,
      seed: options.seed || Math.floor(Math.random() * 4294967296),
      step: 0,
      party: options.party || [],
      deck: options.deck || [],
      relics: options.relics || [],
      flags: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
  }

  window.RvBPve = {
    fetchJson,
    loadManifest,
    loadIds,
    loadMany,
    loadChapters: function () { return loadMany('chapters') },
    loadEncounters: function () { return loadMany('encounters') },
    loadEvents: function () { return loadMany('events') },
    loadRewards: function () { return loadMany('rewards') },
    loadRelics: function () { return loadMany('relics') },
    loadEnemies: function () { return loadMany('enemies') },
    loadChapter: function (id) { return fetchJson(pvePath('chapters', id)) },
    loadEncounter: function (id) { return fetchJson(pvePath('encounters', id)) },
    loadEvent: function (id) { return fetchJson(pvePath('events', id)) },
    loadReward: function (id) { return fetchJson(pvePath('rewards', id)) },
    loadRelic: function (id) { return fetchJson(pvePath('relics', id)) },
    createRunState,
  }
})()
