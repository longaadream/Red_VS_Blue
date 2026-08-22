;(function (root) {
  'use strict'

  const canvas = Object.freeze({
    width: 512,
    height: 1024,
    baselineY: 932,
    safeMarginPx: 32,
  })

  const entryList = [
    { templateId: 'ana', status: 'portrait-fallback', src: null },
    { templateId: 'anduin', status: 'portrait-fallback', src: null },
    { templateId: 'arthas', status: 'ready', src: 'public/standees/arthas.png' },
    { templateId: 'blue-kenshin', status: 'portrait-fallback', src: null },
    { templateId: 'blue-minato', status: 'portrait-fallback', src: null },
    { templateId: 'blue-naruto', status: 'ready', src: 'public/standees/blue-naruto.png' },
    { templateId: 'blue-tirion-fordring', status: 'portrait-fallback', src: null },
    { templateId: 'blue-watcher', status: 'portrait-fallback', src: null },
    { templateId: 'guldan', status: 'portrait-fallback', src: null },
    { templateId: 'hashirama-edo', status: 'portrait-fallback', src: null },
    { templateId: 'jaina', status: 'ready', src: 'public/standees/jaina.png' },
    { templateId: 'kiljaedan', status: 'portrait-fallback', src: null },
    { templateId: 'liadrin', status: 'portrait-fallback', src: null },
    { templateId: 'reaper', status: 'portrait-fallback', src: null },
    { templateId: 'red-blackwidow', status: 'portrait-fallback', src: null },
    { templateId: 'red-doomsday-fist', status: 'portrait-fallback', src: null },
    { templateId: 'red-hidan', status: 'portrait-fallback', src: null },
    { templateId: 'red-illidan', status: 'portrait-fallback', src: null },
    { templateId: 'red-obito', status: 'portrait-fallback', src: null },
    { templateId: 'red-rafaam', status: 'portrait-fallback', src: null },
    { templateId: 'red-sasuke', status: 'portrait-fallback', src: null },
    { templateId: 'red-shishio', status: 'portrait-fallback', src: null },
    { templateId: 'red-venom', status: 'portrait-fallback', src: null },
    { templateId: 'tracer', status: 'portrait-fallback', src: null },
    { templateId: 'tyrande', status: 'portrait-fallback', src: null },
    { templateId: 'uther', status: 'portrait-fallback', src: null },
  ]

  const entries = Object.freeze(Object.fromEntries(entryList.map(function (entry) {
    return [entry.templateId, Object.freeze(entry)]
  })))

  function resolve(templateId) {
    return entries[String(templateId || '')] || null
  }

  root.BattleStandeeManifest = Object.freeze({
    schemaVersion: 1,
    canvas: canvas,
    fallback: 'portrait-token',
    entries: entries,
    resolve: resolve,
  })
})(typeof window !== 'undefined' ? window : globalThis)
