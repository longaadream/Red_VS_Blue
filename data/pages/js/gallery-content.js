;(function (root) {
  'use strict'
  // Shared by the in-game gallery and the public website generator.
  function isGalleryPiece(piece) {
    if (!piece || String(piece.id || '').startsWith('pve-')) return false
    const modes = piece.availability && piece.availability.modes
    return !Array.isArray(modes) || modes.includes('pvp')
  }
  root.RvBGalleryContent = Object.freeze({ isGalleryPiece })
})(typeof window !== 'undefined' ? window : globalThis)
