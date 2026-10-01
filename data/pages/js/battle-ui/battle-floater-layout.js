;(function () {
  'use strict'

  const MARGIN = 8
  const GAP = 6
  const MAX_CANDIDATES = 256

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)) }
  function overlaps(a, b) {
    return a.left < b.right + GAP && a.right + GAP > b.left && a.top < b.bottom + GAP && a.bottom + GAP > b.top
  }

  // Enclose the entire existing pop/rotation/rise animation, including its burst background.
  function envelope(width, height) {
    const angle = Math.PI / 15
    const rotatedWidth = (width + 14) * 1.18 * Math.cos(angle) + (height + 10) * 1.18 * Math.sin(angle) + 8
    const rotatedHeight = (height + 10) * 1.18 * Math.cos(angle) + (width + 14) * 1.18 * Math.sin(angle)
    return { halfWidth: Math.ceil(rotatedWidth / 2), above: Math.ceil(40 + (rotatedHeight - height) / 2), below: Math.ceil(height + (rotatedHeight - height) / 2 + 14) }
  }

  // Newest entries claim their anchor first. Older entries prefer a free slot above it.
  // Search is bounded: an overfilled viewport keeps every result but may have overlap.
  function arrange(entries, bounds, obstacles) {
    const placed = (obstacles || []).slice()
    const results = new Map()
    entries.slice().reverse().forEach(function (entry) {
      const shape = envelope(entry.width, entry.height)
      const minX = MARGIN + shape.halfWidth
      const maxX = Math.max(minX, bounds.width - MARGIN - shape.halfWidth)
      const minY = MARGIN + shape.above
      const maxY = Math.max(minY, bounds.height - MARGIN - shape.below)
      const origin = { x: clamp(entry.x, minX, maxX), y: clamp(entry.y, minY, maxY) }
      const oversized = shape.halfWidth * 2 + MARGIN * 2 > bounds.width || shape.above + shape.below + MARGIN * 2 > bounds.height
      function rect(point) {
        return { left: point.x - shape.halfWidth, right: point.x + shape.halfWidth, top: point.y - shape.above, bottom: point.y + shape.below }
      }
      function score(point) {
        return Math.abs(point.x - origin.x) * 4 + Math.abs(point.y - origin.y) + (point.y > origin.y ? 2 * (shape.above + shape.below) : 0)
      }
      const candidates = []
      const seen = new Set()
      function offer(x, y) {
        const point = { x: clamp(x, minX, maxX), y: clamp(y, minY, maxY) }
        const key = Math.round(point.x) + ':' + Math.round(point.y)
        if (seen.has(key) || seen.size >= MAX_CANDIDATES) return
        seen.add(key)
        candidates.push(point)
      }
      offer(origin.x, origin.y)
      let chosen = origin
      let crowded = true
      while (candidates.length) {
        candidates.sort(function (a, b) { return score(a) - score(b) })
        const point = candidates.shift()
        const box = rect(point)
        const collisions = placed.filter(function (other) { return overlaps(box, other) })
        if (!collisions.length) { chosen = point; crowded = oversized; break }
        collisions.forEach(function (other) {
          offer(point.x, other.top - shape.below - GAP)
          offer(other.left - shape.halfWidth - GAP, point.y)
          offer(other.right + shape.halfWidth + GAP, point.y)
          offer(point.x, other.bottom + shape.above + GAP)
        })
      }
      const box = rect(chosen)
      placed.push(box)
      results.set(entry, { x: chosen.x, y: chosen.y, crowded: crowded, box: box })
    })
    return entries.map(function (entry) { return results.get(entry) })
  }

  function create(layer) {
    const entries = []
    function layout() {
      const bounds = layer.getBoundingClientRect()
      if (!(bounds.width > 0 && bounds.height > 0)) return
      entries.forEach(function (entry) { entry.element.style.maxWidth = Math.max(24, bounds.width / 1.3 - 40) + 'px' })
      entries.forEach(function (entry) {
        const el = entry.element
        entry.width = el.offsetWidth || Math.max(52, String(el.textContent || '').length * 29 + 18)
        entry.height = el.offsetHeight || 40
      })
      const obstacles = []
      if (layer.ownerDocument) {
        layer.ownerDocument.querySelectorAll('[data-floater-obstacle]').forEach(function (el) {
          if (el.hidden || el.getAttribute('aria-hidden') === 'true') return
          const box = el.getBoundingClientRect()
          if (!(box.width > 0 && box.height > 0)) return
          obstacles.push({ left: box.left - bounds.left, right: box.right - bounds.left, top: box.top - bounds.top, bottom: box.bottom - bounds.top })
        })
      }
      const positions = arrange(entries, bounds, obstacles)
      entries.forEach(function (entry, index) {
        const point = positions[index]
        entry.element.style.left = point.x + 'px'
        entry.element.style.top = point.y + 'px'
        entry.element.dataset.floaterCrowded = String(point.crowded)
      })
    }
    return {
      add: function (element, x, y) {
        entries.push({ element: element, x: x, y: y, width: 0, height: 0 })
        layout()
      },
      remove: function (element) {
        const index = entries.findIndex(function (entry) { return entry.element === element })
        if (index >= 0) entries.splice(index, 1)
        // Do not pull surviving text down when an older result expires.
      },
      clear: function () { entries.length = 0 },
      resize: layout,
    }
  }

  window.BattleFloaterLayout = Object.freeze({ create: create, arrange: arrange })
})()
