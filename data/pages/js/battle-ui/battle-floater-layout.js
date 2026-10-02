;(function () {
  'use strict'

  const MARGIN = 8
  // Keep the readable text cores close together.  The burst background and
  // the last few pixels of the rise animation may overlap slightly; reserving
  // their full animation envelope made a four-hit result stack needlessly tall.
  const GAP = 2
  const CORE_PADDING_X = 3
  const CORE_PADDING_Y = 2
  const MAX_CANDIDATES = 256

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)) }
  function overlaps(a, b) {
    return a.left < b.right + GAP && a.right + GAP > b.left && a.top < b.bottom + GAP && a.bottom + GAP > b.top
  }

  // Layout the readable text core, with only a small allowance for its border.
  // The CSS burst/rotation is decorative and deliberately does not reserve its
  // full animated envelope.  This keeps same-anchor results around one text
  // line apart while still avoiding collisions between the actual messages.
  function envelope(width, height) {
    // rvbResultFloat's readable phase uses translateY(-10px).  `top` is the
    // element's anchor, not its vertical center, so the core runs from
    // y - 10 through y - 10 + height.
    const coreTop = -10
    const coreBottom = coreTop + height
    return {
      halfWidth: Math.ceil(width / 2 + CORE_PADDING_X),
      above: Math.ceil(-coreTop + CORE_PADDING_Y),
      below: Math.max(CORE_PADDING_Y, Math.ceil(coreBottom + CORE_PADDING_Y)),
    }
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
        return Math.abs(point.x - origin.x) * 4 + Math.abs(point.y - origin.y) + (point.y > origin.y ? 4 * (shape.above + shape.below) : 0)
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
