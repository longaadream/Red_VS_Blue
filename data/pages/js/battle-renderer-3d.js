;(function () {
  'use strict'

  // ── Requires THREE and the presentation-only tactical geometry helper ───────
  const TacticalGeometry = window.BattleTacticalGeometry
  if (!TacticalGeometry) throw new Error('BattleRenderer3D requires BattleTacticalGeometry')
  const TACTICAL_METRICS = TacticalGeometry.METRICS

  // ── Constants ────────────────────────────────────────────────────────────────
  const TILE_H = 0.12
  const TILE_W = 0.92
  const BOARD_BASE_H = TACTICAL_METRICS.boardBaseHeight
  const PIECE_W = TACTICAL_METRICS.pieceWidth
  const PIECE_D = TACTICAL_METRICS.pieceDepth
  const PIECE_H = TACTICAL_METRICS.pieceHeight
  const PIECE_PORTRAIT_W = 0.66
  const PIECE_PORTRAIT_D = 0.50
  const RING_T = 0.035
  const SELECTED_RING_T = 0.018
  const PAN_ACTIVATION_PX = TACTICAL_METRICS.panActivationPx
  const MIN_TOUCH_CELL_PIXELS = TACTICAL_METRICS.minTouchCellPixels
  const MAX_CAMERA_ZOOM = 8
  const MOTION_TOKENS = Object.freeze({
    press: 100,
    fast: 140,
    action: 240,
    result: 280,
    reject: 160,
    hit: 150,
    heal: 180,
    easeOut: Object.freeze([0.22, 1, 0.36, 1]),
    easeIn: Object.freeze([0.4, 0, 1, 1]),
    easeInOut: Object.freeze([0.65, 0, 0.35, 1]),
  })
  const MOTION_SECONDS = Object.freeze(Object.fromEntries(
    Object.entries(MOTION_TOKENS).filter((entry) => typeof entry[1] === 'number').map((entry) => [entry[0], entry[1] / 1000])
  ))
  const TILE_HEIGHTS = Object.freeze({
    floor: TILE_H,
    spawn: TILE_H + 0.035,
    spring: TILE_H + 0.055,
    chargepad: TILE_H + 0.055,
    trap: TILE_H + 0.075,
    cover: 0.30,
    wall: 0.52,
    hole: 0.035,
    lava: 0.08,
  })

  const TILE_COLORS = {
    floor:     0x252a30,
    wall:      0x0c1015,
    spawn:     0x173127,
    cover:     0x4b3a26,
    hole:      0x07131c,
    lava:      0x6b2418,
    spring:    0x17413d,
    chargepad: 0x34244c,
    trap:      0x4a3020,
  }
  const TILE_EMISSIVE = {
    lava:      { color: 0xff4400, intensity: 0.35 },
    chargepad: { color: 0x8800ff, intensity: 0.25 },
    spring:    { color: 0x00ffcc, intensity: 0.15 },
  }
  const FACTION_COLORS = { red: 0xef4444, blue: 0x3b82f6 }
  const HL_COLORS = {
    move:     { color: 0x22c55e, opacity: 0.50 },
    skill:    { color: 0xf59e0b, opacity: 0.50 },
    place:    { color: 0x8b5cf6, opacity: 0.50 },
    selected: { color: 0x60a5fa, opacity: 0.70 },
  }
  const TILE_EFFECT_VISUALS = Object.freeze({
    'charge-crystal': Object.freeze({ color: 0xc084fc, colorCss: '#e9d5ff', bg: 'rgba(88,28,135,.82)', border: '#c084fc', icon: 'images/effect-icons/verb-charge-points.svg' }),
    'flying-raijin-anchor': Object.freeze({ color: 0x38bdf8, colorCss: '#7dd3fc', bg: 'rgba(8,47,73,.78)', border: '#38bdf8', icon: 'images/tile-effects/flying-raijin-anchor.svg' }),
    'shadow-step': Object.freeze({ color: 0xa855f7, colorCss: '#d8b4fe', bg: 'rgba(88,28,135,.72)', border: '#a855f7', icon: 'images/tile-effects/shadow-step.svg' }),
    'lethal-toxin': Object.freeze({ color: 0x4ade80, colorCss: '#86efac', bg: 'rgba(20,83,45,.76)', border: '#4ade80', icon: 'images/tile-effects/lethal-toxin.svg' }),
    'amaterasu': Object.freeze({ color: 0xf97316, colorCss: '#fdba74', bg: 'rgba(127,29,29,.72)', border: '#fb923c', icon: 'images/tile-effects/amaterasu.svg' }),
    'blizzard': Object.freeze({ color: 0x67e8f9, colorCss: '#cffafe', bg: 'rgba(14,116,144,.72)', border: '#67e8f9', icon: 'images/tile-effects/blizzard.svg' }),
    'shishio-burn': Object.freeze({ color: 0xfb4934, colorCss: '#fdba74', bg: 'rgba(124,45,18,.75)', border: '#fb4934', icon: 'images/tile-effects/shishio-burn.svg' }),
    'sticky-bomb': Object.freeze({ color: 0xfacc15, colorCss: '#fef08a', bg: 'rgba(113,63,18,.78)', border: '#facc15', icon: 'images/tile-effects/sticky-bomb.svg' }),
    'tails-flight-reservation': Object.freeze({ color: 0x60a5fa, colorCss: '#bfdbfe', bg: 'rgba(30,58,138,.78)', border: '#60a5fa', icon: 'images/tile-effects/flying-raijin-anchor.svg' }),
    fallback: Object.freeze({ color: 0x94a3b8, colorCss: '#e5e7eb', bg: 'rgba(15,23,42,.76)', border: '#94a3b8', icon: 'images/tile-effects/fallback.svg' }),
  })
  const TILE_EFFECT_ICON_SLOTS = Object.freeze([
    Object.freeze({ x: -0.29, z: -0.29 }),
    Object.freeze({ x: 0.29, z: -0.29 }),
    Object.freeze({ x: -0.29, z: 0.29 }),
    Object.freeze({ x: 0.29, z: 0.29 }),
  ])

  // ── State ────────────────────────────────────────────────────────────────────
  let _renderer, _camera, _scene, _animFrameId
  let _cameraTarget = null
  let _container = null
  let _hpLayer = null
  let _floatLayer = null
  let _onIntent = null
  function _notifyViewportChange() {
    _summaryPositionsDirty = true
    _invalidate()
    if (_onIntent) _onIntent({ type: 'viewport-change' })
  }
  let _resizeObserver = null
  let _hitPlane = null
  let _mounted = false
  const _listeners = []

  let _mapW = 0, _mapH = 0
  let _boardBase = null
  let _boardFront = null
  const _tileObjects = new Map()       // "x,z" → { surfaceY, type }
  const _tileBatches = new Map()       // terrain type → THREE.InstancedMesh
  const _pieceObjects = new Map()      // instanceId → {group, body, ring, portraitMesh, labelDiv, targetX, targetZ}
  const _tileEffectObjects = new Map()
  const _hlObjects = { move: new Map(), skill: new Map(), place: new Map(), selected: null, selectedId: null }
  let _historyHighlightGroup = null
  let _historyHighlightPointCount = 0
  let _historyHighlightPathCount = 0
  let _tutorialCueGroup = null
  let _tutorialCueCellCount = 0
  let _tutorialCuePathCount = 0
  const _anims = new Map()             // one controller per owner/property
  const _playedEventKeys = new Set()
  const _playedEventOrder = []
  const _pendingAppearanceCues = new Map()
  let _presentationAreaFlash = null
  let _presentationPath = null
  const _texCache = new Map()
  let _textureLoadGeneration = 0
  const _floaters = new Set()
  const _floaterTimers = new Set()
  let _pressedPiece = null
  let _pressedHighlight = null
  let _reducedMotion = false
  let _motionQuery = null
  let _currentModel = null
  let _clock = { prev: 0 }
  let _summaryPositionsDirty = true
  let _renderCount = 0
  let _lastDrawCalls = 0

  // ── Geometry / Material cache (shared across all tiles/pieces) ────────────────
  let _tileGeom = null
  let _hlPlaneGeom = null
  let _selectedRingGeom = null
  let _pieceBodyGeom = null
  let _pieceRingGeom = null
  let _portraitDiscGeom = null
  let _contactShadowGeom = null
  let _contactShadowMat = null
  const _tileMats = {}
  const _factionMats = {}
  const _hlMats = {}
  const _tileEffectMats = {}
  const _tileEffectIconMats = {}

  function getTileMat(type) {
    if (_tileMats[type]) return _tileMats[type]
    const col = TILE_COLORS[type] || TILE_COLORS.floor
    const em  = TILE_EMISSIVE[type]
    const mat = new THREE.MeshLambertMaterial({ color: col })
    if (em) { mat.emissive = new THREE.Color(em.color); mat.emissiveIntensity = em.intensity }
    _tileMats[type] = mat
    return mat
  }

  function getFactionMat(faction) {
    if (_factionMats[faction]) return _factionMats[faction]
    const col = FACTION_COLORS[faction] || FACTION_COLORS.red
    const mat = new THREE.MeshLambertMaterial({ color: col, emissive: new THREE.Color(col), emissiveIntensity: 0.3 })
    _factionMats[faction] = mat
    return mat
  }

  function getHlMat(type) {
    if (_hlMats[type]) return _hlMats[type]
    const cfg = HL_COLORS[type] || HL_COLORS.move
    const mat = new THREE.MeshBasicMaterial({ color: cfg.color, transparent: true, opacity: cfg.opacity, depthWrite: false })
    _hlMats[type] = mat
    return mat
  }

  function getTileEffectMat(tileType) {
    const key = TILE_EFFECT_VISUALS[tileType] ? tileType : 'fallback'
    if (_tileEffectMats[key]) return _tileEffectMats[key]
    const color = TILE_EFFECT_VISUALS[key].color
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.82, depthWrite: false })
    _tileEffectMats[key] = mat
    return mat
  }

  function getTileEffectIconMat(tileType) {
    const key = TILE_EFFECT_VISUALS[tileType] ? tileType : 'fallback'
    if (_tileEffectIconMats[key]) return _tileEffectIconMats[key]
    const visual = TILE_EFFECT_VISUALS[key]
    const mat = new THREE.SpriteMaterial({
      color: visual.color,
      transparent: true,
      opacity: 0.86,
      alphaTest: 0.05,
      depthWrite: false,
    })
    _tileEffectIconMats[key] = mat
    loadTexture(visual.icon, function (texture) {
      if (_tileEffectIconMats[key] !== mat) return
      mat.map = texture
      mat.color.setHex(0xffffff)
      mat.opacity = 1
      mat.needsUpdate = true
    }, function (error) {
      console.error('[battle-renderer] Failed to load tile effect icon', { tileType: key, icon: visual.icon }, error)
    })
    return mat
  }

  // ── Texture loading ───────────────────────────────────────────────────────────
  function loadTexture(url, onLoad, onError) {
    if (_texCache.has(url)) {
      const entry = _texCache.get(url)
      if (entry.status === 'loaded') {
        onLoad(entry.texture)
      } else {
        entry.loadCallbacks.push(onLoad)
        entry.errorCallbacks.push(onError)
      }
      return
    }

    const loadGeneration = _textureLoadGeneration
    const entry = {
      texture: null,
      status: 'loading',
      loadCallbacks: [onLoad],
      errorCallbacks: [onError],
    }
    _texCache.set(url, entry)

    const loader = new THREE.TextureLoader()
    const texture = loader.load(url, loadedTexture => {
      const resolvedTexture = loadedTexture || texture
      const current = _texCache.get(url)
      if (!_mounted || loadGeneration !== _textureLoadGeneration || current !== entry) {
        if (resolvedTexture && typeof resolvedTexture.dispose === 'function') resolvedTexture.dispose()
        return
      }

      resolvedTexture.colorSpace = THREE.SRGBColorSpace || 'srgb'
      entry.texture = resolvedTexture
      entry.status = 'loaded'
      const callbacks = entry.loadCallbacks.splice(0)
      entry.errorCallbacks.length = 0
      callbacks.forEach(callback => callback(resolvedTexture))
      _summaryPositionsDirty = true
      _invalidate()
    }, undefined, error => {
      const current = _texCache.get(url)
      if (current === entry) _texCache.delete(url)
      if (entry.texture && typeof entry.texture.dispose === 'function') entry.texture.dispose()
      if (!_mounted || loadGeneration !== _textureLoadGeneration || current !== entry) return

      const callbacks = entry.errorCallbacks.splice(0)
      entry.loadCallbacks.length = 0
      callbacks.forEach(callback => callback(error))
    })
    texture.colorSpace = THREE.SRGBColorSpace || 'srgb'
    entry.texture = texture
  }

  function portraitUrl(portraitRef) {
    const ref = String(portraitRef || '').replace(/^images\//, '')
    if (!ref) return ''
    const fileName = /\.[a-z0-9]+$/i.test(ref)
      ? ref
      : ref.replace(/^(red|blue)-/, '') + '.jpg'
    return 'images/' + fileName
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  function init(options) {
    const input = options || {}
    if (_mounted || _renderer || _container) dispose()
    if (!input.container) throw new Error('BattleRenderer3D.init requires a container')
    _container = input.container
    _floatLayer = input.floatLayer || null
    _onIntent = typeof input.onIntent === 'function' ? input.onIntent : null
    _textureLoadGeneration += 1
    _mounted = true

    // Shared geometries. Piece geometry stays unit-sized so the oval metrics are
    // explicit and identical for portrait, faction ring, and touch projection.
    _tileGeom = new THREE.BoxGeometry(TILE_W, 1, TILE_W)
    _hlPlaneGeom = new THREE.PlaneGeometry(TILE_W - 0.06, TILE_W - 0.06)
    _selectedRingGeom = new THREE.TorusGeometry(0.5, SELECTED_RING_T, 8, 32)
    _pieceBodyGeom = new THREE.CylinderGeometry(0.5, 0.5, PIECE_H, 32)
    _pieceRingGeom = new THREE.TorusGeometry(0.5, RING_T, 8, 32)
    _portraitDiscGeom = new THREE.CircleGeometry(0.5, 32)
    _contactShadowGeom = new THREE.CircleGeometry(0.5, 32)
    _contactShadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.30, depthWrite: false })

    // Scene and table lighting use dark neutral metal; faction color is reserved
    // for the narrow base ring and the existing authoritative highlight layers.
    _scene = new THREE.Scene()
    _scene.background = new THREE.Color(0x07090b)

    const ambient = new THREE.AmbientLight(0xdbe4ee, 0.48)
    _scene.add(ambient)
    const dirLight = new THREE.DirectionalLight(0xfff1dc, 0.72)
    dirLight.position.set(-7, 13, 10)
    _scene.add(dirLight)
    const edgeLight = new THREE.DirectionalLight(0x7ba3c9, 0.24)
    edgeLight.position.set(10, 5, -8)
    _scene.add(edgeLight)

    // Renderer
    _renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    _container.insertBefore(_renderer.domElement, _container.firstChild)
    _renderer.domElement.tabIndex = 0
    _renderer.domElement.setAttribute('role', 'application')
    _renderer.domElement.setAttribute('aria-label', '20 × 16 战术棋盘，可拖动平移、滚轮或双指缩放')

    // Compact piece summary overlay (absolute over canvas)
    _hpLayer = document.createElement('div')
    _hpLayer.id = 'hpBarLayer3d'
    _hpLayer.className = 'piece-summary-layer-3d'
    _hpLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden'
    _container.appendChild(_hpLayer)

    // Fixed tactical perspective camera. It stays centered on the board's X axis,
    // so depth converges into trapezoids without introducing any horizontal yaw.
    _camera = new THREE.PerspectiveCamera(TACTICAL_METRICS.cameraFovDeg, 1, 0.1, 200)
    _cameraTarget = new THREE.Vector3(0, 0, 0)
    _camera.up.set(0, 1, 0)

    // Pointer events on canvas
    _motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    _reducedMotion = !!(_motionQuery && _motionQuery.matches)
    if (_motionQuery && typeof _motionQuery.addEventListener === 'function') {
      _listen(_motionQuery, 'change', function (event) {
        _reducedMotion = !!event.matches
        if (_reducedMotion) {
          _releasePressedFeedback()
          _finishSpatialAnimations()
        }
      })
    }
    _initControls()

    // Resize observer
    _resizeObserver = new ResizeObserver(function () { resize() })
    _resizeObserver.observe(_container)

    // Render once, then sleep until state, viewport, texture, or motion changes.
    _clock.prev = 0
    _summaryPositionsDirty = true
    _invalidate()
  }

  // ── Resize ───────────────────────────────────────────────────────────────────
  function resize() {
    if (!_renderer || !_container) return
    const w = _container.clientWidth || 320
    const h = _container.clientHeight || 320
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    _renderer.setSize(w, h, false)
    _updateCameraProjection(w, h)
    if (_mapW && _camera) {
      _camera.zoom = Math.max(_camera.zoom, _minimumUsableZoom(w, h))
      _camera.updateProjectionMatrix()
    }
    _notifyViewportChange()
  }

  function _withCameraZoomOne(callback) {
    const previousZoom = _camera.zoom
    _camera.zoom = 1
    _camera.updateProjectionMatrix()
    _camera.updateMatrixWorld(true)
    const result = callback()
    _camera.zoom = previousZoom
    _camera.updateProjectionMatrix()
    return result
  }

  function _projectToCss(point, w, h) {
    const projected = point.clone().project(_camera)
    return {
      x: (projected.x + 1) * 0.5 * w,
      y: (1 - projected.y) * 0.5 * h,
    }
  }

  function _minimumUsableZoom(w, h) {
    if (!_mapW) return 1
    const touchViewport = w <= 760 || (w > h && h <= 500)
    const coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches
    if (!touchViewport && !coarsePointer) return 1
    const minimumAxisAtZoomOne = _withCameraZoomOne(function () {
      let minimum = Infinity
      ;[0, (_mapW - 1) / 2, _mapW - 2].forEach(function (x) {
        const origin = _projectToCss(new THREE.Vector3(x, TILE_H, 0), w, h)
        const across = _projectToCss(new THREE.Vector3(x + 1, TILE_H, 0), w, h)
        const depth = _projectToCss(new THREE.Vector3(x, TILE_H, 1), w, h)
        minimum = Math.min(
          minimum,
          Math.hypot(across.x - origin.x, across.y - origin.y),
          Math.hypot(depth.x - origin.x, depth.y - origin.y),
        )
      })
      return minimum
    })
    // Keep one CSS pixel of headroom for fractional viewport sizes and the
    // perspective edge samples that fall between our representative columns.
    const requiredZoom = (MIN_TOUCH_CELL_PIXELS + 1) / Math.max(1, minimumAxisAtZoomOne)
    return Math.max(1, Math.min(MAX_CAMERA_ZOOM, requiredZoom))
  }

  function _preferredInitialZoom(w, h) {
    if (!_mapW) return 1
    const halfWidth = (_mapW + 1.25) / 2
    const centerX = (_mapW - 1) / 2
    const farZ = -1.125
    const nearZ = _mapH + 0.16
    const fitZoom = _withCameraZoomOne(function () {
      let maxX = 0
      let maxY = 0
      ;[-BOARD_BASE_H, TILE_HEIGHTS.wall + 0.08].forEach(function (height) {
        ;[centerX - halfWidth, centerX + halfWidth].forEach(function (x) {
          ;[farZ, nearZ].forEach(function (z) {
            const projected = new THREE.Vector3(x, height, z).project(_camera)
            maxX = Math.max(maxX, Math.abs(projected.x))
            maxY = Math.max(maxY, Math.abs(projected.y))
          })
        })
      })
      return Math.min(0.90 / Math.max(0.001, maxX), 0.90 / Math.max(0.001, maxY))
    })
    const widthCoverageZoom = fitZoom
    return Math.max(_minimumUsableZoom(w, h), Math.min(4, widthCoverageZoom))
  }

  function _positionCameraFromTarget() {
    if (!_camera || !_cameraTarget || !_mapW) return
    const pose = TacticalGeometry.cameraPose({ mapWidth: _mapW, mapHeight: _mapH })
    const offsetX = pose.position.x - pose.target.x
    const offsetY = pose.position.y - pose.target.y
    const offsetZ = pose.position.z - pose.target.z
    _camera.position.set(_cameraTarget.x + offsetX, offsetY, _cameraTarget.z + offsetZ)
    _camera.lookAt(_cameraTarget.x, _cameraTarget.y, _cameraTarget.z)
    _camera.updateMatrixWorld(true)
  }

  function _tileSurfaceHeightAt(x, z) {
    const tile = _tileObjects.get(Math.round(x) + ',' + Math.round(z))
    return tile && Number.isFinite(tile.surfaceY) ? tile.surfaceY : TILE_H
  }

  function _updateCameraProjection(w, h) {
    if (!_camera || !_mapW) return
    _camera.aspect = w / (h || 1)
    _camera.updateProjectionMatrix()
    // Retain target-plane bounds for gesture diagnostics and a safe pan
    // fallback if a future camera pose makes the center ray parallel to y=0.
    const targetDistance = _camera.position.distanceTo(_cameraTarget)
    const halfHeightAtTarget = Math.tan(_camera.fov * Math.PI / 360) * targetDistance
    _camera.left = -halfHeightAtTarget * _camera.aspect
    _camera.right = halfHeightAtTarget * _camera.aspect
    _camera.top = halfHeightAtTarget
    _camera.bottom = -halfHeightAtTarget
  }

  // ── Demand-driven render scheduling ───────────────────────────────────────────
  function _invalidate() {
    if (!_mounted || !_renderer || _animFrameId != null) return
    _clock.prev = 0
    _animFrameId = requestAnimationFrame(_tick)
  }

  function _tick(now) {
    if (!_mounted || !_renderer || !_scene || !_camera) return
    _animFrameId = null
    const dt = _clock.prev
      ? Math.min((now - _clock.prev) / 1000, 0.1)
      : (_anims.size > 0 ? 1 / 60 : 0)
    _clock.prev = now
    _stepAnims(dt)
    _pulseLava(now / 1000)
    if (_summaryPositionsDirty) {
      _updatePieceSummaryPositions()
      _summaryPositionsDirty = false
    }
    _renderer.render(_scene, _camera)
    _renderCount += 1
    _lastDrawCalls = _renderer.info && _renderer.info.render ? _renderer.info.render.calls : 0
    if (_anims.size > 0 && _animFrameId == null) _animFrameId = requestAnimationFrame(_tick)
  }

  function _pulseLava(t) {
    const mat = _tileMats['lava']
    if (mat) mat.emissiveIntensity = 0.30 + Math.sin(t * 2.3) * 0.15
    const cmat = _tileMats['chargepad']
    if (cmat) cmat.emissiveIntensity = 0.20 + Math.sin(t * 1.7) * 0.10
  }

  // ── Tile map ─────────────────────────────────────────────────────────────────
  function _buildTiles(map) {
    _clearPresentationAreaFlash()
    _clearPresentationPath()
    _tileBatches.forEach(batch => _scene.remove(batch))
    _tileBatches.clear()
    _tileObjects.clear()
    if (_boardFront) {
      _scene.remove(_boardFront)
      if (_boardFront.geometry) _boardFront.geometry.dispose()
      if (_boardFront.material) _boardFront.material.dispose()
      _boardFront = null
    }
    if (_boardBase) {
      _scene.remove(_boardBase)
      if (_boardBase.geometry) _boardBase.geometry.dispose()
      if (_boardBase.material) _boardBase.material.dispose()
      _boardBase = null
    }

    _mapW = map.width
    _mapH = map.height

    const boardBaseGeometry = new THREE.BoxGeometry(_mapW + 1.25, BOARD_BASE_H, _mapH + 1.25)
    const boardBaseMaterial = new THREE.MeshLambertMaterial({ color: 0x20272e })
    _boardBase = new THREE.Mesh(boardBaseGeometry, boardBaseMaterial)
    _boardBase.position.set((_mapW - 1) / 2, -BOARD_BASE_H / 2, (_mapH - 1) / 2)
    const boardFrontGeometry = new THREE.BoxGeometry(_mapW + 1.25, BOARD_BASE_H, 0.10)
    const boardFrontMaterial = new THREE.MeshLambertMaterial({ color: 0x37414b })
    _boardFront = new THREE.Mesh(boardFrontGeometry, boardFrontMaterial)
    _boardFront.position.set((_mapW - 1) / 2, -BOARD_BASE_H / 2, _mapH + 0.105)
    _scene.add(_boardFront)

    _scene.add(_boardBase)

    const tilesByType = new Map()
    map.tiles.forEach(tile => {
      const type = (tile.props && tile.props.type) ? tile.props.type : (tile.type || 'floor')
      const tileHeight = TILE_HEIGHTS[type] || TILE_H
      if (!tilesByType.has(type)) tilesByType.set(type, [])
      tilesByType.get(type).push({ x: tile.x, y: tile.y, surfaceY: tileHeight })
      _tileObjects.set(tile.x + ',' + tile.y, { surfaceY: tileHeight, type: type })
    })
    tilesByType.forEach(function (tiles, type) {
      const batch = new THREE.InstancedMesh(_tileGeom, getTileMat(type), tiles.length)
      const transform = new THREE.Object3D()
      tiles.forEach(function (tile, index) {
        transform.position.set(tile.x, tile.surfaceY / 2, tile.y)
        transform.scale.set(1, tile.surfaceY, 1)
        transform.updateMatrix()
        batch.setMatrixAt(index, transform.matrix)
      })
      if (batch.instanceMatrix && THREE.StaticDrawUsage != null) batch.instanceMatrix.setUsage(THREE.StaticDrawUsage)
      batch.userData.cells = tiles
      if (batch.computeBoundingSphere) batch.computeBoundingSphere()
      _scene.add(batch)
      _tileBatches.set(type, batch)
    })

    const pose = TacticalGeometry.cameraPose({ mapWidth: _mapW, mapHeight: _mapH })
    _cameraTarget.set(pose.target.x, pose.target.y, pose.target.z)
    _positionCameraFromTarget()
    _updateCameraProjection(_container.clientWidth || 320, _container.clientHeight || 320)
    _camera.zoom = _preferredInitialZoom(_container.clientWidth || 320, _container.clientHeight || 320)

    // The interaction plane remains a flat board-sized plane. It owns no rules;
    // rounding and bounds checks stay in screenToCell().
    // Perspective rays from elevated far-edge tiles land slightly beyond the
    // outer half-cell, so the invisible surface includes one cell of padding.
    if (_hitPlane) {
      _scene.remove(_hitPlane)
      if (_hitPlane.geometry) _hitPlane.geometry.dispose()
      if (_hitPlane.material) _hitPlane.material.dispose()
    }
    const hitGeom = new THREE.PlaneGeometry(_mapW + 2, _mapH + 2)
    const hitMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
    const hitPlane = new THREE.Mesh(hitGeom, hitMat)
    hitPlane.rotation.x = -Math.PI / 2
    hitPlane.position.set((_mapW - 1) / 2, TILE_H + 0.01, (_mapH - 1) / 2)
    _scene.add(hitPlane)
    _hitPlane = hitPlane

    resize()
  }

  // ── Pieces ───────────────────────────────────────────────────────────────────
  function _updatePieces(pieces) {
    const seen = new Set()

    pieces.forEach(piece => {
      if (piece.x == null || piece.y == null) return
      seen.add(piece.id)

      if (!_pieceObjects.has(piece.id)) {
        _spawnPieceMesh(piece)
      }

      const obj = _pieceObjects.get(piece.id)
      if (!obj) return

      obj.baseX = piece.x
      obj.baseY = _tileSurfaceHeightAt(piece.x, piece.y)
      obj.baseZ = piece.y
      if (!_anims.has(obj.motionId + ':position')) {
        obj.motionBaseY = obj.baseY
        obj.group.position.set(
          obj.baseX,
          obj.baseY + (obj.pending && !_reducedMotion ? 0.04 : 0),
          obj.baseZ,
        )
      }

      if (piece.visible !== false && obj.deathAnimating) {
        _cancelAnimation(obj.motionId + ':visibility')
        obj.deathAnimating = false
        obj.group.visible = true
        _restorePieceVisual(obj)
      }

      // Faction is snapshot-driven and can change without respawning the mesh.
      if (obj.faction !== piece.faction) {
        obj.faction = piece.faction
        const markerPattern = TacticalGeometry.factionMarkerPattern(piece.faction)
        obj.body.material.emissive.setHex(FACTION_COLORS[piece.faction] || FACTION_COLORS.red)
        if (obj.ring.material && obj.ring.material.dispose) obj.ring.material.dispose()
        obj.ring.material = getFactionMat(piece.faction).clone()
        obj.factionMarkers.forEach(function (marker, index) {
          marker.visible = markerPattern[index]
        })
      }

      // Portrait texture comes from the template-declared asset and only becomes
      // complete after TextureLoader succeeds. A failed training placement can
      // therefore retry on the next authoritative snapshot.
      const portraitSrc = portraitUrl(piece.portraitId)
      if (obj.portraitSrc !== portraitSrc) {
        obj.portraitSrc = portraitSrc
        obj.portraitLoaded = false
        obj.portraitLoading = false
      }
      if (!obj.portraitLoaded && !obj.portraitLoading && portraitSrc) {
        const pieceId = piece.id
        obj.portraitLoading = true
        loadTexture(portraitSrc, texture => {
          const liveObject = _pieceObjects.get(pieceId)
          if (liveObject !== obj || liveObject.portraitSrc !== portraitSrc) return
          if (obj.portraitMesh.material && obj.portraitMesh.material.dispose) obj.portraitMesh.material.dispose()
          obj.portraitMesh.material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.FrontSide })
          obj.portraitLoaded = true
          obj.portraitLoading = false
        }, error => {
          const liveObject = _pieceObjects.get(pieceId)
          if (liveObject === obj && liveObject.portraitSrc === portraitSrc) {
            obj.portraitLoaded = false
            obj.portraitLoading = false
          }
          console.error('[battle-renderer] Failed to load piece portrait', {
            pieceId: pieceId,
            portraitSrc: portraitSrc,
          }, error)
        })
      }

      // Update the snapshot-driven piece summary.
      _updatePieceSummary(obj, piece)

      // Death feedback owns visibility until its authoritative result transition ends.
      if (piece.visible !== false) obj.group.visible = true
      else if (!obj.deathAnimating) obj.group.visible = false

      const appearanceCue = _pendingAppearanceCues.get(piece.id)
      if (appearanceCue && piece.visible !== false) {
        _pendingAppearanceCues.delete(piece.id)
        _animateSummon(obj)
      }
    })

    // Remove departed pieces
    _pieceObjects.forEach((obj, id) => {
      if (!seen.has(id)) {
        _pendingAppearanceCues.delete(id)
        _scene.remove(obj.group)
        _disposePieceObject(obj)
        _pieceObjects.delete(id)
      }
    })
  }

  function _effectType(effect) {
    return effect.type || effect.tileType || 'effect'
  }

  function _effectSortKey(effect) {
    return [
      _effectType(effect),
      effect.sourceId || effect.id || effect.instanceId || effect.effectId || '',
    ].join(':')
  }

  function _updateTileEffects(effects) {
    const seen = new Set()
    const effectsByCell = new Map()
    ;(effects || []).forEach(effect => {
      if (effect.x == null || effect.y == null) return
      const key = effect.x + ':' + effect.y
      if (!effectsByCell.has(key)) effectsByCell.set(key, [])
      effectsByCell.get(key).push(effect)
    })

    effectsByCell.forEach((cellEffects, key) => {
      seen.add(key)
      const sortedEffects = cellEffects
        .slice()
        .sort((left, right) => _effectSortKey(left).localeCompare(_effectSortKey(right)))
        .slice(0, TILE_EFFECT_ICON_SLOTS.length)
      const signature = sortedEffects.map(_effectSortKey).join('|')
      let entry = _tileEffectObjects.get(key)
      if (!entry || entry.signature !== signature) {
        if (entry) {
          _scene.remove(entry.group)
          entry.group.traverse(obj => {
            if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose()
          })
        }
        const group = new THREE.Group()
        sortedEffects.forEach((effect, index) => {
          const effectType = _effectType(effect)
          const ringRadius = 0.36 - index * 0.045
          const ring = new THREE.Mesh(
            new THREE.TorusGeometry(ringRadius, 0.018, 8, 32),
            getTileEffectMat(effectType)
          )
          ring.rotation.x = Math.PI / 2
          ring.position.y = _tileSurfaceHeightAt(effect.x, effect.y) + 0.025 + index * 0.004
          group.add(ring)

          const slot = TILE_EFFECT_ICON_SLOTS[index]
          const icon = new THREE.Sprite(getTileEffectIconMat(effectType))
          icon.position.set(slot.x, _tileSurfaceHeightAt(effect.x, effect.y) + 0.20, slot.z)
          icon.scale.set(0.24, 0.24, 0.24)
          icon.renderOrder = 8
          group.add(icon)
        })
        const first = sortedEffects[0]
        group.position.set(first.x, 0, first.y)
        _scene.add(group)
        entry = { group, signature }
        _tileEffectObjects.set(key, entry)
      } else {
        const first = sortedEffects[0]
        entry.group.position.set(first.x, 0, first.y)
      }
    })

    _tileEffectObjects.forEach((entry, key) => {
      if (!seen.has(key)) {
        _scene.remove(entry.group)
        entry.group.traverse(obj => {
          if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose()
        })
        _tileEffectObjects.delete(key)
      }
    })
  }

  function _spawnPieceMesh(piece) {
    const faction = piece.faction || 'red'
    const group = new THREE.Group()
    group.userData.pieceId = piece.id
    group.position.set(piece.x, _tileSurfaceHeightAt(piece.x, piece.y), piece.y)

    const contactShadow = new THREE.Mesh(_contactShadowGeom, _contactShadowMat)
    contactShadow.rotation.x = -Math.PI / 2
    contactShadow.position.y = 0.004
    contactShadow.scale.set(PIECE_W * 1.06, PIECE_D * 1.08, 1)
    contactShadow.renderOrder = 1
    group.add(contactShadow)

    const factionColor = FACTION_COLORS[faction] || FACTION_COLORS.red
    const bodyMaterial = new THREE.MeshLambertMaterial({
      color: 0x22272d,
      emissive: new THREE.Color(factionColor),
      emissiveIntensity: 0.08,
    })
    const body = new THREE.Mesh(_pieceBodyGeom, bodyMaterial)
    body.scale.set(PIECE_W, 1, PIECE_D)
    body.position.y = PIECE_H / 2 + 0.012
    group.add(body)

    const portraitMat = new THREE.MeshBasicMaterial({ color: 0x3b4148 })
    const portraitMesh = new THREE.Mesh(_portraitDiscGeom, portraitMat)
    portraitMesh.rotation.x = -Math.PI / 2
    portraitMesh.scale.set(PIECE_PORTRAIT_W, PIECE_PORTRAIT_D, 1)
    portraitMesh.position.y = PIECE_H + 0.014
    group.add(portraitMesh)

    const ring = new THREE.Mesh(_pieceRingGeom, getFactionMat(faction).clone())
    ring.rotation.x = Math.PI / 2
    ring.scale.set(PIECE_W, PIECE_D, 1)
    ring.position.y = 0.02
    group.add(ring)

    // Faction remains readable without color: red uses one neutral pip and blue
    // uses a pair. These markers share the portrait geometry but not its texture.
    const markerPattern = TacticalGeometry.factionMarkerPattern(faction)
    const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xf2e8d5 })
    const factionMarkers = [0, -0.11, 0.11].map(function (x, index) {
      const marker = new THREE.Mesh(_portraitDiscGeom, markerMaterial)
      marker.rotation.x = -Math.PI / 2
      marker.position.set(x, PIECE_H + 0.019, -PIECE_D * 0.45)
      marker.scale.set(0.08, 0.08, 1)
      marker.visible = markerPattern[index]
      group.add(marker)
      return marker
    })

    const feedbackMaterial = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
    const feedbackRing = new THREE.Mesh(_pieceRingGeom, feedbackMaterial)
    feedbackRing.rotation.x = Math.PI / 2
    feedbackRing.scale.set(PIECE_W * 1.12, PIECE_D * 1.12, 1)
    feedbackRing.userData.motionRole = 'feedback-ring'
    feedbackRing.position.y = PIECE_H + 0.03
    feedbackRing.renderOrder = 7
    group.add(feedbackRing)

    // Compact health and negative-status summary.
    const summaryEl = _createPieceSummaryEl(piece)

    _scene.add(group)
    _pieceObjects.set(piece.id, {
      id: piece.id,
      motionId: 'piece:' + piece.id,
      group, body, ring, portraitMesh, contactShadow, factionMarkers, feedbackRing,
      markerMaterial,
      summaryEl,
      faction,
      baseX: piece.x,
      baseY: _tileSurfaceHeightAt(piece.x, piece.y),
      baseZ: piece.y,
      motionBaseY: _tileSurfaceHeightAt(piece.x, piece.y),
      pending: false,
      deathAnimating: false,
      statusExitTimers: new Map(),
      portraitLoaded: false,
      portraitLoading: false,
      portraitSrc: '',
      targetX: piece.x, targetZ: piece.y,
    })
  }

  function _disposePieceObject(obj) {
    _cancelAnimationsForPrefix(obj.motionId + ':')
    obj.statusExitTimers.forEach(function (timer) { clearTimeout(timer) })
    obj.statusExitTimers.clear()
    ;[obj.body.material, obj.portraitMesh.material, obj.ring.material, obj.markerMaterial, obj.feedbackRing.material]
      .forEach(function (material) { if (material && material.dispose) material.dispose() })
    if (obj.summaryEl && obj.summaryEl.parentNode) obj.summaryEl.remove()
  }

  // ── Piece summary overlay ─────────────────────────────────────────────────────
  function _statusBadgeText(status) {
    const registry = window.BattleEffectIcons
    const values = registry && typeof registry.badge === 'function'
      ? registry.badge(status)
      : status || {}
    const stacks = Number(values.stacks)
    const uses = Number(values.uses)
    const duration = Number(values.duration)
    const intensity = Number(values.intensity)
    if (Number.isFinite(stacks) && stacks > 1) return String(stacks)
    if (Number.isFinite(uses) && uses > 0) return String(uses)
    if (Number.isFinite(duration) && duration > 0) return String(duration)
    if (Number.isFinite(intensity) && intensity > 1) return String(intensity)
    return ''
  }

  function _statusIconPath(entry) {
    return entry.status.iconPath || entry.status.assetPath || entry.meta.assetPath || 'images/effect-icons/fallback.svg'
  }

  function _renderStatusIcon(container, entry, compact) {
    const icon = document.createElement('img')
    icon.className = compact ? 'piece-board-status-image' : 'piece-board-status-list-image'
    icon.setAttribute('src', _statusIconPath(entry))
    icon.setAttribute('alt', '')
    icon.setAttribute('aria-hidden', 'true')
    const badgeText = _statusBadgeText(entry.status)
    const children = [icon]
    if (badgeText) {
      const badge = document.createElement('b')
      badge.className = compact ? 'piece-board-status-badge' : 'piece-board-status-list-badge'
      badge.textContent = badgeText
      badge.setAttribute('aria-hidden', 'true')
      children.push(badge)
    }
    container.replaceChildren(...children)
  }

  function _createPieceSummaryEl(piece) {
    const wrap = document.createElement('div')
    wrap.className = 'piece-board-summary'
    wrap.dataset.pieceId = piece.id

    const health = document.createElement('span')
    health.className = 'piece-board-health'
    const statuses = document.createElement('span')
    statuses.className = 'piece-board-statuses'
    statuses.hidden = true
    const overflow = document.createElement('button')
    overflow.className = 'piece-board-status-overflow'
    overflow.setAttribute('type', 'button')
    overflow.setAttribute('aria-expanded', 'false')
    overflow.hidden = true
    const popover = document.createElement('span')
    popover.className = 'piece-board-status-popover'
    popover.setAttribute('role', 'group')
    popover.setAttribute('aria-label', '全部状态')
    popover.setAttribute('aria-hidden', 'true')
    const popoverId = 'piece-statuses-' + String(piece.id).replace(/[^a-zA-Z0-9_-]/g, '-')
    popover.id = popoverId
    overflow.setAttribute('aria-controls', popoverId)
    const setDisclosureExpanded = function (expanded) {
      overflow.setAttribute('aria-expanded', expanded ? 'true' : 'false')
      popover.setAttribute('aria-hidden', expanded ? 'false' : 'true')
    }
    overflow.addEventListener('focus', function () { setDisclosureExpanded(true) })
    overflow.addEventListener('blur', function () {
      statuses.dataset.open = 'false'
      setDisclosureExpanded(false)
    })
    overflow.addEventListener('mouseenter', function () { setDisclosureExpanded(true) })
    overflow.addEventListener('mouseleave', function () {
      setDisclosureExpanded(statuses.dataset.open === 'true')
    })
    overflow.addEventListener('click', function (event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
      const expanded = statuses.dataset.open !== 'true'
      statuses.dataset.open = expanded ? 'true' : 'false'
      setDisclosureExpanded(expanded)
    })
    statuses.appendChild(overflow)
    statuses.appendChild(popover)
    wrap.appendChild(health)
    wrap.appendChild(statuses)
    _hpLayer.appendChild(wrap)
    return wrap
  }

  function _updatePieceSummary(obj, piece) {
    if (!obj.summaryEl) return
    const currentHp = piece.health ? piece.health.current : 0
    const maxHp = piece.health ? piece.health.max : 1
    const health = obj.summaryEl.querySelector('.piece-board-health')
    if (health) {
      health.textContent = String(currentHp)
      const ratio = currentHp / Math.max(1, maxHp)
      health.dataset.level = ratio < 0.3 ? 'critical' : (ratio < 0.6 ? 'low' : 'healthy')
    }

    const presentation = window.BattleStatusPresentation
    const overview = presentation && typeof presentation.boardOverview === 'function'
      ? presentation.boardOverview(piece.statusSummary || [])
      : (function () {
          const all = (piece.statusSummary || []).map(status => ({
            status,
            meta: { color: '#a78bfa', assetPath: status.iconPath || 'images/effect-icons/fallback.svg' },
          }))
          return { items: all.slice(0, 2), all, overflowCount: Math.max(0, all.length - 2) }
        })()
    const summary = overview.items
    const statuses = obj.summaryEl.querySelector('.piece-board-statuses')
    if (statuses) {
      const existing = new Map()
      Array.from(statuses.children || []).forEach(function (dot) {
        if (!String(dot.className || '').split(/\s+/).includes('piece-board-status-dot')) return
        existing.set(dot.dataset.statusId, dot)
      })
      const desired = new Set()
      summary.forEach(function (entry) {
        const statusId = entry.status.id || entry.status.label || ''
        desired.add(statusId)
        let dot = existing.get(statusId)
        if (dot) {
          const exitTimer = obj.statusExitTimers.get(statusId)
          if (exitTimer) clearTimeout(exitTimer)
          obj.statusExitTimers.delete(statusId)
          dot.className = 'piece-board-status-dot'
          existing.delete(statusId)
        } else {
          dot = document.createElement('span')
          dot.className = 'piece-board-status-dot is-entering'
          statuses.insertBefore(dot, statuses.querySelector('.piece-board-status-overflow'))
        }
        dot.style.setProperty('--status-color', entry.meta.color)
        dot.dataset.statusId = statusId
        dot.title = entry.status.label || entry.status.id || ''
        dot.setAttribute('aria-hidden', 'true')
        _renderStatusIcon(dot, entry, true)
      })
      existing.forEach(function (dot, statusId) {
        if (desired.has(statusId) || obj.statusExitTimers.has(statusId)) return
        dot.className = 'piece-board-status-dot is-exiting'
        const timer = setTimeout(function () {
          dot.remove()
          obj.statusExitTimers.delete(statusId)
          if (statuses.dataset.totalCount === '0') statuses.hidden = true
        }, MOTION_TOKENS.fast - 20)
        obj.statusExitTimers.set(statusId, timer)
      })
      const overflow = statuses.querySelector('.piece-board-status-overflow')
      const popover = statuses.querySelector('.piece-board-status-popover')
      if (overflow) {
        overflow.hidden = overview.overflowCount === 0
        overflow.textContent = '+' + overview.overflowCount
        overflow.setAttribute('aria-label', '查看全部 ' + overview.all.length + ' 个状态')
        overflow.setAttribute('aria-expanded', 'false')
        if (popover) popover.setAttribute('aria-hidden', 'true')
        statuses.dataset.open = 'false'
      }
      if (popover) {
        const rows = overview.all.map(function (entry) {
          const row = document.createElement('span')
          row.className = 'piece-board-status-list-item'
          const statusLabel = entry.status.label || entry.status.id || '未知状态'
          row.setAttribute('role', 'img')
          row.setAttribute('aria-label', statusLabel)
          row.title = statusLabel
          const iconSlot = document.createElement('span')
          iconSlot.className = 'piece-board-status-list-icon'
          _renderStatusIcon(iconSlot, entry, false)
          const label = document.createElement('span')
          label.className = 'piece-board-status-list-label'
          label.textContent = statusLabel
          row.appendChild(iconSlot)
          row.appendChild(label)
          return row
        })
        popover.replaceChildren(...rows)
      }
      statuses.dataset.totalCount = String(overview.all.length)
      statuses.hidden = overview.all.length === 0 && existing.size === 0
    }

    const statusNames = overview.all.map(function (entry) { return entry.status.label || entry.status.id }).filter(Boolean)
    const accessible = (piece.name || piece.id) + '\uff0c\u751f\u547d ' + currentHp + ' / ' + maxHp
      + (statusNames.length ? '\uff0c\u72b6\u6001 ' + statusNames.join('\u3001') : '')
    obj.summaryEl.dataset.health = currentHp + '/' + maxHp
    obj.summaryEl.dataset.statusCount = String(overview.all.length)
    obj.summaryEl.dataset.statusIds = overview.all.map(function (entry) { return entry.status.id || '' }).join(',')
    obj.summaryEl.setAttribute('aria-label', accessible)
    obj.summaryEl.title = accessible
    obj.summaryEl.style.display = piece.visible !== false ? '' : 'none'
  }

  function _projectedCellSpan(x, y) {
    const center = projectCell(x, y, _tileSurfaceHeightAt(x, y))
    if (!center) return 36
    const horizontal = projectCell(x + 1, y, _tileSurfaceHeightAt(x + 1, y))
    const vertical = projectCell(x, y + 1, _tileSurfaceHeightAt(x, y + 1))
    const distances = [horizontal, vertical].filter(Boolean).map(function (point) {
      const dx = point.left - center.left
      const dy = point.top - center.top
      return Math.sqrt(dx * dx + dy * dy)
    })
    return distances.length ? Math.min.apply(Math, distances) : 36
  }

  function _updatePieceSummaryPositions() {
    if (!_camera || !_renderer) return

    _pieceObjects.forEach(obj => {
      if (!obj.summaryEl || !obj.group.visible) { if (obj.summaryEl) obj.summaryEl.style.display = 'none'; return }
      const x = obj.group.position.x
      const y = obj.group.position.z
      const projected = projectCell(x, y, obj.group.position.y + PIECE_H + 0.1)
      if (!projected) return
      const cellSpan = _projectedCellSpan(x, y)
      const scale = Math.max(0.36, Math.min(1, cellSpan / 38))
      obj.summaryEl.style.setProperty('--piece-summary-scale', scale.toFixed(3))
      obj.summaryEl.style.left = projected.left + 'px'
      obj.summaryEl.style.top = (projected.top + Math.max(3, cellSpan * 0.28)) + 'px'
      obj.summaryEl.style.display = ''
    })
  }

  // ── Highlights ────────────────────────────────────────────────────────────────
  function setHighlights(hl) {
    _syncHighlightGroup('move', hl.move || [])
    _syncHighlightGroup('skill', hl.skill || [])
    _syncHighlightGroup('place', hl.place || [])
    _syncSelectedHighlight(hl.selected || null)
  }

  function _normalizeHighlightItem(item) {
    let x
    let z
    if (typeof item === 'string') {
      const parts = item.split(',')
      x = Number(parts[0])
      z = Number(parts[1])
    } else if (item && item.x != null) {
      x = Number(item.x)
      z = Number(item.z !== undefined ? item.z : item.y)
    }
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null
    return { key: x + ',' + z, x, z }
  }

  function _syncHighlightGroup(type, items) {
    const objects = _hlObjects[type]
    objects.forEach(function (entry) { entry.desired = false })
    ;(items || []).forEach(function (item) {
      const cell = _normalizeHighlightItem(item)
      if (!cell) return
      let entry = objects.get(cell.key)
      if (!entry) {
        const cfg = HL_COLORS[type] || HL_COLORS.move
        const material = getHlMat(type).clone()
        material.opacity = 0
        const mesh = new THREE.Mesh(_hlPlaneGeom, material)
        mesh.rotation.x = -Math.PI / 2
        mesh.position.set(cell.x, _tileSurfaceHeightAt(cell.x, cell.z) + 0.012, cell.z)
        const startScale = _reducedMotion ? 1 : 0.94
        mesh.scale.set(startScale, startScale, 1)
        _scene.add(mesh)
        entry = { key: cell.key, mesh, x: cell.x, z: cell.z, desired: true, targetOpacity: cfg.opacity }
        objects.set(cell.key, entry)
      }
      entry.desired = true
      entry.mesh.position.set(cell.x, _tileSurfaceHeightAt(cell.x, cell.z) + 0.012, cell.z)
      if (Math.abs(entry.mesh.scale.x - 1) > 0.001 || Math.abs(entry.mesh.material.opacity - entry.targetOpacity) > 0.001) {
        _animateHighlightAppearance(type, entry, 1, entry.targetOpacity, MOTION_SECONDS.fast)
      }
    })
    objects.forEach(function (entry, key) {
      if (entry.desired) return
      _animateHighlightAppearance(type, entry, entry.mesh.scale.x, 0, 0.12, function () {
        if (entry.desired || objects.get(key) !== entry) return
        _scene.remove(entry.mesh)
        if (entry.mesh.material && entry.mesh.material.dispose) entry.mesh.material.dispose()
        objects.delete(key)
      })
    })
  }

  function _animateHighlightAppearance(type, entry, targetScale, targetOpacity, duration, onComplete) {
    const fromScale = entry.mesh.scale.x
    const fromOpacity = entry.mesh.material.opacity
    const propertyPrefix = 'highlight:' + type + ':' + entry.key + ':'
    _startAnimation(propertyPrefix + 'scale', {
      duration,
      easing: EASE.out,
      update: function (progress) {
        const scale = fromScale + (targetScale - fromScale) * progress
        entry.mesh.scale.set(scale, scale, 1)
      },
    })
    _startAnimation(propertyPrefix + 'opacity', {
      duration,
      easing: EASE.out,
      update: function (progress) {
        entry.mesh.material.opacity = fromOpacity + (targetOpacity - fromOpacity) * progress
      },
      complete: onComplete,
    })
  }

  function _syncSelectedHighlight(pieceId) {
    if (_hlObjects.selectedId === pieceId && _hlObjects.selected) {
      _updateSelectedRingPosition()
      return
    }
    if (_hlObjects.selected) {
      const previous = _hlObjects.selected
      _scene.remove(previous)
      if (previous.material && previous.material.dispose) previous.material.dispose()
      _cancelAnimation('highlight:selected:appearance')
      _hlObjects.selected = null
      _hlObjects.selectedId = null
    }
    if (!pieceId) return
    const obj = _pieceObjects.get(pieceId)
    if (!obj) return
    const material = getHlMat('selected').clone()
    material.opacity = 0
    const ring = new THREE.Mesh(_selectedRingGeom, material)
    ring.rotation.x = Math.PI / 2
    const startScale = _reducedMotion ? 1 : 0.9
    ring.scale.set(PIECE_W * 1.14 * startScale, PIECE_D * 1.14 * startScale, 1)
    ring.renderOrder = 5
    _scene.add(ring)
    _hlObjects.selected = ring
    _hlObjects.selectedId = pieceId
    _updateSelectedRingPosition()
    _startAnimation('highlight:selected:appearance', {
      duration: MOTION_SECONDS.fast,
      easing: EASE.out,
      update: function (progress) {
        const scale = startScale + (1 - startScale) * progress
        ring.scale.set(PIECE_W * 1.14 * scale, PIECE_D * 1.14 * scale, 1)
        material.opacity = 0.75 * progress
      },
    })
  }

  function _clearPresentationAreaFlash() {
    _cancelAnimation('presentation:area:intensity')
    if (!_presentationAreaFlash) return
    _presentationAreaFlash.entries.forEach(function (entry) {
      if (_scene && entry.mesh) _scene.remove(entry.mesh)
      if (entry.flashMaterial && entry.flashMaterial.dispose) entry.flashMaterial.dispose()
    })
    _presentationAreaFlash = null
    _invalidate()
  }

  function showPresentationAreaFlash(cells) {
    if (!_mounted || !_scene || !_hlPlaneGeom) return
    const normalized = []
    const seen = new Set()
    ;(cells || []).forEach(function (item) {
      const cell = _normalizeHighlightItem(item)
      if (!cell || seen.has(cell.key) || !_tileObjects.has(cell.key)) return
      seen.add(cell.key)
      normalized.push(cell)
    })
    normalized.sort(function (left, right) { return left.key.localeCompare(right.key) })
    const signature = normalized.map(function (cell) { return cell.key }).join('|')
    if (!signature) {
      _clearPresentationAreaFlash()
      return
    }
    if (_presentationAreaFlash && _presentationAreaFlash.signature === signature) return
    _clearPresentationAreaFlash()

    const entries = normalized.map(function (cell) {
      const flashMaterial = new THREE.MeshLambertMaterial({
        color: 0xf97316,
        emissive: 0xf97316,
        transparent: true,
        opacity: 0.76,
        depthWrite: false,
      })
      flashMaterial.emissiveIntensity = _reducedMotion ? 0.72 : 0
      const mesh = new THREE.Mesh(_hlPlaneGeom, flashMaterial)
      mesh.rotation.x = -Math.PI / 2
      mesh.position.set(cell.x, _tileSurfaceHeightAt(cell.x, cell.z) + 0.016, cell.z)
      mesh.renderOrder = 6
      mesh.userData.presentationAreaFlash = true
      mesh.userData.presentationAreaCell = { x: cell.x, y: cell.z }
      _scene.add(mesh)
      return {
        key: cell.key,
        mesh: mesh,
        flashMaterial: flashMaterial,
      }
    })
    _presentationAreaFlash = {
      signature: signature,
      cellCount: normalized.length,
      entries: entries,
    }
    if (_reducedMotion) return
    _startAnimation('presentation:area:intensity', {
      duration: MOTION_SECONDS.result,
      easing: EASE.out,
      update: function (progress, raw) {
        const timeline = Number.isFinite(raw) ? raw : progress
        const intensity = timeline <= 0.42
          ? 1.15 * EASE.out(timeline / 0.42)
          : 1.15 - 0.77 * EASE.in((timeline - 0.42) / 0.58)
        entries.forEach(function (entry) { entry.flashMaterial.emissiveIntensity = intensity })
      },
      complete: function () {
        entries.forEach(function (entry) { entry.flashMaterial.emissiveIntensity = 0.38 })
      },
    })
  }

  function _disposePresentationObject(object) {
    if (!object) return
    object.traverse(function (child) {
      if (child.geometry && child.geometry.dispose) child.geometry.dispose()
      if (child.material) {
        ;(Array.isArray(child.material) ? child.material : [child.material]).forEach(function (material) {
          if (material && material.dispose) material.dispose()
        })
      }
    })
  }

  function _clearPresentationPath() {
    _cancelAnimation('presentation:path:opacity')
    if (!_presentationPath) return
    if (_scene && _presentationPath.group) _scene.remove(_presentationPath.group)
    _disposePresentationObject(_presentationPath.group)
    _presentationPath = null
  }

  function _normalizePresentationPoint(point) {
    const cell = _normalizeHighlightItem(point)
    if (!cell || !_tileObjects.has(cell.key)) return null
    return cell
  }

  function _createPresentationPathRibbon(source, end) {
    const dx = end.x - source.x
    const dz = end.z - source.z
    const distance = Math.hypot(dx, dz)
    if (distance < 0.001) return null
    const halfWidth = 0.035
    const offsetX = -dz / distance * halfWidth
    const offsetZ = dx / distance * halfWidth
    // One constant board-plane elevation is intentional: endpoint terrain may
    // be raised, but the trajectory direction must stay parallel to the grid.
    // Raised tiles then occlude the line naturally instead of tilting it.
    const sourceY = TILE_H + 0.028
    const endY = sourceY
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      source.x + offsetX, sourceY, source.z + offsetZ,
      source.x - offsetX, sourceY, source.z - offsetZ,
      end.x - offsetX, endY, end.z - offsetZ,
      end.x + offsetX, endY, end.z + offsetZ,
    ], 3))
    geometry.setIndex([0, 1, 2, 0, 2, 3])
    const material = new THREE.MeshBasicMaterial({
      color: 0x93c5fd,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.renderOrder = 4
    mesh.userData.presentationPathRole = 'trajectory'
    mesh.userData.sourceCell = { x: source.x, y: source.z }
    mesh.userData.endCell = { x: end.x, y: end.z }
    return mesh
  }

  function _createPresentationAimMarker(selected) {
    if (!selected) return null
    const positions = []
    const segmentCount = 16
    const radius = 0.22
    const elevation = _tileSurfaceHeightAt(selected.x, selected.z) + 0.032
    for (let index = 0; index < segmentCount; index += 2) {
      const startAngle = index / segmentCount * Math.PI * 2
      const endAngle = (index + 1) / segmentCount * Math.PI * 2
      positions.push(
        selected.x + Math.cos(startAngle) * radius, elevation, selected.z + Math.sin(startAngle) * radius,
        selected.x + Math.cos(endAngle) * radius, elevation, selected.z + Math.sin(endAngle) * radius,
      )
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    const material = new THREE.LineBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
    const marker = new THREE.LineSegments(geometry, material)
    marker.renderOrder = 5
    marker.userData.presentationPathRole = 'selected-aim'
    marker.userData.selectedCell = { x: selected.x, y: selected.z }
    return marker
  }

  function showPresentationPath(input) {
    if (!_mounted || !_scene) return
    const source = _normalizePresentationPoint(input && input.source)
    const end = _normalizePresentationPoint(input && input.end)
    const selected = _normalizePresentationPoint(input && input.selected)
    const hasTrajectory = !!(source && end && (source.x !== end.x || source.z !== end.z))
    if (!hasTrajectory && !selected) {
      _clearPresentationPath()
      return
    }
    const signature = [source && source.key || '', end && end.key || '', selected && selected.key || ''].join('|')
    if (_presentationPath && _presentationPath.signature === signature) return
    _clearPresentationPath()
    const trajectory = hasTrajectory ? _createPresentationPathRibbon(source, end) : null
    const aim = _createPresentationAimMarker(selected)
    if (!trajectory && !aim) return
    const group = new THREE.Group()
    group.userData.presentationPath = true
    if (trajectory) group.add(trajectory)
    if (aim) group.add(aim)
    _scene.add(group)
    const materials = (trajectory ? [trajectory.material] : []).concat(aim ? [aim.material] : [])
    _presentationPath = {
      signature: signature,
      group: group,
      source: source ? { x: source.x, y: source.z } : null,
      end: end ? { x: end.x, y: end.z } : null,
      selected: selected ? { x: selected.x, y: selected.z } : null,
    }
    const targetOpacities = (trajectory ? [0.82] : []).concat(aim ? [0.86] : [])
    if (_reducedMotion) {
      materials.forEach(function (material, index) { material.opacity = targetOpacities[index] })
      return
    }
    _startAnimation('presentation:path:opacity', {
      duration: MOTION_SECONDS.fast,
      easing: EASE.out,
      update: function (progress) {
        materials.forEach(function (material, index) { material.opacity = targetOpacities[index] * progress })
      },
      complete: function () {
        materials.forEach(function (material, index) { material.opacity = targetOpacities[index] })
      },
    })
  }

  function _updateSelectedRingPosition() {
    if (!_hlObjects.selected || !_hlObjects.selectedId) return
    const obj = _pieceObjects.get(_hlObjects.selectedId)
    if (!obj) return
    _hlObjects.selected.position.copy(obj.group.position)
    _hlObjects.selected.position.y += 0.035
  }

  function _clearHistoryHighlight() {
    if (_historyHighlightGroup && _scene) {
      _scene.remove(_historyHighlightGroup)
      _historyHighlightGroup.traverse(function (object) {
        if (object.geometry && object.geometry.dispose) object.geometry.dispose()
        if (object.material) {
          ;(Array.isArray(object.material) ? object.material : [object.material]).forEach(function (material) {
            if (material && material.dispose) material.dispose()
          })
        }
      })
    }
    _historyHighlightGroup = null
    _historyHighlightPointCount = 0
    _historyHighlightPathCount = 0
  }

  function setHistoryHighlight(items) {
    _clearHistoryHighlight()
    if (!_mounted || !_scene) return
    const cells = []
    const seen = new Set()
    ;(Array.isArray(items) ? items : []).forEach(function (item) {
      const cell = _normalizeHighlightItem(item)
      if (!cell) return
      const role = item && item.role === 'source' ? 'source' : 'target'
      const key = cell.key + ':' + role
      if (seen.has(key)) return
      seen.add(key)
      cells.push({ x: cell.x, z: cell.z, role: role })
    })
    if (!cells.length) return

    // This is world-space geometry. The constant Y keeps every connector in an
    // XZ plane parallel to the board; the active camera supplies perspective.
    const planeY = TILE_H + 0.09
    const group = new THREE.Group()
    group.userData.historyHighlight = true
    group.userData.planeY = planeY
    group.renderOrder = 20
    const source = cells.find(function (cell) { return cell.role === 'source' })

    cells.forEach(function (cell) {
      const geometry = new THREE.RingGeometry(0.20, 0.29, 32)
      const color = cell.role === 'source' ? 0x93c5fd : 0xfacc15
      const material = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.96,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      })
      const marker = new THREE.Mesh(geometry, material)
      marker.rotation.x = -Math.PI / 2
      marker.position.set(cell.x, planeY, cell.z)
      marker.renderOrder = 21
      marker.userData.historyRole = cell.role
      group.add(marker)
      _historyHighlightPointCount += 1
    })

    if (source) {
      cells.filter(function (cell) { return cell.role === 'target' }).forEach(function (target) {
        if (target.x === source.x && target.z === source.z) return
        const geometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(source.x, planeY, source.z),
          new THREE.Vector3(target.x, planeY, target.z),
        ])
        const material = new THREE.LineDashedMaterial({
          color: 0xfde047,
          transparent: true,
          opacity: 0.92,
          dashSize: 0.24,
          gapSize: 0.14,
          depthTest: false,
          depthWrite: false,
        })
        const path = new THREE.Line(geometry, material)
        path.computeLineDistances()
        path.renderOrder = 20
        path.userData.historyRole = 'path'
        group.add(path)
        _historyHighlightPathCount += 1
      })
    }

    _historyHighlightGroup = group
    _scene.add(group)
  }

  function clearTutorialCue() {
    _cancelAnimationsForPrefix('tutorial-cue:')
    if (_tutorialCueGroup && _scene) {
      _scene.remove(_tutorialCueGroup)
      _tutorialCueGroup.traverse(function (object) {
        if (object.geometry && object.geometry.dispose) object.geometry.dispose()
        if (object.material) {
          ;(Array.isArray(object.material) ? object.material : [object.material]).forEach(function (material) {
            if (material && material.dispose) material.dispose()
          })
        }
      })
    }
    _tutorialCueGroup = null
    _tutorialCueCellCount = 0
    _tutorialCuePathCount = 0
    _invalidate()
  }

  function _startTutorialPulse(group) {
    if (_reducedMotion || !group || group !== _tutorialCueGroup) return
    _startAnimation('tutorial-cue:pulse', {
      duration: 1.15,
      easing: EASE.inOut,
      update: function (_, raw) {
        const pulse = 0.5 - Math.cos(raw * Math.PI * 2) * 0.5
        ;(group.userData.rings || []).forEach(function (ring) {
          const scale = 1 + pulse * 0.13
          ring.scale.set(scale, scale, scale)
          ring.material.opacity = 0.72 + pulse * 0.24
        })
        ;(group.userData.beams || []).forEach(function (beam) {
          beam.material.opacity = 0.08 + pulse * 0.08
        })
      },
      complete: function () {
        if (group === _tutorialCueGroup) _startTutorialPulse(group)
      },
    })
  }

  function setTutorialCue(cue) {
    clearTutorialCue()
    if (!_mounted || !_scene || !cue) return
    const cells = []
    const seen = new Set()
    ;(Array.isArray(cue.cells) ? cue.cells : []).forEach(function (cell) {
      const x = Number(cell && cell.x), z = Number(cell && cell.y)
      const key = x + ',' + z
      if (!Number.isInteger(x) || !Number.isInteger(z) || seen.has(key)) return
      seen.add(key)
      cells.push({ x: x, z: z })
    })
    const path = (Array.isArray(cue.path) ? cue.path : []).map(function (cell) {
      return { x: Number(cell && cell.x), z: Number(cell && cell.y) }
    }).filter(function (cell) { return Number.isInteger(cell.x) && Number.isInteger(cell.z) })
    if (!cells.length && path.length < 2) return

    const group = new THREE.Group()
    const rings = []
    const beams = []
    group.userData.tutorialCue = true
    group.userData.rings = rings
    group.userData.beams = beams
    group.renderOrder = 24

    cells.forEach(function (cell) {
      const surfaceY = _tileSurfaceHeightAt(cell.x, cell.z)
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.28, 0.38, 40),
        new THREE.MeshBasicMaterial({
          color: 0x86efac, transparent: true, opacity: 0.88,
          side: THREE.DoubleSide, depthTest: false, depthWrite: false,
        }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.set(cell.x, surfaceY + 0.075, cell.z)
      ring.renderOrder = 25
      ring.userData.tutorialCueRole = 'ring'
      rings.push(ring)
      group.add(ring)

      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.25, 0.39, 1.15, 28, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x4ade80, transparent: true, opacity: 0.12,
          side: THREE.DoubleSide, depthTest: false, depthWrite: false,
        }),
      )
      beam.position.set(cell.x, surfaceY + 0.62, cell.z)
      beam.renderOrder = 24
      beam.userData.tutorialCueRole = 'beam'
      beams.push(beam)
      group.add(beam)
    })

    if (path.length >= 2) {
      const geometry = new THREE.BufferGeometry().setFromPoints(path.map(function (cell) {
        return new THREE.Vector3(cell.x, _tileSurfaceHeightAt(cell.x, cell.z) + 0.10, cell.z)
      }))
      const material = new THREE.LineDashedMaterial({
        color: 0x86efac, transparent: true, opacity: 0.92,
        dashSize: 0.22, gapSize: 0.12, depthTest: false, depthWrite: false,
      })
      const line = new THREE.Line(geometry, material)
      line.computeLineDistances()
      line.renderOrder = 24
      line.userData.tutorialCueRole = 'path'
      group.add(line)
      _tutorialCuePathCount = 1
    }

    _tutorialCueGroup = group
    _tutorialCueCellCount = cells.length
    _scene.add(group)
    _startTutorialPulse(group)
    _invalidate()
  }

  // ── Animation ─────────────────────────────────────────────────────────────────

  function _cubicBezier(values) {
    const x1 = values[0], y1 = values[1], x2 = values[2], y2 = values[3]
    function sample(a, b, t) { return 3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t }
    return function (progress) {
      if (progress <= 0 || progress >= 1) return progress
      let low = 0, high = 1, time = progress
      for (let index = 0; index < 8; index += 1) {
        const x = sample(x1, x2, time)
        if (Math.abs(x - progress) < 0.0001) break
        if (x < progress) low = time
        else high = time
        time = (low + high) / 2
      }
      return sample(y1, y2, time)
    }
  }

  const EASE = Object.freeze({
    out: _cubicBezier(MOTION_TOKENS.easeOut),
    in: _cubicBezier(MOTION_TOKENS.easeIn),
    inOut: _cubicBezier(MOTION_TOKENS.easeInOut),
  })

  function _startAnimation(key, options) {
    _cancelAnimation(key)
    const controller = {
      key,
      elapsed: 0,
      duration: Math.max(0.001, options.duration || MOTION_SECONDS.fast),
      easing: options.easing || EASE.out,
      update: options.update || function () {},
      complete: options.complete || null,
      cancel: options.cancel || null,
    }
    _anims.set(key, controller)
    controller.update(0, 0)
    _summaryPositionsDirty = true
    _invalidate()
    return controller
  }

  function _cancelAnimation(key) {
    const controller = _anims.get(key)
    if (!controller) return
    _anims.delete(key)
    if (controller.cancel) controller.cancel()
    _summaryPositionsDirty = true
    _invalidate()
  }

  function _cancelAnimationsForPrefix(prefix) {
    Array.from(_anims.keys()).forEach(function (key) {
      if (key.indexOf(prefix) === 0) _cancelAnimation(key)
    })
  }

  function _finishSpatialAnimations() {
    Array.from(_anims.entries()).forEach(function (entry) {
      const key = entry[0]
      if (!key.endsWith(':position') && !key.endsWith(':scale')) return
      const controller = entry[1]
      _anims.delete(key)
      controller.update(1, 1)
      if (controller.complete) controller.complete()
    })
    _summaryPositionsDirty = true
    _invalidate()
  }

  function _stepAnims(dt) {
    Array.from(_anims.entries()).forEach(function (entry) {
      const key = entry[0]
      const controller = entry[1]
      if (_anims.get(key) !== controller) return
      controller.elapsed += dt
      const raw = Math.min(1, controller.elapsed / controller.duration)
      controller.update(controller.easing(raw), raw)
      if (raw < 1 || _anims.get(key) !== controller) return
      _anims.delete(key)
      if (controller.complete) controller.complete()
    })
    if (_anims.size > 0) {
      _updateSelectedRingPosition()
      _summaryPositionsDirty = true
    }
  }

  function _pieceById(model, pieceId) {
    return ((model && model.pieces) || []).find(function (piece) { return piece.id === pieceId }) || null
  }

  function _pieceHealth(piece) {
    if (!piece) return 0
    if (piece.health && Number.isFinite(piece.health.current)) return piece.health.current
    return Number.isFinite(piece.hp) ? piece.hp : 0
  }

  function _statusSignature(piece) {
    return JSON.stringify((piece && (piece.statuses || piece.statusEffects)) || [])
  }

  function _diffSignature(previousModel, nextModel) {
    return ((nextModel && nextModel.pieces) || []).map(function (nextPiece) {
      const previousPiece = _pieceById(previousModel, nextPiece.id)
      return [
        nextPiece.id,
        previousPiece && previousPiece.x, previousPiece && previousPiece.y,
        nextPiece.x, nextPiece.y,
        _pieceHealth(previousPiece), _pieceHealth(nextPiece),
        _statusSignature(previousPiece), _statusSignature(nextPiece),
        previousPiece && previousPiece.visible, nextPiece.visible,
      ].join(':')
    }).join('|')
  }

  function _eventKey(action, previousModel, nextModel) {
    const explicit = action && (action.motionEventKey || action.eventKey || action.clientActionId || action.actionId || action.sequence || action.seq)
    if (explicit != null && explicit !== '') return String(explicit)
    return [action && action.type || 'state', action && action.pieceId || '', _diffSignature(previousModel, nextModel)].join('|')
  }

  function _rememberEvent(key) {
    if (_playedEventKeys.has(key)) return false
    _playedEventKeys.add(key)
    _playedEventOrder.push(key)
    if (_playedEventOrder.length > 256) _playedEventKeys.delete(_playedEventOrder.shift())
    return true
  }

  function animateAction(action, previousModel, nextModel) {
    if (!_mounted || !nextModel) return
    const eventKey = _eventKey(action || {}, previousModel, nextModel)
    if (!_rememberEvent(eventKey)) return
    if (action && action.type === 'ui-reject') {
      const rejected = _pieceObjects.get(action.pieceId)
      if (rejected) _flashOutline(rejected, 0xef4444, MOTION_SECONDS.reject)
      return
    }

    const damagedTargets = []
    ;(nextModel.pieces || []).forEach(function (nextPiece) {
      const previousPiece = _pieceById(previousModel, nextPiece.id)
      if (!previousPiece) {
        if (nextPiece.visible !== false) _pendingAppearanceCues.set(nextPiece.id, 'summon')
        return
      }
      const obj = _pieceObjects.get(nextPiece.id)
      if (!obj) return
      if (previousPiece.visible === false && nextPiece.visible !== false) {
        _pendingAppearanceCues.set(nextPiece.id, 'summon')
        return
      }
      if (previousPiece.x !== nextPiece.x || previousPiece.y !== nextPiece.y) {
        _animateMove(obj, nextPiece.x, nextPiece.y)
      }
      const healthDelta = _pieceHealth(nextPiece) - _pieceHealth(previousPiece)
      if (healthDelta < 0) {
        damagedTargets.push(nextPiece.id)
        _animateHit(obj)
      } else if (healthDelta > 0) {
        _animateHeal(obj)
      }
      if (_statusSignature(previousPiece) !== _statusSignature(nextPiece)) _animateStatusChange(obj)
      if (previousPiece.visible !== false && nextPiece.visible === false) _animateDeath(obj)
    })

    const sourceId = action && (action.sourcePieceId || action.attackerId || action.actorId || action.pieceId)
    const targetId = action && (action.targetPieceId || action.targetId)
    if (sourceId && targetId && damagedTargets.indexOf(targetId) >= 0 && sourceId !== targetId) {
      _animateAttackerLunge(sourceId, targetId)
    }
  }

  function _animateMove(obj, targetX, targetZ) {
    const targetY = _tileSurfaceHeightAt(targetX, targetZ)
    const from = { x: obj.group.position.x, y: obj.group.position.y, z: obj.group.position.z }
    const fromBaseY = Number.isFinite(obj.motionBaseY) ? obj.motionBaseY : obj.baseY
    const visibleArc = Math.max(0, Math.min(0.08, from.y - fromBaseY))
    obj.baseX = targetX
    obj.baseY = targetY
    obj.baseZ = targetZ
    if (_reducedMotion) {
      obj.motionBaseY = targetY
      obj.group.position.set(targetX, targetY, targetZ)
      _flashOutline(obj, 0xf59e0b, MOTION_SECONDS.press)
      return
    }
    _startAnimation(obj.motionId + ':position', {
      duration: Math.min(0.32, MOTION_SECONDS.action),
      easing: EASE.inOut,
      update: function (progress, raw) {
        const pathBaseY = fromBaseY + (targetY - fromBaseY) * progress
        const desiredArc = Math.sin(Math.PI * raw) * 0.08
        const arc = visibleArc + (desiredArc - visibleArc) * progress
        obj.motionBaseY = pathBaseY
        obj.group.position.set(
          from.x + (targetX - from.x) * progress,
          pathBaseY + Math.max(0, Math.min(0.08, arc)),
          from.z + (targetZ - from.z) * progress,
        )
      },
      complete: function () {
        obj.motionBaseY = targetY
        obj.group.position.set(targetX, targetY, targetZ)
        _animateLanding(obj)
      },
    })
  }

  function _animateLanding(obj) {
    const shadow = obj.contactShadow
    if (!shadow || _reducedMotion) return
    const startX = PIECE_W * 1.06 * 0.92
    const startY = PIECE_D * 1.08 * 0.92
    _startAnimation(obj.motionId + ':landing', {
      duration: 0.12,
      easing: EASE.out,
      update: function (progress) {
        shadow.scale.set(
          startX + (PIECE_W * 1.06 - startX) * progress,
          startY + (PIECE_D * 1.08 - startY) * progress,
          1,
        )
      },
    })
  }

  function _animatePieceScale(obj, targetScale, duration, keySuffix) {
    const from = obj.group.scale.x
    _startAnimation(obj.motionId + ':scale', {
      duration,
      easing: EASE.out,
      update: function (progress) {
        const scale = from + (targetScale - from) * progress
        obj.group.scale.set(scale, 1, scale)
      },
      complete: keySuffix === 'release' ? function () { obj.group.scale.set(1, 1, 1) } : null,
    })
  }

  function _syncPendingFeedback(interaction) {
    const pendingId = interaction && interaction.pendingPieceId
    const selectedTargetIds = new Set(interaction && Array.isArray(interaction.selectedTargetPieceIds)
      ? interaction.selectedTargetPieceIds
      : [])
    _pieceObjects.forEach(function (obj, pieceId) {
      const pending = pieceId === pendingId
      const targetSelected = selectedTargetIds.has(pieceId)
      const feedbackState = pending ? 'pending' : (targetSelected ? 'target-selected' : 'none')
      if (obj.pendingFeedbackState === feedbackState) return
      obj.pendingFeedbackState = feedbackState
      obj.pending = pending
      obj.targetSelected = targetSelected
      if (pending || targetSelected) {
        obj.feedbackRing.material.color.setHex(pending ? 0xf59e0b : 0x60a5fa)
        obj.feedbackRing.material.opacity = 0.58
        obj.body.material.emissiveIntensity = pending ? 0.24 : 0.12
        if (!_reducedMotion && !_anims.has(obj.motionId + ':position')) obj.group.position.y = obj.baseY + 0.04
      } else {
        obj.feedbackRing.material.opacity = 0
        obj.body.material.emissiveIntensity = 0.08
        if (!_anims.has(obj.motionId + ':position') && !obj.deathAnimating) obj.group.position.y = obj.baseY
      }
    })
  }

  function _pressFeedbackAt(pointerId, clientX, clientY) {
    _releasePressedFeedback()
    const piece = _findPieceFromPointer(clientX, clientY)
    if (piece) {
      const obj = _pieceObjects.get(piece.id)
      if (!obj) return
      _pressedPiece = { pointerId, obj }
      if (_reducedMotion) _flashOutline(obj, 0x60a5fa, MOTION_SECONDS.press)
      else _animatePieceScale(obj, 0.96, MOTION_SECONDS.press, 'press')
      return
    }
    const coords = screenToCell(clientX, clientY)
    if (!coords) return
    const key = coords.x + ',' + coords.y
    ;['move', 'skill', 'place'].some(function (kind) {
      const entry = _hlObjects[kind].get(key)
      if (!entry) return false
      const mesh = entry.mesh
      _pressedHighlight = { pointerId, mesh, kind, key }
      if (!_reducedMotion) {
        const fromScale = mesh.scale.x
        _startAnimation('highlight:' + kind + ':' + key + ':scale', {
          duration: MOTION_SECONDS.press,
          easing: EASE.out,
          update: function (progress) {
            const scale = fromScale + (0.97 - fromScale) * progress
            mesh.scale.set(scale, scale, 1)
          },
        })
      }
      return true
    })
  }

  function _releasePressedFeedback(pointerId) {
    if (_pressedPiece && (pointerId == null || _pressedPiece.pointerId === pointerId)) {
      const obj = _pressedPiece.obj
      _pressedPiece = null
      if (!_reducedMotion) _animatePieceScale(obj, 1, MOTION_SECONDS.fast, 'release')
    }
    if (_pressedHighlight && (pointerId == null || _pressedHighlight.pointerId === pointerId)) {
      const pressed = _pressedHighlight
      _pressedHighlight = null
      const from = pressed.mesh.scale.x
      _startAnimation('highlight:' + pressed.kind + ':' + pressed.key + ':scale', {
        duration: MOTION_SECONDS.press,
        easing: EASE.out,
        update: function (progress) {
          const scale = from + (1 - from) * progress
          pressed.mesh.scale.set(scale, scale, 1)
        },
      })
    }
  }

  function _flashOutline(obj, color, duration) {
    if (!obj || !obj.feedbackRing || !obj.feedbackRing.material) return
    const material = obj.feedbackRing.material
    const fromOpacity = material.opacity
    const fromColor = material.color && material.color.getHex ? material.color.getHex() : color
    const resultDuration = _reducedMotion ? Math.min(duration, MOTION_SECONDS.fast) : duration
    const mixHex = function (start, end, progress) {
      const sr = (start >> 16) & 0xff, sg = (start >> 8) & 0xff, sb = start & 0xff
      const er = (end >> 16) & 0xff, eg = (end >> 8) & 0xff, eb = end & 0xff
      const r = Math.round(sr + (er - sr) * progress)
      const g = Math.round(sg + (eg - sg) * progress)
      const b = Math.round(sb + (eb - sb) * progress)
      return (r << 16) | (g << 8) | b
    }
    const finalise = function () {
      material.color.setHex(0xf59e0b)
      material.opacity = obj.pending ? 0.58 : 0
    }
    _startAnimation(obj.motionId + ':outline', {
      duration: resultDuration,
      easing: EASE.out,
      update: function (progress, raw) {
        const timeline = Number.isFinite(raw) ? raw : progress
        const rising = timeline <= 0.45
        const phase = rising ? EASE.out(timeline / 0.45) : EASE.in((timeline - 0.45) / 0.55)
        const baseOpacity = obj.pending ? 0.58 : 0
        material.color.setHex(mixHex(fromColor, color, Math.min(1, progress * 2)))
        material.opacity = rising
          ? fromOpacity + (0.78 - fromOpacity) * phase
          : 0.78 + (baseOpacity - 0.78) * phase
      },
      complete: finalise,
    })
  }

  function _animateHit(obj) {
    _flashOutline(obj, 0xffffff, MOTION_SECONDS.hit)
    if (_reducedMotion) return
    const from = obj.group.scale.x
    _startAnimation(obj.motionId + ':scale', {
      duration: MOTION_SECONDS.hit,
      easing: EASE.out,
      update: function (progress) {
        const scale = progress < 0.45
          ? from + (0.94 - from) * (progress / 0.45)
          : 0.94 + 0.06 * ((progress - 0.45) / 0.55)
        obj.group.scale.set(scale, scale, scale)
      },
      complete: function () { obj.group.scale.set(1, 1, 1) },
    })
  }

  function _animateHeal(obj) {
    _flashOutline(obj, 0x4ade80, MOTION_SECONDS.heal)
  }

  function _animateStatusChange(obj) {
    _flashOutline(obj, 0x67e8f9, MOTION_SECONDS.fast)
  }

  function _animateSummon(obj) {
    obj.group.visible = true
    _cancelAnimation(obj.motionId + ':visibility')
    if (_reducedMotion) {
      _restorePieceVisual(obj)
      _flashOutline(obj, 0xa78bfa, MOTION_SECONDS.fast)
      return
    }
    const materials = _ownedPieceMaterials(obj)
    materials.forEach(function (material) {
      material.transparent = true
      material.opacity = 0
    })
    obj.group.scale.set(0.82, 0.82, 0.82)
    obj.group.position.y = obj.baseY - 0.04
    _startAnimation(obj.motionId + ':summon', {
      duration: MOTION_SECONDS.result,
      easing: EASE.out,
      update: function (progress) {
        const scale = 0.82 + 0.18 * progress
        obj.group.scale.set(scale, scale, scale)
        obj.group.position.y = obj.baseY - 0.04 + 0.04 * progress
        materials.forEach(function (material) { material.opacity = progress })
      },
      complete: function () {
        _restorePieceVisual(obj)
        _flashOutline(obj, 0xa78bfa, MOTION_SECONDS.fast)
      },
      cancel: function () { _restorePieceVisual(obj) },
    })
  }

  function _ownedPieceMaterials(obj) {
    return [obj.body.material, obj.portraitMesh.material, obj.ring.material, obj.markerMaterial]
      .filter(function (material, index, materials) { return material && materials.indexOf(material) === index })
  }

  function _restorePieceVisual(obj) {
    obj.group.scale.set(1, 1, 1)
    obj.group.position.set(obj.baseX, obj.baseY + (obj.pending && !_reducedMotion ? 0.04 : 0), obj.baseZ)
    _ownedPieceMaterials(obj).forEach(function (material) {
      material.opacity = 1
      material.transparent = false
    })
    if (obj.body.material.color) obj.body.material.color.setHex(0x22272d)
    if (obj.body.material.emissive) obj.body.material.emissive.setHex(FACTION_COLORS[obj.faction] || FACTION_COLORS.red)
    obj.body.material.emissiveIntensity = obj.pending ? 0.24 : (obj.targetSelected ? 0.12 : 0.08)
    if (obj.ring.material.color) obj.ring.material.color.setHex(FACTION_COLORS[obj.faction] || FACTION_COLORS.red)
    if (obj.ring.material.emissive) obj.ring.material.emissive.setHex(FACTION_COLORS[obj.faction] || FACTION_COLORS.red)
    obj.ring.material.emissiveIntensity = 0.3
    if (obj.markerMaterial.color) obj.markerMaterial.color.setHex(0xf2e8d5)
    if (obj.feedbackRing && obj.feedbackRing.material) {
      if (obj.pending) {
        if (obj.feedbackRing.material.color) obj.feedbackRing.material.color.setHex(0xf59e0b)
        obj.feedbackRing.material.opacity = 0.58
      } else if (obj.targetSelected) {
        if (obj.feedbackRing.material.color) obj.feedbackRing.material.color.setHex(0x67e8f9)
        obj.feedbackRing.material.opacity = 0.58
      } else {
        obj.feedbackRing.material.opacity = 0
      }
    }
  }

  function _animateDeath(obj) {
    _cancelAnimation(obj.motionId + ':position')
    _cancelAnimation(obj.motionId + ':scale')
    obj.deathAnimating = true
    obj.group.visible = true
    const fromY = obj.group.position.y
    const materials = _ownedPieceMaterials(obj)
    materials.forEach(function (material) { material.transparent = true })
    if (obj.body.material.color) obj.body.material.color.setHex(0x59616a)
    if (obj.body.material.emissive) obj.body.material.emissive.setHex(0x30363d)
    const duration = _reducedMotion ? MOTION_SECONDS.fast : MOTION_SECONDS.result
    _startAnimation(obj.motionId + ':visibility', {
      duration,
      easing: EASE.in,
      update: function (progress) {
        materials.forEach(function (material) { material.opacity = 1 - progress })
        if (!_reducedMotion) obj.group.position.y = fromY - 0.06 * progress
      },
      complete: function () {
        obj.group.visible = false
        obj.deathAnimating = false
        _restorePieceVisual(obj)
      },
      cancel: function () {
        obj.deathAnimating = false
        _restorePieceVisual(obj)
      },
    })
  }

  function _animateAttackerLunge(sourceId, targetId) {
    if (_reducedMotion) return
    const source = _pieceObjects.get(sourceId)
    const target = _pieceObjects.get(targetId)
    if (!source || !target || _anims.has(source.motionId + ':position')) return
    const from = { x: source.group.position.x, y: source.group.position.y, z: source.group.position.z }
    const dx = target.group.position.x - from.x
    const dz = target.group.position.z - from.z
    const distance = Math.hypot(dx, dz) || 1
    const offsetX = dx / distance * 0.10
    const offsetZ = dz / distance * 0.10
    _startAnimation(source.motionId + ':position', {
      duration: 0.19,
      easing: function (progress) { return progress },
      update: function (_, raw) {
        const phase = raw <= (0.09 / 0.19)
          ? EASE.out(raw / (0.09 / 0.19))
          : 1 - EASE.in((raw - (0.09 / 0.19)) / (0.10 / 0.19))
        source.group.position.set(from.x + offsetX * phase, from.y, from.z + offsetZ * phase)
      },
      complete: function () { source.group.position.set(from.x, from.y, from.z) },
      cancel: function () {
        if (!_anims.has(source.motionId + ':position')) source.group.position.set(from.x, from.y, from.z)
      },
    })
  }

  function getMotionDiagnostics() {
    return {
      activeAnimations: Array.from(_anims.keys()).sort(),
      playedEventCount: _playedEventKeys.size,
      floaterCount: _floaters.size,
      pendingPieceIds: Array.from(_pieceObjects.values()).filter(function (obj) { return obj.pending }).map(function (obj) { return obj.id }).sort(),
      pendingAppearanceCues: Array.from(_pendingAppearanceCues.entries()).map(function (entry) { return entry[0] + ':' + entry[1] }).sort(),
      presentationAreaCellCount: _presentationAreaFlash ? _presentationAreaFlash.cellCount : 0,
      presentationPath: _presentationPath ? {
        source: _presentationPath.source,
        end: _presentationPath.end,
        selected: _presentationPath.selected,
      } : null,
      tutorialCueCellCount: _tutorialCueCellCount,
      tutorialCuePathCount: _tutorialCuePathCount,
      highlightCounts: {
        move: _hlObjects.move.size,
        skill: _hlObjects.skill.size,
        place: _hlObjects.place.size,
        selected: _hlObjects.selected ? 1 : 0,
        historyPoints: _historyHighlightPointCount,
        historyPaths: _historyHighlightPathCount,
      },
    }
  }

  function getPerformanceDiagnostics() {
    return {
      renderCount: _renderCount,
      lastDrawCalls: _lastDrawCalls,
      frameScheduled: _animFrameId != null,
      activeAnimationCount: _anims.size,
      terrainBatchCount: _tileBatches.size,
      terrainInstanceCount: Array.from(_tileBatches.values()).reduce(function (total, batch) {
        return total + Number(batch.count || 0)
      }, 0),
    }
  }

  // ── Camera controls ───────────────────────────────────────────────────────────
  let _panStart = null
  let _panMoved = false
  let _pinchDist = 0
  let _pieceDrag = null
  const _pointers = new Map()

  function _listen(target, type, handler, options) {
    target.addEventListener(type, handler, options)
    _listeners.push({ target, type, handler, options })
  }

  function _removeAllListeners() {
    _listeners.splice(0).forEach(function (entry) {
      entry.target.removeEventListener(entry.type, entry.handler, entry.options)
    })
  }

  function _panCameraByPixels(dx, dy) {
    if (!_camera || !_cameraTarget || !_renderer) return
    const rect = _renderer.domElement.getBoundingClientRect()
    const canvasWidth = _renderer.domElement.getBoundingClientRect().width || 1
    const canvasHeight = rect.height || 1
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    const from = _groundPointFromClient(centerX, centerY)
    const to = _groundPointFromClient(centerX + dx, centerY + dy)
    let deltaX
    let deltaZ
    if (from && to) {
      deltaX = from.x - to.x
      deltaZ = from.z - to.z
    } else {
      const worldPerPixelX = ((_camera.right - _camera.left) / _camera.zoom) / canvasWidth
      const worldPerPixelY = ((_camera.top - _camera.bottom) / _camera.zoom) / canvasHeight
      const screenRight3 = new THREE.Vector3(1, 0, 0).applyQuaternion(_camera.quaternion)
      const screenUp3 = new THREE.Vector3(0, 1, 0).applyQuaternion(_camera.quaternion)
      const fallback = TacticalGeometry.screenPanDelta({
        dx,
        dy,
        worldPerPixelX,
        worldPerPixelY,
        screenRight: { x: screenRight3.x, z: screenRight3.z },
        screenUp: { x: screenUp3.x, z: screenUp3.z },
      })
      deltaX = fallback.x
      deltaZ = fallback.z
    }
    const clamped = TacticalGeometry.clampTarget({
      x: _cameraTarget.x + deltaX,
      z: _cameraTarget.z + deltaZ,
      mapWidth: _mapW,
      mapHeight: _mapH,
    })
    _cameraTarget.set(clamped.x, 0, clamped.z)
    _positionCameraFromTarget()
    _notifyViewportChange()
  }

  function _groundPointFromClient(clientX, clientY) {
    const canvas = _renderer.domElement
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1
    _raycaster.setFromCamera({ x: ndcX, y: ndcY }, _camera)
    const vertical = _raycaster.ray.direction.y
    if (Math.abs(vertical) < 0.000001) return null
    const distance = -_raycaster.ray.origin.y / vertical
    if (distance < 0) return null
    return _raycaster.ray.origin.clone().add(_raycaster.ray.direction.clone().multiplyScalar(distance))
  }

  function _pieceDragCandidateAt(pointerId, clientX, clientY) {
    const selection = _currentModel && _currentModel.selection
    if (!selection || selection.mode !== 'move' || !selection.pieceId) return null
    if (!_currentModel.legal || !Array.isArray(_currentModel.legal.moveCells) || !_currentModel.legal.moveCells.length) return null
    const piece = _findPieceFromPointer(clientX, clientY)
    if (!piece || piece.id !== selection.pieceId) return null
    const obj = _pieceObjects.get(piece.id)
    if (!obj || obj.pending || _anims.has(obj.motionId + ':position')) return null
    return {
      pointerId: pointerId,
      pieceId: piece.id,
      obj: obj,
      originX: clientX,
      originY: clientY,
      active: false,
    }
  }

  function _restorePieceDragVisual() {
    if (!_pieceDrag || !_pieceDrag.obj) return
    const obj = _pieceDrag.obj
    obj.group.position.set(
      obj.baseX,
      obj.baseY + (obj.pending && !_reducedMotion ? 0.04 : 0),
      obj.baseZ,
    )
    _updateSelectedRingPosition()
    _summaryPositionsDirty = true
    _invalidate()
  }

  function _cancelPieceDrag() {
    _restorePieceDragVisual()
    _pieceDrag = null
  }

  function _movePieceDrag(e) {
    if (!_pieceDrag || _pieceDrag.pointerId !== e.pointerId) return false
    const distance = Math.hypot(e.clientX - _pieceDrag.originX, e.clientY - _pieceDrag.originY)
    if (!_pieceDrag.active && distance >= PAN_ACTIVATION_PX) {
      _pieceDrag.active = true
      _releasePressedFeedback(e.pointerId)
    }
    if (!_pieceDrag.active) return true
    const point = _groundPointFromClient(e.clientX, e.clientY)
    if (!point) return true
    const x = Math.max(0, Math.min(_mapW - 1, point.x))
    const z = Math.max(0, Math.min(_mapH - 1, point.z))
    const tileX = Math.max(0, Math.min(_mapW - 1, Math.round(x)))
    const tileZ = Math.max(0, Math.min(_mapH - 1, Math.round(z)))
    _pieceDrag.obj.group.position.set(x, _tileSurfaceHeightAt(tileX, tileZ) + 0.08, z)
    _updateSelectedRingPosition()
    _summaryPositionsDirty = true
    _invalidate()
    return true
  }

  function _initControls() {
    const canvas = _renderer.domElement
    canvas.style.touchAction = 'none'

    _listen(canvas, 'pointerdown', e => {
      // Right-click is reserved for piece inspection. Never let it enter the
      // pan/pinch state: browsers may omit the matching pointerup when the
      // context menu is suppressed, leaving a stale pointer that pans the
      // board before the next inspection attempt.
      if (e.pointerType === 'mouse' && e.button !== 0) return
      if (_pointers.size >= 2) return
      _pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (_pointers.size === 1) {
        _panStart = { x: e.clientX, y: e.clientY, originX: e.clientX, originY: e.clientY }
        _panMoved = false
        _pieceDrag = _pieceDragCandidateAt(e.pointerId, e.clientX, e.clientY)
        _pressFeedbackAt(e.pointerId, e.clientX, e.clientY)
        if (typeof canvas.setPointerCapture === 'function') canvas.setPointerCapture(e.pointerId)
      } else if (_pointers.size === 2) {
        _cancelPieceDrag()
        _pinchDist = _getPinchDist()
        _panStart = null
        _releasePressedFeedback()
      }
      e.preventDefault()
    }, { passive: false })

    _listen(canvas, 'pointermove', e => {
      if (!_pointers.has(e.pointerId)) return
      _pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (_pointers.size === 2) {
        _cancelPieceDrag()
        const d = _getPinchDist()
        if (_pinchDist > 0 && d > 0) {
          _applyZoom(_camera.zoom * (d / _pinchDist))
        }
        _pinchDist = d
        _panMoved = true
        e.preventDefault()
        return
      }

      if (_movePieceDrag(e)) {
        e.preventDefault()
        return
      }

      if (_panStart) {
        const dx = e.clientX - _panStart.x
        const dy = e.clientY - _panStart.y
        const totalDx = e.clientX - _panStart.originX
        const totalDy = e.clientY - _panStart.originY
        if (_panMoved || Math.hypot(totalDx, totalDy) >= PAN_ACTIVATION_PX) {
          _panMoved = true
          _releasePressedFeedback()
          _panCameraByPixels(dx, dy)
          _panStart.x = e.clientX
          _panStart.y = e.clientY
        }
      }
      e.preventDefault()
    }, { passive: false })

    const endPointer = (e, allowClick) => {
      const completedPieceDrag = _pieceDrag && _pieceDrag.pointerId === e.pointerId && _pieceDrag.active
        ? { pieceId: _pieceDrag.pieceId, cell: allowClick ? screenToCell(e.clientX, e.clientY) : null }
        : null
      const wasClick = !_panMoved && _pointers.size === 1
      _releasePressedFeedback(e.pointerId)
      if (_pieceDrag && _pieceDrag.pointerId === e.pointerId) _cancelPieceDrag()
      if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      _pointers.delete(e.pointerId)
      if (_pointers.size < 2) _pinchDist = 0
      if (_pointers.size === 1) {
        const remaining = Array.from(_pointers.values())[0]
        _panStart = { x: remaining.x, y: remaining.y, originX: remaining.x, originY: remaining.y }
        _panMoved = true
      } else if (!_pointers.size) {
        _panStart = null
      }
      if (completedPieceDrag) {
        if (allowClick && _onIntent) {
          _onIntent({
            type: 'drop-piece',
            pieceId: completedPieceDrag.pieceId,
            x: completedPieceDrag.cell ? completedPieceDrag.cell.x : null,
            y: completedPieceDrag.cell ? completedPieceDrag.cell.y : null,
          })
        }
        return
      }
      if (allowClick && wasClick) _handleClick(e)
    }
    _listen(canvas, 'pointerup', e => endPointer(e, true))
    _listen(canvas, 'pointercancel', e => endPointer(e, false))

    _listen(canvas, 'wheel', e => {
      _applyZoom(_camera.zoom * (e.deltaY < 0 ? 1.12 : 0.89))
      e.preventDefault()
    }, { passive: false })

    _listen(canvas, 'dblclick', () => _resetCamera())

    _listen(canvas, 'contextmenu', e => {
      e.preventDefault()
      _resetPointerState(canvas)
      let piece = _findPieceFromPointer(e.clientX, e.clientY)
      if (!piece) {
        const coords = screenToCell(e.clientX, e.clientY)
        if (coords) piece = _findPieceAt(coords.x, coords.y)
      }
      if (piece && _onIntent) _onIntent({ type: 'inspect-piece', pieceId: piece.id })
    })
    _listen(window, 'blur', function () { _resetPointerState(canvas) })
  }

  function _resetPointerState(canvas) {
    _releasePressedFeedback()
    _cancelPieceDrag()
    _pointers.forEach(function (_, pointerId) {
      if (canvas && canvas.hasPointerCapture && canvas.hasPointerCapture(pointerId)) {
        canvas.releasePointerCapture(pointerId)
      }
    })
    _pointers.clear()
    _panStart = null
    _panMoved = false
    _pinchDist = 0
  }

  function _getPinchDist() {
    const pts = Array.from(_pointers.values())
    if (pts.length < 2) return 0
    const dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y
    return Math.sqrt(dx * dx + dy * dy)
  }

  function _applyZoom(z) {
    const w = _container.clientWidth || 320
    const h = _container.clientHeight || 320
    _camera.zoom = Math.max(_minimumUsableZoom(w, h), Math.min(MAX_CAMERA_ZOOM, z))
    _camera.updateProjectionMatrix()
    _notifyViewportChange()
  }

  function _resetCamera() {
    if (!_mapW) return
    const w = _container.clientWidth || 320
    const h = _container.clientHeight || 320
    const pose = TacticalGeometry.cameraPose({ mapWidth: _mapW, mapHeight: _mapH })
    _cameraTarget.set(pose.target.x, pose.target.y, pose.target.z)
    _positionCameraFromTarget()
    _updateCameraProjection(w, h)
    _camera.zoom = _preferredInitialZoom(w, h)
    _camera.updateProjectionMatrix()
    _notifyViewportChange()
  }

  function resetView() { _resetCamera() }

  // ── Raycasting ────────────────────────────────────────────────────────────────
  const _raycaster = new THREE.Raycaster()

  function screenToCell(clientX, clientY) {
    if (!_hitPlane || !_renderer || !_camera) return null
    const canvas = _renderer.domElement
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1
    _raycaster.setFromCamera({ x: ndcX, y: ndcY }, _camera)
    const tileHits = _raycaster.intersectObjects(Array.from(_tileBatches.values()), false)
    if (tileHits.length) {
      const hit = tileHits[0]
      const tile = hit.object.userData.cells && hit.object.userData.cells[hit.instanceId]
      const tileX = Number(tile && tile.x)
      const tileY = Number(tile && tile.y)
      if (tileX >= 0 && tileY >= 0 && tileX < _mapW && tileY < _mapH) return { x: tileX, y: tileY }
    }
    const hits = _raycaster.intersectObject(_hitPlane)
    if (!hits.length) return null
    const pt = hits[0].point
    const roundedX = Math.round(pt.x)
    const roundedY = Math.round(pt.z)
    const x = Object.is(roundedX, -0) ? 0 : roundedX
    const y = Object.is(roundedY, -0) ? 0 : roundedY
    if (x < 0 || y < 0 || x >= _mapW || y >= _mapH) return null
    return { x, y }
  }

  function projectCell(x, y, elevation) {
    if (!_renderer || !_camera || !_container) return null
    const canvasRect = _renderer.domElement.getBoundingClientRect()
    const containerRect = _container.getBoundingClientRect()
    const point = new THREE.Vector3(x, elevation == null ? _tileSurfaceHeightAt(x, y) : elevation, y).project(_camera)
    const clientX = canvasRect.left + (point.x + 1) / 2 * canvasRect.width
    const clientY = canvasRect.top + (-point.y + 1) / 2 * canvasRect.height
    return {
      left: clientX - containerRect.left,
      top: clientY - containerRect.top,
      clientX,
      clientY,
    }
  }

  function _handleClick(e) {
    const coords = screenToCell(e.clientX, e.clientY)
    if (!coords) return
    if (_onIntent) _onIntent({ type: 'activate-cell', x: coords.x, y: coords.y })
  }

  function _findPieceAt(x, y) {
    if (!_currentModel) return null
    return (_currentModel.pieces || []).find(p => p.x === x && p.y === y && p.visible !== false) || null
  }
  function _findPieceFromPointer(clientX, clientY) {
    if (!_currentModel || !_renderer || !_camera) return null
    let closest = null
    let closestDistance = Infinity

    ;(_currentModel.pieces || []).forEach(piece => {
      if (piece.visible === false) return
      const obj = _pieceObjects.get(piece.id)
      const x = obj ? obj.group.position.x : piece.x
      const y = obj ? obj.group.position.z : piece.y
      const point = projectCell(x, y, (obj ? obj.group.position.y : _tileSurfaceHeightAt(x, y)) + PIECE_H + 0.014)
      if (!point) return
      const dx = clientX - point.clientX
      const dy = clientY - point.clientY
      const distance = Math.sqrt(dx * dx + dy * dy)
      const hitRadius = Math.max(22, _projectedCellSpan(x, y) * 0.55)
      if (distance > hitRadius || distance >= closestDistance) return
      closest = piece
      closestDistance = distance
    })

    return closest
  }

  // ── update — one-way presentation model input ─────────────────────────────────
  function update(model) {
    if (!model || !model.board || !_mounted) return

    // Build / update tiles on first call or map change
    const mapKey = model.board.id + ':' + model.board.width + 'x' + model.board.height
    if (!_currentModel || !_currentModel.board || _currentModel.board.id + ':' + _currentModel.board.width + 'x' + _currentModel.board.height !== mapKey) {
      _buildTiles(model.board)
    }

    _updatePieces(model.pieces || [])
    _updateTileEffects(model.effects || [])
    setHighlights({
      move: model.legal && model.legal.moveCells,
      skill: model.legal && model.legal.targetCells,
      place: model.legal && model.legal.placementCells,
      selected: model.selection && model.selection.pieceId,
    })
    _currentModel = model
    _syncPendingFeedback(model.interaction || {})
    _summaryPositionsDirty = true
    _invalidate()
  }

  // ── spawnFloater ─────────────────────────────────────────────────────────────
  function spawnFloater(x, z, text, color, big, options) {
    options = options || {}
    // Find the floatLayer: use the existing one in the DOM if available
    const layer = _floatLayer || document.getElementById('floatLayer')
    if (!layer) return
    let left = x * 44 + 22  // fallback pixel estimate
    let top  = z * 44 + 4

    const projected = projectCell(x, z, _tileSurfaceHeightAt(x, z) + PIECE_H + 0.2)
    if (projected) {
      left = projected.left
      top = projected.top - 14
    }

    const el = document.createElement('div')
    const kind = options.kind === 'heal' || options.kind === 'death' ? options.kind : 'damage'
    const requestedDuration = Number(options.durationMs) || (kind === 'heal' ? 550 : 600)
    const durationMs = _reducedMotion ? Math.min(140, requestedDuration) : Math.max(480, Math.min(650, requestedDuration))
    el.className = 'dmg-float is-' + kind + (big ? ' big' : '')
    el.style.color = color
    el.style.left  = left + 'px'
    el.style.top   = top  + 'px'
    el.style.setProperty('--floater-duration', durationMs + 'ms')
    el.textContent = text
    layer.appendChild(el)
    _floaters.add(el)
    const timer = setTimeout(function () {
      el.remove()
      _floaters.delete(el)
      _floaterTimers.delete(timer)
    }, durationMs + 80)
    _floaterTimers.add(timer)
  }

  // ── Dispose ───────────────────────────────────────────────────────────────────
  function dispose() {
    _textureLoadGeneration += 1
    _mounted = false
    if (_animFrameId != null) cancelAnimationFrame(_animFrameId)
    _animFrameId = null
    if (_resizeObserver) _resizeObserver.disconnect()
    _resizeObserver = null
    if (_renderer) _resetPointerState(_renderer.domElement)
    _removeAllListeners()
    _clearHistoryHighlight()
    clearTutorialCue()
    if (_hpLayer && _hpLayer.parentNode) _hpLayer.remove()
    if (_scene) {
      const geometries = new Set()
      const materials = new Set()
      _scene.traverse(function (object) {
        if (object.geometry) geometries.add(object.geometry)
        if (object.material) {
          ;(Array.isArray(object.material) ? object.material : [object.material]).forEach(function (material) { materials.add(material) })
        }
      })
      ;[_tileGeom, _hlPlaneGeom, _selectedRingGeom, _pieceBodyGeom, _pieceRingGeom, _portraitDiscGeom, _contactShadowGeom]
        .forEach(function (geometry) { if (geometry) geometries.add(geometry) })
      if (_contactShadowMat) materials.add(_contactShadowMat)
      ;[_tileMats, _factionMats, _hlMats, _tileEffectMats, _tileEffectIconMats].forEach(function (cache) {
        Object.keys(cache).forEach(function (key) { if (cache[key]) materials.add(cache[key]) })
      })
      geometries.forEach(function (geometry) { if (geometry.dispose) geometry.dispose() })
      materials.forEach(function (material) { if (material.dispose) material.dispose() })
    }
    _texCache.forEach(function (entry) { if (entry && entry.texture && entry.texture.dispose) entry.texture.dispose() })
    if (_renderer) {
      _renderer.dispose()
      if (_renderer.forceContextLoss) _renderer.forceContextLoss()
      if (_renderer.domElement.parentNode) _renderer.domElement.remove()
    }
    _tileObjects.clear()
    _tileBatches.clear()
    _pieceObjects.forEach(function (obj) {
      obj.statusExitTimers.forEach(function (timer) { clearTimeout(timer) })
      obj.statusExitTimers.clear()
    })
    _pieceObjects.clear()
    _tileEffectObjects.clear()
    Object.keys(_tileMats).forEach(function (key) { delete _tileMats[key] })
    Object.keys(_factionMats).forEach(function (key) { delete _factionMats[key] })
    Object.keys(_hlMats).forEach(function (key) { delete _hlMats[key] })
    Object.keys(_tileEffectMats).forEach(function (key) { delete _tileEffectMats[key] })
    Object.keys(_tileEffectIconMats).forEach(function (key) { delete _tileEffectIconMats[key] })
    _anims.clear()
    _playedEventKeys.clear()
    _playedEventOrder.length = 0
    _pendingAppearanceCues.clear()
    _presentationAreaFlash = null
    _presentationPath = null
    _pressedPiece = null
    _pressedHighlight = null
    _pieceDrag = null
    _hlObjects.move.clear()
    _hlObjects.skill.clear()
    _hlObjects.place.clear()
    _hlObjects.selected = null
    _hlObjects.selectedId = null
    _historyHighlightGroup = null
    _historyHighlightPointCount = 0
    _historyHighlightPathCount = 0
    _tutorialCueGroup = null
    _tutorialCueCellCount = 0
    _tutorialCuePathCount = 0
    _floaterTimers.forEach(function (timer) { clearTimeout(timer) })
    _floaterTimers.clear()
    _floaters.forEach(function (element) { element.remove() })
    _floaters.clear()
    _texCache.clear()
    _pointers.clear()
    _renderer = null
    _camera = null
    _cameraTarget = null
    _scene = null
    _hpLayer = null
    _floatLayer = null
    _onIntent = null
    _hitPlane = null
    _currentModel = null
    _mapW = 0
    _mapH = 0
    _boardBase = null
    _boardFront = null
    _tileGeom = null
    _hlPlaneGeom = null
    _selectedRingGeom = null
    _pieceBodyGeom = null
    _pieceRingGeom = null
    _portraitDiscGeom = null
    _contactShadowGeom = null
    _contactShadowMat = null
    _clock.prev = 0
    _summaryPositionsDirty = true
    _renderCount = 0
    _lastDrawCalls = 0
    _panStart = null
    _panMoved = false
    _pinchDist = 0
    _container = null
    _motionQuery = null
    _reducedMotion = false
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  window.BattleRenderer3D = {
    init,
    update,
    animateAction,
    spawnFloater,
    resize,
    resetView,
    projectCell,
    setHistoryHighlight,
    setTutorialCue,
    clearTutorialCue,
    screenToCell,
    showPresentationAreaFlash,
    clearPresentationAreaFlash: _clearPresentationAreaFlash,
    showPresentationPath,
    clearPresentationPath: _clearPresentationPath,
    dispose,
    getMotionDiagnostics,
    getPerformanceDiagnostics,
    TILE_EFFECT_VISUALS,
    MOTION_TOKENS,
  }
})()
