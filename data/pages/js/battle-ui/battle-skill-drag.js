;(function (root) {
  'use strict'

  const DRAG_DISTANCE = 8
  const SKILL_SELECTOR = '.piece-context-skill, .character-cast'

  function eventPoint(event) {
    return {
      x: Number.isFinite(Number(event && event.clientX)) ? Number(event.clientX) : 0,
      y: Number.isFinite(Number(event && event.clientY)) ? Number(event.clientY) : 0,
    }
  }

  function pointerIsPrimary(event) {
    return !event || event.pointerType !== 'mouse' || event.button === 0 || event.button == null
  }

  function disabled(button) {
    return !!button && (button.disabled === true
      || (typeof button.getAttribute === 'function' && (
        button.getAttribute('aria-disabled') === 'true' || button.getAttribute('disabled') !== null
      )))
  }

  function buttonForTarget(target) {
    if (!target || typeof target.closest !== 'function') return null
    const button = target.closest(SKILL_SELECTOR)
    return button || null
  }

  function cellKey(cell) {
    if (cell == null) return 'outside'
    if (typeof cell === 'object') {
      if (cell.x != null || cell.y != null) return String(cell.x) + ',' + String(cell.y)
      try { return JSON.stringify(cell) } catch { return String(cell) }
    }
    return String(cell)
  }

  function create(options) {
    const input = options || {}
    const documentRoot = input.root || root.document || root
    const view = documentRoot && documentRoot.defaultView
    const captureRoot = documentRoot && documentRoot.documentElement
    const resolve = typeof input.resolve === 'function' ? input.resolve : function () { return null }
    const arm = typeof input.arm === 'function' ? input.arm : function () { return false }
    const cellAt = typeof input.cellAt === 'function' ? input.cellAt : function () { return null }
    const preview = typeof input.preview === 'function' ? input.preview : function () {}
    const clear = typeof input.clear === 'function' ? input.clear : function () {}
    const release = typeof input.release === 'function' ? input.release : function () {}
    const onError = typeof input.onError === 'function' ? input.onError : function () {}

    let disposed = false
    let active = null
    let suppressClick = false
    let suppressTimer = null
    let multiPointer = false
    const pointersDown = new Set()

    function report(error) {
      try { onError(error) } catch (callbackError) { setTimeout(function () { throw callbackError }, 0) }
    }

    function call(callback) {
      try { return { ok: true, value: callback() } } catch (error) {
        report(error)
        return { ok: false, value: undefined }
      }
    }

    function clearPreview() {
      call(clear)
    }

    function releaseCapture(pointerId) {
      if (!captureRoot || typeof captureRoot.releasePointerCapture !== 'function') return
      try { captureRoot.releasePointerCapture(pointerId) } catch {}
    }

    function cancelActive() {
      const current = active
      active = null
      if (!current) return
      releaseCapture(current.pointerId)
      if (current.dragging) clearPreview()
    }

    function setSuppressClick() {
      suppressClick = true
      if (suppressTimer != null) {
        clearTimeout(suppressTimer)
        suppressTimer = null
      }
      if (typeof setTimeout === 'function') {
        suppressTimer = setTimeout(function () {
          suppressClick = false
          suppressTimer = null
        }, 0)
      }
    }

    function resolveCell(event) {
      const point = eventPoint(event)
      const result = call(function () { return cellAt(point.x, point.y) })
      return result.ok ? result.value : null
    }

    function showPreview(event) {
      if (!active || !active.dragging) return
      const cell = resolveCell(event)
      const key = cellKey(cell)
      if (key === active.previewKey) return
      active.previewKey = key
      call(function () { return preview(cell) })
    }

    function armDrag(event) {
      if (!active || active.dragging || active.armAttempted) return
      const point = eventPoint(event)
      const dx = point.x - active.startX
      const dy = point.y - active.startY
      if (Math.hypot(dx, dy) < DRAG_DISTANCE) return
      active.armAttempted = true
      const result = call(function () { return arm(active.context) })
      if (!result.ok || result.value !== true) return
      active.dragging = true
      active.previewKey = null
      if (captureRoot && typeof captureRoot.setPointerCapture === 'function') {
        try { captureRoot.setPointerCapture(active.pointerId) } catch {}
      }
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
      showPreview(event)
    }

    function endPointer(event, cancelled) {
      const current = active
      if (!current || event && event.pointerId !== current.pointerId) return
      active = null
      releaseCapture(current.pointerId)
      if (!current.dragging) return
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
      const cell = cancelled ? null : resolveCell(event)
      clearPreview()
      if (!cancelled && cell != null) call(function () { return release(cell) })
      if (!cancelled) setSuppressClick()
    }

    function onPointerDown(event) {
      if (disposed || !pointerIsPrimary(event)) return
      const pointerId = event && event.pointerId
      if (pointerId != null) pointersDown.add(pointerId)
      if (multiPointer) return
      if (active) {
        if (pointerId === active.pointerId) return
        multiPointer = true
        cancelActive()
        return
      }
      if (pointersDown.size > 1) {
        multiPointer = true
        return
      }
      const button = buttonForTarget(event && event.target)
      if (!button || disabled(button)) return
      const skillId = button.dataset && button.dataset.skillId
      if (!skillId) return
      const resolved = call(function () { return resolve(button) })
      if (!resolved.ok || resolved.value == null) return
      const point = eventPoint(event)
      active = {
        pointerId: pointerId,
        button: button,
        context: resolved.value,
        startX: point.x,
        startY: point.y,
        armAttempted: false,
        dragging: false,
        previewKey: null,
      }
    }

    function onPointerMove(event) {
      if (disposed || multiPointer || !active || event && event.pointerId !== active.pointerId) return
      if (!active.dragging) armDrag(event)
      else {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        showPreview(event)
      }
    }

    function onPointerUp(event) {
      const pointerId = event && event.pointerId
      if (pointerId != null) pointersDown.delete(pointerId)
      if (multiPointer) {
        if (pointersDown.size === 0) multiPointer = false
        return
      }
      endPointer(event, false)
    }

    function onPointerCancel(event) {
      const pointerId = event && event.pointerId
      if (pointerId != null) pointersDown.delete(pointerId)
      if (multiPointer) {
        if (pointersDown.size === 0) multiPointer = false
        return
      }
      endPointer(event, true)
    }

    function onClick(event) {
      if (!suppressClick) return
      suppressClick = false
      if (suppressTimer != null) {
        clearTimeout(suppressTimer)
        suppressTimer = null
      }
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
      if (event && typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
      else if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
    }

    function onBlur() {
      pointersDown.clear()
      multiPointer = false
      cancelActive()
    }

    function onKeyDown(event) {
      if (!event || event.key !== 'Escape') return
      if (!active) return
      onBlur()
      if (typeof event.preventDefault === 'function') event.preventDefault()
    }

    function onLostPointerCapture(event) {
      if (!captureRoot || !event || event.target !== captureRoot) return
      onPointerCancel(event)
    }

    function listen(target, type, handler, options) {
      if (target && typeof target.addEventListener === 'function') target.addEventListener(type, handler, options)
    }

    function unlisten(target, type, handler, options) {
      if (target && typeof target.removeEventListener === 'function') target.removeEventListener(type, handler, options)
    }

    listen(documentRoot, 'pointerdown', onPointerDown, true)
    listen(documentRoot, 'pointermove', onPointerMove, true)
    listen(documentRoot, 'pointerup', onPointerUp, true)
    listen(documentRoot, 'pointercancel', onPointerCancel, true)
    listen(documentRoot, 'click', onClick, true)
    listen(documentRoot, 'keydown', onKeyDown, true)
    listen(documentRoot, 'lostpointercapture', onLostPointerCapture, true)
    listen(view, 'blur', onBlur)

    function dispose() {
      if (disposed) return
      disposed = true
      onBlur()
      if (suppressTimer != null) {
        clearTimeout(suppressTimer)
        suppressTimer = null
      }
      unlisten(documentRoot, 'pointerdown', onPointerDown, true)
      unlisten(documentRoot, 'pointermove', onPointerMove, true)
      unlisten(documentRoot, 'pointerup', onPointerUp, true)
      unlisten(documentRoot, 'pointercancel', onPointerCancel, true)
      unlisten(documentRoot, 'click', onClick, true)
      unlisten(documentRoot, 'keydown', onKeyDown, true)
      unlisten(documentRoot, 'lostpointercapture', onLostPointerCapture, true)
      unlisten(view, 'blur', onBlur)
    }

    return { dispose: dispose, cancel: onBlur }
  }

  root.BattleSkillDrag = { create: create }
})(typeof window !== 'undefined' ? window : globalThis)
