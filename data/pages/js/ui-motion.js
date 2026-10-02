;(function (root, factory) {
  'use strict'

  var api = factory(root)
  if (typeof module === 'object' && module.exports) {
    module.exports = api
    if (root && root.document && typeof api.autoInit === 'function') api.autoInit(root)
    return
  }
  // Loading the shared script twice must not install another delegated listener.
  if (!root.UiMotion || typeof root.UiMotion.create !== 'function') root.UiMotion = api
  else api = root.UiMotion

  if (root && root.document && api && typeof api.autoInit === 'function') api.autoInit(root)
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function (globalRoot) {
  'use strict'

  var ROOT_CLASSES = ['ui-motion-enabled', 'ui-motion-ready', 'ui-motion-fine-pointer']
  var HAND_CARD_MAX_TILT = 5
  var SKILL_MAX_TILT = 2
  var CONTROL_MAX_TILT = 2
  var HOVER_SCALE = 1
  // Keep the press snapshot at neutral scale so the decorative layer never
  // changes a card's hit area while a page's native :active state responds.
  var PRESS_SCALE = 1
  var FRAME_MS = 16
  var MAX_FRAME_SECONDS = 0.032
  var STIFFNESS = 260
  var DAMPING = 28
  var ANGLE_EPSILON = 0.01
  var SCALE_EPSILON = 0.0005
  var VELOCITY_EPSILON = 0.01
  var DRAG_DISTANCE = 8

  /*
   * These selectors are deliberately explicit. A generic `button:hover` rule
   * would also catch battlefield controls, history replay controls, and static
   * information panels that should never acquire a visual offset.
   */
  var PROFILE_RULES = [
    {
      name: 'hand-card',
      maxTilt: HAND_CARD_MAX_TILT,
      selectors: [
        '#handCards > .card-item',
        '[data-ui-motion="hand-card"]',
        '[data-motion-profile="hand-card"]',
      ],
    },
    {
      name: 'card',
      maxTilt: HAND_CARD_MAX_TILT,
      selectors: [
        '#pieceGrid > .piece-card:not(.expanded)',
        '#pieceList > .piece-card:not(.expanded)',
        '.deck-gallery > .deck-card',
        '#mapList > .map-card:not(.expanded)',
        '#mapCards > .ranked-map-card',
        '#campaignList > .card',
        '#lessons > .lesson-card:not(.is-unavailable)',
        '.piece-choice',
        '[data-ui-motion="card"]',
        '[data-motion-profile="card"]',
      ],
    },
    {
      name: 'skill-card',
      maxTilt: SKILL_MAX_TILT,
      selectors: [
        '.pi-skill',
        '[data-ui-motion="skill-card"]',
        '[data-motion-profile="skill-card"]',
      ],
    },
    {
      name: 'control',
      maxTilt: CONTROL_MAX_TILT,
      selectors: [
        '.mode-tab',
        '.action-button',
        '.tutorial-shortcut',
        '.room-row button',
        '.room-row a[href]',
        '.room-card button',
        '.room-card a[href]',
        '[data-ui-motion="control"]',
        '[data-motion-profile="control"]',
        '.icon-button',
        '.button',
        '.btn',
        'button',
        'a[href]',
        '[role="button"]',
      ],
    },
  ]

  var EXCLUDED_SELECTORS = [
    'canvas',
    '#board',
    '#boardWrap',
    '.board-wrap',
    '.battle-board',
    '[data-board]',
    '.action-history',
    '.action-history-item',
    '.history-card',
    '#historyCardFace',
    '.battle-action-vignette',
    '.dmg-float',
    '[data-floater]',
    '[data-renderer-overlay]',
    '.renderer-overlay',
    '.target-overlay',
    '.piece-context-menu',
    '.piece-context-skills',
    '.piece-context-skill',
    '.related-hand-cards',
    '.related-hand-card',
    '.player-slot',
    '.rank-arena',
    '#packStatusCard',
  ]

  function asDocument(options) {
    var input = options || {}
    return input.document || input.root || (globalRoot && globalRoot.document) || null
  }

  function asWindow(options, documentRef) {
    var input = options || {}
    return input.window || (documentRef && documentRef.defaultView) || globalRoot || null
  }

  function listen(target, type, handler, options) {
    if (target && typeof target.addEventListener === 'function') target.addEventListener(type, handler, options)
  }

  function unlisten(target, type, handler, options) {
    if (target && typeof target.removeEventListener === 'function') target.removeEventListener(type, handler, options)
  }

  function mediaQuery(windowRef, query) {
    if (!windowRef || typeof windowRef.matchMedia !== 'function') return null
    try { return windowRef.matchMedia(query) } catch { return null }
  }

  function mediaMatches(media, fallback) {
    return media && typeof media.matches === 'boolean' ? media.matches : fallback
  }

  function addClass(target, name) {
    if (target && target.classList && typeof target.classList.add === 'function') target.classList.add(name)
  }

  function removeClass(target, name) {
    if (target && target.classList && typeof target.classList.remove === 'function') target.classList.remove(name)
  }

  function hasClass(target, name) {
    return !!(target && target.classList && typeof target.classList.contains === 'function' && target.classList.contains(name))
  }

  function attribute(target, name) {
    if (!target || typeof target.getAttribute !== 'function') return null
    return target.getAttribute(name)
  }

  function isElement(target) {
    return !!target && (target.nodeType === 1 || typeof target.matches === 'function' || typeof target.closest === 'function')
  }

  function parentOf(target) {
    return target && (target.parentElement || target.parentNode) || null
  }

  function isDescendant(rootElement, target) {
    if (!rootElement || !target) return false
    if (rootElement === target) return true
    if (typeof rootElement.contains === 'function') {
      try { return rootElement.contains(target) } catch {}
    }
    var current = target
    while (current) {
      current = parentOf(current)
      if (current === rootElement) return true
    }
    return false
  }

  function safeMatches(target, selector) {
    if (!target || typeof target.matches !== 'function') return false
    try { return target.matches(selector) } catch { return false }
  }

  function hasAnyMatch(target, selectors) {
    for (var i = 0; i < selectors.length; i += 1) if (safeMatches(target, selectors[i])) return true
    return false
  }

  function hasEnabledDescendant(target) {
    if (!target || typeof target.querySelector !== 'function') return false
    try {
      var controls = target.querySelectorAll('button, a[href], [role="button"], [data-ui-motion], [data-motion-profile]')
      for (var i = 0; i < controls.length; i += 1) {
        var control = controls[i]
        if (!control.disabled && attribute(control, 'aria-disabled') !== 'true' && attribute(control, 'disabled') === null) return true
      }
    } catch {}
    return false
  }

  function isInteractiveElement(target, profileName) {
    if (!target) return false
    var tag = String(target.tagName || '').toLowerCase()
    var role = attribute(target, 'role')
    var direct = tag === 'button' || tag === 'a' || role === 'button' || role === 'link'
      || typeof target.onclick === 'function' || attribute(target, 'onclick') !== null
    // Card entries rendered as article/divs are intentionally allowed only
    // when their explicit explorer profile contains an enabled action.
    if (!direct && profileName === 'card') direct = hasEnabledDescendant(target)
    if (!direct && profileName === 'skill-card') direct = hasEnabledDescendant(target)
    if (!direct && profileName === 'hand-card') direct = hasEnabledDescendant(target)
    if (!direct && attribute(target, 'data-ui-motion') && attribute(target, 'data-ui-motion') !== 'static') direct = true
    if (!direct && attribute(target, 'data-motion-profile') && attribute(target, 'data-motion-profile') !== 'static') direct = true
    if (!direct) return false
    if (target.disabled === true || attribute(target, 'disabled') !== null) return false
    if (attribute(target, 'aria-disabled') === 'true') return false
    if (attribute(target, 'aria-hidden') === 'true' || target.hidden === true) return false
    if (hasClass(target, 'disabled') || hasClass(target, 'is-disabled') || hasClass(target, 'card-disabled') || hasClass(target, 'card-choice-disabled') || hasClass(target, 'is-unavailable')) return false
    if (attribute(target, 'data-motion-disabled') === 'true' || attribute(target, 'data-disabled') === 'true' || attribute(target, 'data-ui-motion') === 'static') return false
    return true
  }

  function hasDisabledAncestor(target, rootElement) {
    var current = target
    while (current && current !== rootElement) {
      if (current.disabled === true || attribute(current, 'disabled') !== null || attribute(current, 'aria-disabled') === 'true'
        || current.inert === true || attribute(current, 'inert') !== null || attribute(current, 'data-disabled') === 'true'
        || current.hidden === true || attribute(current, 'aria-hidden') === 'true'
        || hasClass(current, 'disabled') || hasClass(current, 'is-disabled')
        || hasClass(current, 'card-disabled') || hasClass(current, 'card-choice-disabled') || hasClass(current, 'is-unavailable')) return true
      current = parentOf(current)
    }
    return false
  }

  function isExcluded(target, rootElement) {
    var current = target
    while (current && current !== rootElement) {
      if (hasAnyMatch(current, EXCLUDED_SELECTORS)) return true
      if (attribute(current, 'data-motion-disabled') === 'true' || attribute(current, 'data-disabled') === 'true' || attribute(current, 'data-ui-motion') === 'static') return true
      if (hasClass(current, 'is-passive') || hasClass(current, 'passive')) return true
      current = parentOf(current)
    }
    return !!(current && hasAnyMatch(current, EXCLUDED_SELECTORS))
  }

  function isBlockedByInteraction(target, documentRef, rootElement) {
    if (isExcluded(target, rootElement)) return true
    var current = target
    while (current && current !== rootElement) {
      if (hasClass(current, 'dragging') || hasClass(current, 'is-dragging') || attribute(current, 'data-dragging') === 'true' || attribute(current, 'data-active-drag') === 'true') return true
      if (hasClass(current, 'target-mode-active') || attribute(current, 'data-targeting') === 'true') return true
      current = parentOf(current)
    }
    var body = documentRef && documentRef.body
    if (body && hasClass(body, 'target-mode-active')) return true
    return false
  }

  function activeSkillRow(target, rootElement, documentRef) {
    var current = target
    while (current && current !== rootElement) {
      if (safeMatches(current, '.pi-skill')) {
        if (isExcluded(current, rootElement) || isBlockedByInteraction(current, documentRef, rootElement) || hasDisabledAncestor(current, rootElement)) return null
        var cast = null
        try { cast = current.querySelector('.character-cast') } catch {}
        if (cast && isInteractiveElement(cast, 'skill-card')) return current
      }
      current = parentOf(current)
    }
    return null
  }

  function profileFor(target, rootElement, documentRef) {
    if (!target) return null
    var current = isElement(target) ? target : parentOf(target)
    var activeSkill = activeSkillRow(current, rootElement, documentRef)
    if (activeSkill) return { name: 'skill-card', maxTilt: SKILL_MAX_TILT, element: activeSkill }
    while (current && current !== rootElement) {
      if (isExcluded(current, rootElement) || isBlockedByInteraction(current, documentRef, rootElement)) return null
      if (hasDisabledAncestor(current, rootElement)) return null

      for (var i = 0; i < PROFILE_RULES.length; i += 1) {
        var rule = PROFILE_RULES[i]
        if (!hasAnyMatch(current, rule.selectors)) continue
        if (!isInteractiveElement(current, rule.name)) continue
        return { name: rule.name, maxTilt: rule.maxTilt, element: current }
      }

      current = parentOf(current)
    }
    return null
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value))
  }

  function pointerIsMouse(event, finePointer) {
    if (!finePointer) return false
    if (!event || event.pointerType == null || event.pointerType === '') return true
    return event.pointerType === 'mouse'
  }

  function pointFromEvent(event) {
    return {
      x: Number.isFinite(Number(event && event.clientX)) ? Number(event.clientX) : 0,
      y: Number.isFinite(Number(event && event.clientY)) ? Number(event.clientY) : 0,
    }
  }

  function isAnimationCapable(element) {
    return !!element && typeof element.animate === 'function'
  }

  function finiteRect(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return null
    try {
      var rect = element.getBoundingClientRect()
      if (!rect) return null
      var width = Number(rect.width)
      var height = Number(rect.height)
      if (!(width > 0) || !(height > 0)) return null
      return { left: Number(rect.left) || 0, top: Number(rect.top) || 0, width: width, height: height }
    } catch { return null }
  }

  function transformFor(state) {
    var rotateX = -state.current.y * state.profile.maxTilt
    var rotateY = state.current.x * state.profile.maxTilt
    var scale = state.current.scale
    var perspective = Math.abs(rotateX) + Math.abs(rotateY) > ANGLE_EPSILON ? 'perspective(700px) ' : ''
    return perspective + 'rotateX(' + rotateX.toFixed(4) + 'deg) rotateY(' + rotateY.toFixed(4) + 'deg) scale(' + scale.toFixed(5) + ')'
  }

  function cancelAnimation(state) {
    if (!state || !state.animation) return
    try {
      if (typeof state.animation.cancel === 'function') state.animation.cancel()
    } catch {}
    state.animation = null
  }

  function createAnimation(state) {
    var element = state.element
    if (!isAnimationCapable(element)) return null
    var transform = transformFor(state)
    var keyframes = [
      { transform: transform, composite: 'add' },
      { transform: transform, composite: 'add' },
    ]
    var options = { duration: 1, easing: 'linear', fill: 'both', composite: 'add' }
    try {
      var animation = element.animate(keyframes, options)
      if (animation && typeof animation.pause === 'function') animation.pause()
      if (animation) animation.currentTime = 0
      if (animation && animation.effect && typeof animation.effect.getKeyframes === 'function') {
        var applied = animation.effect.getKeyframes()
        if (!applied || !applied.length || applied.some(function (frame) { return frame.composite !== 'add' })) {
          if (typeof animation.cancel === 'function') animation.cancel()
          return null
        }
      }
      return animation || null
    } catch {
      try { if (animation && typeof animation.cancel === 'function') animation.cancel() } catch {}
      return null
    }
  }

  function writeAnimation(state) {
    if (!state || !isAnimationCapable(state.element)) return false
    var transform = transformFor(state)
    var keyframes = [
      { transform: transform, composite: 'add' },
      { transform: transform, composite: 'add' },
    ]
    if (state.animation && state.animation.effect && typeof state.animation.effect.setKeyframes === 'function') {
      try {
        state.animation.effect.setKeyframes(keyframes)
        if (typeof state.animation.pause === 'function') state.animation.pause()
        state.animation.currentTime = 0
        return true
      } catch {
        cancelAnimation(state)
      }
    }
    if (!state.animation) {
      state.animation = createAnimation(state)
      return !!state.animation
    }
    // Fake animation implementations and older engines may expose no effect;
    // recreate the short paused snapshot so every update remains additive.
    if (!state.animation.effect || typeof state.animation.effect.setKeyframes !== 'function') {
      var previous = state.animation
      cancelAnimation(state)
      state.animation = createAnimation(state)
      if (!state.animation) return false
      if (previous && typeof previous.cancel === 'function') {
        try { previous.cancel() } catch {}
      }
      return true
    }
    return true
  }

  function create(options) {
    var input = options || {}
    var documentRef = asDocument(options)
    var windowRef = asWindow(options, documentRef)
    if (!input.forceNew && windowRef && windowRef.__UiMotionInstance
      && windowRef.__UiMotionInstance.document === documentRef
      && typeof windowRef.__UiMotionInstance.destroy === 'function') return windowRef.__UiMotionInstance
    var rootElement = input.rootElement || (documentRef && (documentRef.documentElement || documentRef.body)) || null
    var fineMedia = mediaQuery(windowRef, '(hover: hover) and (pointer: fine)')
    var reducedMedia = mediaQuery(windowRef, '(prefers-reduced-motion: reduce)')
    var finePointer = mediaMatches(fineMedia, true)
    var reducedMotion = mediaMatches(reducedMedia, false)
    var disposed = false
    var states = new Map()
    var hovered = null
    var activePointer = null
    var frameId = null
    var lastFrameTime = 0
    var addedClasses = []
    var mutationObserver = null

    if (!documentRef || !rootElement) return { destroy: function () {}, dispose: function () {} }

    function setRootCapability() {
      if (!rootElement) return
      if (finePointer) {
        ROOT_CLASSES.forEach(function (name) {
          if (!hasClass(rootElement, name)) {
            addClass(rootElement, name)
            addedClasses.push(name)
          }
        })
      } else {
        addedClasses = addedClasses.filter(function (name) {
          removeClass(rootElement, name)
          return false
        })
      }
    }

    function cancelFrame() {
      if (frameId == null) return
      try {
        if (windowRef && typeof windowRef.cancelAnimationFrame === 'function') windowRef.cancelAnimationFrame(frameId)
        else if (typeof windowRef.clearTimeout === 'function') windowRef.clearTimeout(frameId)
      } catch {}
      frameId = null
    }

    function scheduleFrame() {
      if (disposed || frameId != null || reducedMotion || !states.size) return
      if (windowRef && typeof windowRef.requestAnimationFrame === 'function') {
        frameId = windowRef.requestAnimationFrame(step)
      } else if (windowRef && typeof windowRef.setTimeout === 'function') {
        frameId = windowRef.setTimeout(function () { step(Date.now()) }, FRAME_MS)
      }
    }

    function removeState(state) {
      if (!state) return
      cancelAnimation(state)
      states.delete(state.element)
      if (hovered === state) hovered = null
      if (activePointer && activePointer.state === state) activePointer.state = null
    }

    function pruneStates() {
      states.forEach(function (state) {
        var profile = profileFor(state.element, rootElement, documentRef)
        if (!isDescendant(rootElement, state.element) || !profile || profile.element !== state.element) removeState(state)
        else state.profile = profile
      })
      if (!states.size) cancelFrame()
    }

    function resetMotion() {
      activePointer = null
      hovered = null
      states.forEach(function (state) { cancelAnimation(state) })
      states.clear()
      cancelFrame()
    }

    function stateFor(profile) {
      var state = states.get(profile.element)
      if (state) {
        state.profile = profile
        return state
      }
      if (!isAnimationCapable(profile.element)) return null
      state = {
        element: profile.element,
        profile: profile,
        current: { x: 0, y: 0, scale: 1 },
        target: { x: 0, y: 0, scale: 1 },
        velocity: { x: 0, y: 0, scale: 0 },
        hovering: false,
        pressed: false,
        dragging: false,
        animation: null,
        lastPoint: { x: 0, y: 0 },
      }
      states.set(profile.element, state)
      return state
    }

    function setPointerTarget(state, event) {
      if (!state || !event) return
      var rect = finiteRect(state.element)
      if (!rect) return
      var point = pointFromEvent(event)
      state.lastPoint = point
      state.target.x = clamp((point.x - (rect.left + rect.width / 2)) / (rect.width / 2), -1, 1)
      state.target.y = clamp((point.y - (rect.top + rect.height / 2)) / (rect.height / 2), -1, 1)
    }

    function setTargetScale(state) {
      if (!state) return
      state.target.scale = state.pressed ? PRESS_SCALE : state.hovering ? HOVER_SCALE : 1
    }

    function startHover(profile, event) {
      if (!profile || disposed || reducedMotion || !finePointer) return null
      var state = stateFor(profile)
      if (!state) return null
      if (hovered && hovered !== state) {
        hovered.hovering = false
        hovered.pressed = false
        hovered.target.x = 0
        hovered.target.y = 0
        setTargetScale(hovered)
        scheduleFrame()
      }
      hovered = state
      state.hovering = true
      state.pressed = false
      state.dragging = false
      setPointerTarget(state, event)
      setTargetScale(state)
      scheduleFrame()
      return state
    }

    function leaveElement(element) {
      var state = element && states.get(element)
      if (!state) return
      state.hovering = false
      state.pressed = false
      state.target.x = 0
      state.target.y = 0
      setTargetScale(state)
      if (hovered === state) hovered = null
      scheduleFrame()
    }

    function targetForEvent(event) {
      if (!event) return null
      var profile = profileFor(event.target, rootElement, documentRef)
      if (!profile || !isDescendant(rootElement, profile.element)) return null
      return profile
    }

    function relatedProfile(event) {
      if (!event || !event.relatedTarget) return null
      return profileFor(event.relatedTarget, rootElement, documentRef)
    }

    function onPointerOver(event) {
      if (disposed || !pointerIsMouse(event, finePointer) || reducedMotion) return
      pruneStates()
      var profile = targetForEvent(event)
      if (!profile) {
        if (!relatedProfile(event) && hovered) leaveElement(hovered.element)
        return
      }
      var related = relatedProfile(event)
      if (related && related.element === profile.element) return
      startHover(profile, event)
    }

    function onPointerMove(event) {
      if (disposed || !pointerIsMouse(event, finePointer) || reducedMotion) return
      pruneStates()
      if (activePointer && (event.pointerId == null || event.pointerId === activePointer.pointerId)) {
        var point = pointFromEvent(event)
        var dx = point.x - activePointer.startX
        var dy = point.y - activePointer.startY
        if (!activePointer.dragging && Math.hypot(dx, dy) >= DRAG_DISTANCE) {
          activePointer.dragging = true
          if (activePointer.state) {
            activePointer.state.dragging = true
            activePointer.state.hovering = false
            activePointer.state.pressed = false
            activePointer.state.target.x = 0
            activePointer.state.target.y = 0
            setTargetScale(activePointer.state)
            activePointer.state.current.scale = 1
            activePointer.state.velocity.scale = 0
            writeAnimation(activePointer.state)
            scheduleFrame()
          }
        }
        return
      }
      var profile = targetForEvent(event)
      if (!profile) {
        if (hovered) leaveElement(hovered.element)
        return
      }
      var state = hovered && hovered.element === profile.element ? hovered : startHover(profile, event)
      if (!state) return
      setPointerTarget(state, event)
      setTargetScale(state)
      scheduleFrame()
    }

    function onPointerOut(event) {
      if (disposed || !pointerIsMouse(event, finePointer) || reducedMotion) return
      var profile = targetForEvent(event)
      var related = relatedProfile(event)
      if (profile && (!related || related.element !== profile.element)) leaveElement(profile.element)
      else if (!profile && !related && hovered) leaveElement(hovered.element)
    }

    // Window capture runs before the battle page's document-capture drag
    // handler, so its geometry never observes a decorative rotation.
    function onPointerDown(event) {
      if (disposed) return
      resetMotion()
      if (!pointerIsMouse(event, finePointer) || reducedMotion) return
      var profile = targetForEvent(event)
      if (!profile) return
      var state = stateFor(profile)
      if (!state) return
      state.hovering = true
      state.pressed = true
      state.dragging = false
      // A press must expose a neutral decorative geometry to the page's
      // document-capture drag code. Re-enter the hover target on pointerup.
      state.target.x = 0
      state.target.y = 0
      setTargetScale(state)
      state.current.x = 0
      state.current.y = 0
      state.current.scale = PRESS_SCALE
      state.velocity.x = 0
      state.velocity.y = 0
      state.velocity.scale = 0
      writeAnimation(state)
      hovered = state
      activePointer = {
        pointerId: event && event.pointerId,
        startX: pointFromEvent(event).x,
        startY: pointFromEvent(event).y,
        state: state,
        dragging: false,
      }
      scheduleFrame()
    }

    function onPointerEnd(event) {
      if (disposed || !activePointer) return
      if (event && event.pointerId != null && activePointer.pointerId != null && event.pointerId !== activePointer.pointerId) return
      var state = activePointer.state
      var wasDragging = activePointer.dragging
      var releasedProfile = event ? targetForEvent(event) : null
      var stillOverState = !!(state && state.hovering && releasedProfile && releasedProfile.element === state.element)
      activePointer = null
      if (!state) return
      state.pressed = false
      state.dragging = wasDragging
      if (wasDragging || !stillOverState) {
        state.hovering = false
        state.target.x = 0
        state.target.y = 0
      } else {
        state.hovering = true
        if (event) setPointerTarget(state, event)
      }
      setTargetScale(state)
      scheduleFrame()
    }

    function onPointerCancel() { resetMotion() }

    function step(now) {
      frameId = null
      if (disposed || reducedMotion) return
      pruneStates()
      if (!states.size) return
      var timestamp = Number(now)
      if (!Number.isFinite(timestamp)) timestamp = Date.now()
      var dt = lastFrameTime ? clamp((timestamp - lastFrameTime) / 1000, 0, MAX_FRAME_SECONDS) : FRAME_MS / 1000
      if (!(dt > 0)) dt = FRAME_MS / 1000
      lastFrameTime = timestamp
      var needsFrame = false
      states.forEach(function (state) {
        if (!isDescendant(rootElement, state.element)) {
          removeState(state)
          return
        }
        var dx = state.target.x - state.current.x
        var dy = state.target.y - state.current.y
        var ds = state.target.scale - state.current.scale
        state.velocity.x += dx * STIFFNESS * dt
        state.velocity.y += dy * STIFFNESS * dt
        state.velocity.scale += ds * STIFFNESS * dt
        var damping = Math.exp(-DAMPING * dt)
        state.velocity.x *= damping
        state.velocity.y *= damping
        state.velocity.scale *= damping
        state.current.x += state.velocity.x * dt
        state.current.y += state.velocity.y * dt
        state.current.scale += state.velocity.scale * dt
        if (Math.abs(dx) < ANGLE_EPSILON && Math.abs(dy) < ANGLE_EPSILON && Math.abs(ds) < SCALE_EPSILON
          && Math.abs(state.velocity.x) < VELOCITY_EPSILON && Math.abs(state.velocity.y) < VELOCITY_EPSILON && Math.abs(state.velocity.scale) < VELOCITY_EPSILON) {
          state.current.x = state.target.x
          state.current.y = state.target.y
          state.current.scale = state.target.scale
          state.velocity.x = 0
          state.velocity.y = 0
          state.velocity.scale = 0
        }
        var settled = Math.abs(state.target.x - state.current.x) < ANGLE_EPSILON
          && Math.abs(state.target.y - state.current.y) < ANGLE_EPSILON
          && Math.abs(state.target.scale - state.current.scale) < SCALE_EPSILON
          && Math.abs(state.velocity.x) < VELOCITY_EPSILON
          && Math.abs(state.velocity.y) < VELOCITY_EPSILON
          && Math.abs(state.velocity.scale) < VELOCITY_EPSILON
        if (settled && !state.hovering && !state.pressed) {
          removeState(state)
          return
        }
        if (!writeAnimation(state)) {
          removeState(state)
          return
        }
        if (!settled) needsFrame = true
      })
      if (needsFrame) scheduleFrame()
    }

    function onBlur() { resetMotion() }
    function onPageHide() { resetMotion() }
    function onVisibilityChange() { resetMotion() }
    function onFineChange(event) {
      finePointer = !!(event && event.matches)
      setRootCapability()
      if (!finePointer) resetMotion()
    }
    function onReducedChange(event) {
      reducedMotion = !!(event && event.matches)
      if (reducedMotion) resetMotion()
    }

    function onMutation() { pruneStates() }

    setRootCapability()
    // Window capture is intentional; document-capture drag handlers are
    // installed by inline battle code before this deferred script executes.
    listen(windowRef, 'pointerdown', onPointerDown, true)
    listen(windowRef, 'pointerover', onPointerOver, true)
    listen(windowRef, 'pointermove', onPointerMove, true)
    listen(windowRef, 'pointerout', onPointerOut, true)
    listen(windowRef, 'pointerup', onPointerEnd, true)
    listen(windowRef, 'pointercancel', onPointerCancel, true)
    listen(windowRef, 'blur', onBlur)
    listen(windowRef, 'pagehide', onPageHide)
    listen(documentRef, 'visibilitychange', onVisibilityChange)

    if (fineMedia) {
      if (typeof fineMedia.addEventListener === 'function') fineMedia.addEventListener('change', onFineChange)
      else if (typeof fineMedia.addListener === 'function') fineMedia.addListener(onFineChange)
    }
    if (reducedMedia) {
      if (typeof reducedMedia.addEventListener === 'function') reducedMedia.addEventListener('change', onReducedChange)
      else if (typeof reducedMedia.addListener === 'function') reducedMedia.addListener(onReducedChange)
    }
    if (windowRef && typeof windowRef.MutationObserver === 'function') {
      try {
        mutationObserver = new windowRef.MutationObserver(onMutation)
        mutationObserver.observe(rootElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'disabled', 'aria-disabled', 'aria-hidden', 'inert', 'data-disabled', 'data-motion-disabled', 'data-ui-motion', 'data-targeting', 'data-dragging', 'data-active-drag', 'hidden'],
        })
      } catch { mutationObserver = null }
    }

    function destroy() {
      if (disposed) return
      disposed = true
      resetMotion()
      unlisten(windowRef, 'pointerdown', onPointerDown, true)
      unlisten(windowRef, 'pointerover', onPointerOver, true)
      unlisten(windowRef, 'pointermove', onPointerMove, true)
      unlisten(windowRef, 'pointerout', onPointerOut, true)
      unlisten(windowRef, 'pointerup', onPointerEnd, true)
      unlisten(windowRef, 'pointercancel', onPointerCancel, true)
      unlisten(windowRef, 'blur', onBlur)
      unlisten(windowRef, 'pagehide', onPageHide)
      unlisten(documentRef, 'visibilitychange', onVisibilityChange)
      if (fineMedia) {
        if (typeof fineMedia.removeEventListener === 'function') fineMedia.removeEventListener('change', onFineChange)
        else if (typeof fineMedia.removeListener === 'function') fineMedia.removeListener(onFineChange)
      }
      if (reducedMedia) {
        if (typeof reducedMedia.removeEventListener === 'function') reducedMedia.removeEventListener('change', onReducedChange)
        else if (typeof reducedMedia.removeListener === 'function') reducedMedia.removeListener(onReducedChange)
      }
      if (mutationObserver && typeof mutationObserver.disconnect === 'function') mutationObserver.disconnect()
      addedClasses.forEach(function (name) { removeClass(rootElement, name) })
      addedClasses = []
      if (windowRef && windowRef.__UiMotionInstance && windowRef.__UiMotionInstance.destroy === destroy) delete windowRef.__UiMotionInstance
    }

    var instance = { document: documentRef, destroy: destroy, dispose: destroy, cancel: resetMotion }
    if (windowRef && !windowRef.__UiMotionInstance) windowRef.__UiMotionInstance = instance
    return instance
  }

  function autoInit(windowRef) {
    var owner = windowRef || globalRoot
    var documentRef = owner && owner.document
    if (!documentRef || !owner) return null
    if (owner.__UiMotionInstance && typeof owner.__UiMotionInstance.destroy === 'function') return owner.__UiMotionInstance
    if (owner.__UiMotionPending) return null
    var initialize = function () {
      owner.__UiMotionPending = false
      if (!owner.__UiMotionInstance) create({ document: documentRef, window: owner })
    }
    if (documentRef.readyState === 'loading') {
      owner.__UiMotionPending = true
      listen(documentRef, 'DOMContentLoaded', initialize, { once: true })
    } else initialize()
    return owner.__UiMotionInstance || null
  }

  return { create: create, autoInit: autoInit, profiles: PROFILE_RULES }
})
