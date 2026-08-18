;(function () {
  'use strict'

  // ── Requires THREE global (r134) loaded before this script ───────────────────

  // ── Constants ────────────────────────────────────────────────────────────────
  const TILE_H = 0.10      // tile box height
  const TILE_W = 0.90      // tile box width/depth (0.1 gap gives grid lines)
  const PIECE_R = 0.36     // piece cylinder radius
  const PIECE_H = 0.22     // piece cylinder height
  const RING_R  = 0.40     // faction ring radius
  const RING_T  = 0.045    // faction ring tube radius
  const SELECTED_RING_R = 0.445
  const SELECTED_RING_T = 0.018

  const TILE_COLORS = {
    floor:     0x374151,
    wall:      0x111827,
    spawn:     0x052e16,
    cover:     0x78350f,
    hole:      0x082f49,
    lava:      0x7c2d12,
    spring:    0x134e4a,
    chargepad: 0x3b0764,
    trap:      0x451a03,
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
    'flying-raijin-anchor': Object.freeze({ color: 0x38bdf8, colorCss: '#7dd3fc', bg: 'rgba(8,47,73,.78)', border: '#38bdf8', icon: 'images/tile-effects/flying-raijin-anchor.svg' }),
    'shadow-step': Object.freeze({ color: 0xa855f7, colorCss: '#d8b4fe', bg: 'rgba(88,28,135,.72)', border: '#a855f7', icon: 'images/tile-effects/shadow-step.svg' }),
    'lethal-toxin': Object.freeze({ color: 0x4ade80, colorCss: '#86efac', bg: 'rgba(20,83,45,.76)', border: '#4ade80', icon: 'images/tile-effects/lethal-toxin.svg' }),
    'amaterasu': Object.freeze({ color: 0xf97316, colorCss: '#fdba74', bg: 'rgba(127,29,29,.72)', border: '#fb923c', icon: 'images/tile-effects/amaterasu.svg' }),
    'blizzard': Object.freeze({ color: 0x67e8f9, colorCss: '#cffafe', bg: 'rgba(14,116,144,.72)', border: '#67e8f9', icon: 'images/tile-effects/blizzard.svg' }),
    'shishio-burn': Object.freeze({ color: 0xfb4934, colorCss: '#fdba74', bg: 'rgba(124,45,18,.75)', border: '#fb4934', icon: 'images/tile-effects/shishio-burn.svg' }),
    'sticky-bomb': Object.freeze({ color: 0xfacc15, colorCss: '#fef08a', bg: 'rgba(113,63,18,.78)', border: '#facc15', icon: 'images/tile-effects/sticky-bomb.svg' }),
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
  let _container = null
  let _hpLayer = null
  let _floatLayer = null
  let _onIntent = null
  function _notifyViewportChange() {
    if (_onIntent) _onIntent({ type: 'viewport-change' })
  }
  let _resizeObserver = null
  let _hitPlane = null
  let _mounted = false
  const _listeners = []

  let _mapW = 0, _mapH = 0
  const _tileObjects = new Map()       // "x,z" → THREE.Mesh
  const _pieceObjects = new Map()      // instanceId → {group, body, ring, portraitMesh, labelDiv, targetX, targetZ}
  const _tileEffectObjects = new Map()
  const _hlObjects = { move: [], skill: [], place: [], selected: null }
  const _anims = []                    // {mesh, fromX, fromZ, toX, toZ, elapsed, duration, type, ...}
  const _texCache = new Map()
  let _textureLoadGeneration = 0
  const _floaters = new Set()
  const _floaterTimers = new Set()
  let _currentModel = null
  let _clock = { prev: 0 }

  // ── Geometry / Material cache (shared across all tiles/pieces) ────────────────
  let _tileGeom = null
  let _hlPlaneGeom = null
  let _selectedRingGeom = null
  let _pieceBodyGeom = null
  let _pieceRingGeom = null
  let _portraitDiscGeom = null
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

    // Shared geometries
    _tileGeom       = new THREE.BoxGeometry(TILE_W, TILE_H, TILE_W)
    _hlPlaneGeom    = new THREE.PlaneGeometry(TILE_W - 0.06, TILE_W - 0.06)
    _selectedRingGeom = new THREE.TorusGeometry(SELECTED_RING_R, SELECTED_RING_T, 8, 32)
    _pieceBodyGeom  = new THREE.CylinderGeometry(PIECE_R, PIECE_R, PIECE_H, 24)
    _pieceRingGeom  = new THREE.TorusGeometry(RING_R, RING_T, 8, 32)
    _portraitDiscGeom = new THREE.CircleGeometry(PIECE_R, 24)

    // Scene
    _scene = new THREE.Scene()
    _scene.background = new THREE.Color(0x0a0f1a)

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.55)
    _scene.add(ambient)
    const dirLight = new THREE.DirectionalLight(0xffeedd, 0.75)
    dirLight.position.set(5, 12, 8)
    _scene.add(dirLight)

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

    // Camera (orthographic, top-down)
    _camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200)
    _camera.position.set(0, 50, 0)
    _camera.lookAt(0, 0, 0)
    _camera.up.set(0, 0, -1)

    // Pointer events on canvas
    _initControls()

    // Resize observer
    _resizeObserver = new ResizeObserver(function () { resize() })
    _resizeObserver.observe(_container)

    // Start render loop
    _clock.prev = 0
    _animFrameId = requestAnimationFrame(_tick)
  }

  // ── Resize ───────────────────────────────────────────────────────────────────
  function resize() {
    if (!_renderer || !_container) return
    const w = _container.clientWidth || 320
    const h = _container.clientHeight || 320
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    _renderer.setSize(w, h, false)
    _updateCameraFrustum(w, h)
    _updatePieceSummaryPositions()
    _notifyViewportChange()
  }

  function _fitWorldHalfHeight(w, h) {
    if (!_mapW) return 1
    const aspect = w / (h || 1)
    const halfH = _mapH / 2 + 1
    const halfW = _mapW / 2 + 1
    return Math.max(halfH, halfW / aspect)
  }

  function _minimumUsableZoom(w, h) {
    if (!_mapW) return 1
    const narrowViewport = w <= 760
    const coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches
    if (!narrowViewport && !coarsePointer) return 1
    const pixelsPerCell = h / (_fitWorldHalfHeight(w, h) * 2)
    return Math.max(1, Math.min(1.8, 24 / Math.max(1, pixelsPerCell)))
  }

  function _preferredInitialZoom(w, h) {
    if (!_mapW) return 1
    const aspect = w / (h || 1)
    const visibleWorldWidth = _fitWorldHalfHeight(w, h) * 2 * aspect
    const widthCoverageZoom = (visibleWorldWidth / (_mapW + 2)) * 0.86
    return Math.max(_minimumUsableZoom(w, h), Math.min(1.8, widthCoverageZoom))
  }

  function _updateCameraFrustum(w, h) {
    if (!_camera || !_mapW) return
    const aspect = w / (h || 1)
    const fitH = _fitWorldHalfHeight(w, h)
    _camera.left   = -fitH * aspect
    _camera.right  =  fitH * aspect
    _camera.top    =  fitH
    _camera.bottom = -fitH
    _camera.updateProjectionMatrix()
  }

  // ── Render loop ───────────────────────────────────────────────────────────────
  function _tick(now) {
    if (!_mounted || !_renderer || !_scene || !_camera) return
    _animFrameId = requestAnimationFrame(_tick)
    const dt = Math.min((now - (_clock.prev || now)) / 1000, 0.1)
    _clock.prev = now
    _stepAnims(dt)
    _pulseLava(now / 1000)
    _renderer.render(_scene, _camera)
  }

  function _pulseLava(t) {
    const mat = _tileMats['lava']
    if (mat) mat.emissiveIntensity = 0.30 + Math.sin(t * 2.3) * 0.15
    const cmat = _tileMats['chargepad']
    if (cmat) cmat.emissiveIntensity = 0.20 + Math.sin(t * 1.7) * 0.10
  }

  // ── Tile map ─────────────────────────────────────────────────────────────────
  function _buildTiles(map) {
    // Remove old tiles
    _tileObjects.forEach(m => _scene.remove(m))
    _tileObjects.clear()

    _mapW = map.width
    _mapH = map.height

    map.tiles.forEach(tile => {
      const type = (tile.props && tile.props.type) ? tile.props.type : (tile.type || 'floor')
      const mesh = new THREE.Mesh(_tileGeom, getTileMat(type))
      mesh.position.set(tile.x, 0, tile.y)
      mesh.userData.tileX = tile.x
      mesh.userData.tileZ = tile.y
      _scene.add(mesh)
      _tileObjects.set(tile.x + ',' + tile.y, mesh)
    })

    // Camera target: center of map
    _camera.position.set(_mapW / 2, 50, _mapH / 2)
    _camera.lookAt(_mapW / 2, 0, _mapH / 2)
    _camera.zoom = _preferredInitialZoom(_container.clientWidth || 320, _container.clientHeight || 320)

    // Hit plane for raycasting (invisible, covers full map)
    if (_hitPlane) {
      _scene.remove(_hitPlane)
      if (_hitPlane.geometry) _hitPlane.geometry.dispose()
      if (_hitPlane.material) _hitPlane.material.dispose()
    }
    const hitGeom = new THREE.PlaneGeometry(_mapW + 2, _mapH + 2)
    const hitMat  = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
    const hitPlane = new THREE.Mesh(hitGeom, hitMat)
    hitPlane.rotation.x = -Math.PI / 2
    hitPlane.position.set(_mapW / 2, 0.02, _mapH / 2)
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

      // If not animating, snap to position
      if (!obj.animating) {
        obj.group.position.set(piece.x, 0, piece.y)
      }

      // Faction is snapshot-driven and can change without respawning the mesh.
      if (obj.faction !== piece.faction) {
        obj.faction = piece.faction
        obj.body.material.color.setHex(FACTION_COLORS[piece.faction] || FACTION_COLORS.red)
        obj.ring.material = getFactionMat(piece.faction)
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

      // Show/hide based on alive
      obj.group.visible = piece.visible !== false
    })

    // Remove departed pieces
    _pieceObjects.forEach((obj, id) => {
      if (!seen.has(id)) {
        _scene.remove(obj.group)
        if (obj.body.material && obj.body.material.dispose) obj.body.material.dispose()
        if (obj.portraitMesh.material && obj.portraitMesh.material.dispose) obj.portraitMesh.material.dispose()
        if (obj.summaryEl && obj.summaryEl.parentNode) obj.summaryEl.remove()
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
          ring.position.y = TILE_H / 2 + 0.025 + index * 0.004
          group.add(ring)

          const slot = TILE_EFFECT_ICON_SLOTS[index]
          const icon = new THREE.Sprite(getTileEffectIconMat(effectType))
          icon.position.set(slot.x, TILE_H / 2 + 0.20, slot.z)
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
    group.position.set(piece.x, 0, piece.y)

    // Body cylinder
    const body = new THREE.Mesh(_pieceBodyGeom, new THREE.MeshLambertMaterial({ color: FACTION_COLORS[faction] || 0x888888 }))
    body.position.y = TILE_H / 2 + PIECE_H / 2
    group.add(body)

    // Portrait disc on top
    const portraitMat = new THREE.MeshBasicMaterial({ color: FACTION_COLORS[faction] || 0x888888 })
    const portraitMesh = new THREE.Mesh(_portraitDiscGeom, portraitMat)
    portraitMesh.rotation.x = -Math.PI / 2
    portraitMesh.position.y = TILE_H / 2 + PIECE_H + 0.002
    group.add(portraitMesh)

    // Faction ring at base of cylinder
    const ring = new THREE.Mesh(_pieceRingGeom, getFactionMat(faction))
    ring.rotation.x = Math.PI / 2
    ring.position.y = TILE_H / 2 + 0.02
    group.add(ring)

    // Compact health and negative-status summary.
    const summaryEl = _createPieceSummaryEl(piece)

    _scene.add(group)
    _pieceObjects.set(piece.id, {
      group, body, ring, portraitMesh,
      summaryEl,
      faction,
      portraitLoaded: false,
      portraitLoading: false,
      portraitSrc: '',
      animating: false,
      targetX: piece.x, targetZ: piece.y,
    })
  }

  // ── Piece summary overlay ─────────────────────────────────────────────────────
  function _createPieceSummaryEl(piece) {
    const wrap = document.createElement('div')
    wrap.className = 'piece-board-summary'
    wrap.dataset.pieceId = piece.id

    const health = document.createElement('span')
    health.className = 'piece-board-health'
    const statuses = document.createElement('span')
    statuses.className = 'piece-board-statuses'
    statuses.hidden = true
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
    const summary = presentation
      ? presentation.boardSummary(piece.statusSummary || [])
      : (piece.statusSummary || []).slice(0, 2).map(status => ({ status, meta: { color: '#a78bfa' } }))
    const statuses = obj.summaryEl.querySelector('.piece-board-statuses')
    if (statuses) {
      statuses.replaceChildren()
      summary.forEach(function (entry) {
        const dot = document.createElement('span')
        dot.className = 'piece-board-status-dot'
        dot.style.setProperty('--status-color', entry.meta.color)
        dot.dataset.statusId = entry.status.id || ''
        dot.title = entry.status.label || entry.status.id || ''
        statuses.appendChild(dot)
      })
      statuses.hidden = summary.length === 0
    }

    const statusNames = summary.map(function (entry) { return entry.status.label || entry.status.id }).filter(Boolean)
    const accessible = (piece.name || piece.id) + '\uff0c\u751f\u547d ' + currentHp + ' / ' + maxHp
      + (statusNames.length ? '\uff0c\u8d1f\u9762\u72b6\u6001 ' + statusNames.join('\u3001') : '')
    obj.summaryEl.dataset.health = currentHp + '/' + maxHp
    obj.summaryEl.dataset.statusCount = String(summary.length)
    obj.summaryEl.dataset.statusIds = summary.map(function (entry) { return entry.status.id || '' }).join(',')
    obj.summaryEl.setAttribute('aria-label', accessible)
    obj.summaryEl.title = accessible
    obj.summaryEl.style.display = piece.visible !== false ? '' : 'none'
  }

  function _projectedCellSpan(x, y) {
    const center = projectCell(x, y, TILE_H / 2)
    if (!center) return 36
    const horizontal = projectCell(x + 1, y, TILE_H / 2)
    const vertical = projectCell(x, y + 1, TILE_H / 2)
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
      const projected = projectCell(x, y, TILE_H / 2 + PIECE_H + 0.1)
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
    // hl: { move: [{x,z}], skill: [{x,z}|instanceId], place: [...], selected: instanceId|null }
    _clearHL('move')
    _clearHL('skill')
    _clearHL('place')
    _clearHL('selected')

    _showHL('move',  hl.move  || [])
    _showHL('skill', hl.skill || [])
    _showHL('place', hl.place || [])

    if (hl.selected) {
      const obj = _pieceObjects.get(hl.selected)
      if (obj) {
        const ring = new THREE.Mesh(_selectedRingGeom, getHlMat('selected'))
        ring.rotation.x = Math.PI / 2
        ring.position.copy(obj.group.position)
        ring.position.y = TILE_H / 2 + 0.04
        ring.renderOrder = 5
        _scene.add(ring)
        _hlObjects.selected = ring
      }
    }
  }

  function _clearHL(type) {
    if (type === 'selected') {
      if (_hlObjects.selected) { _scene.remove(_hlObjects.selected); _hlObjects.selected = null }
      return
    }
    _hlObjects[type].forEach(m => _scene.remove(m))
    _hlObjects[type] = []
  }

  function _showHL(type, items) {
    items.forEach(item => {
      let x, z
      if (typeof item === 'string') {
        const parts = item.split(','); x = +parts[0]; z = +parts[1]
      } else if (item && item.x != null) {
        x = item.x; z = item.z ?? item.y ?? 0
      } else return

      const mesh = new THREE.Mesh(_hlPlaneGeom, getHlMat(type))
      mesh.rotation.x = -Math.PI / 2
      mesh.position.set(x, TILE_H / 2 + 0.01, z)
      _scene.add(mesh)
      _hlObjects[type].push(mesh)
    })
  }

  // ── Animation ─────────────────────────────────────────────────────────────────
  function animateAction(action, previousModel, nextModel) {
    if (!action) return
    if (action.type === 'move' && action.pieceId) {
      const obj = _pieceObjects.get(action.pieceId)
      if (obj && action.toX != null && action.toY != null) {
        const fromX = obj.group.position.x
        const fromZ = obj.group.position.z
        obj.animating = true
        _anims.push({ type: 'move', obj, fromX, fromZ, toX: action.toX, toZ: action.toY, elapsed: 0, duration: 0.25 })
      }
    }
    // Damage flash: detect HP changes
    if (previousModel && nextModel && previousModel.pieces && nextModel.pieces) {
      nextModel.pieces.forEach(np => {
        const op = previousModel.pieces.find(p => p.id === np.id)
        if (op && np.health.current < op.health.current) {
          const obj = _pieceObjects.get(np.id)
          if (obj) _anims.push({ type: 'flash', obj, elapsed: 0, duration: 0.3 })
        }
        if (op && op.health.current > 0 && np.health.current <= 0) {
          const obj = _pieceObjects.get(np.id)
          if (obj) _anims.push({ type: 'death', obj, elapsed: 0, duration: 0.6 })
        }
      })
    }
  }

  function _stepAnims(dt) {
    for (let i = _anims.length - 1; i >= 0; i--) {
      const a = _anims[i]
      a.elapsed += dt
      const t = Math.min(a.elapsed / a.duration, 1)

      if (a.type === 'move') {
        const ex = a.fromX + (a.toX - a.fromX) * _ease(t)
        const ez = a.fromZ + (a.toZ - a.fromZ) * _ease(t)
        a.obj.group.position.set(ex, 0, ez)
        _notifyViewportChange()
        if (t >= 1) { a.obj.group.position.set(a.toX, 0, a.toZ); a.obj.animating = false; _anims.splice(i, 1) }
      } else if (a.type === 'flash') {
        const intensity = (1 - t) * 0.8
        a.obj.body.material.emissive = new THREE.Color(0xff2200)
        a.obj.body.material.emissiveIntensity = intensity
        if (t >= 1) { a.obj.body.material.emissiveIntensity = 0; _anims.splice(i, 1) }
      } else if (a.type === 'death') {
        a.obj.group.children.forEach(m => {
          if (m.material) { m.material.transparent = true; m.material.opacity = 1 - t }
        })
        if (t >= 1) { a.obj.group.visible = false; _anims.splice(i, 1) }
      }
    }
    _updatePieceSummaryPositions()
  }

  function _ease(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t }

  // ── Camera controls ───────────────────────────────────────────────────────────
  let _panStart = null
  let _panMoved = false
  let _pinchDist = 0
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

  function _initControls() {
    const canvas = _renderer.domElement
    canvas.style.touchAction = 'none'

    _listen(canvas, 'pointerdown', e => {
      // Right-click is reserved for piece inspection. Never let it enter the
      // pan/pinch state: browsers may omit the matching pointerup when the
      // context menu is suppressed, leaving a stale pointer that pans the
      // board before the next inspection attempt.
      if (e.pointerType === 'mouse' && e.button !== 0) return
      _pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (_pointers.size === 1) {
        _panStart = { x: e.clientX, y: e.clientY }
        _panMoved = false
        if (typeof canvas.setPointerCapture === 'function') canvas.setPointerCapture(e.pointerId)
      } else if (_pointers.size === 2) {
        _pinchDist = _getPinchDist()
        _panStart = null
      }
      e.preventDefault()
    }, { passive: false })

    _listen(canvas, 'pointermove', e => {
      if (!_pointers.has(e.pointerId)) return
      _pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (_pointers.size === 2) {
        const d = _getPinchDist()
        if (_pinchDist > 0 && d > 0) {
          _applyZoom(_camera.zoom * (d / _pinchDist))
        }
        _pinchDist = d
        _panMoved = true
        e.preventDefault()
        return
      }

      if (_panStart) {
        const dx = e.clientX - _panStart.x
        const dy = e.clientY - _panStart.y
        if (Math.abs(dx) + Math.abs(dy) > 4) {
          _panMoved = true
          const canvasWidth = _renderer.domElement.getBoundingClientRect().width || 1
          const fov = ((_camera.right - _camera.left) / _camera.zoom) / canvasWidth
          _camera.position.x -= dx * fov
          _camera.position.z -= dy * fov
          _camera.lookAt(_camera.position.x, 0, _camera.position.z)
          _notifyViewportChange()
          _panStart = { x: e.clientX, y: e.clientY }
        }
      }
      e.preventDefault()
    }, { passive: false })

    const endPointer = (e, allowClick) => {
      const wasClick = !_panMoved && _pointers.size === 1
      _pointers.delete(e.pointerId)
      if (_pointers.size < 2) _pinchDist = 0
      if (_pointers.size === 1) {
        const remaining = Array.from(_pointers.values())[0]
        _panStart = { x: remaining.x, y: remaining.y }
        _panMoved = true
      } else if (!_pointers.size) {
        _panStart = null
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
  }

  function _resetPointerState(canvas) {
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
    _camera.zoom = Math.max(_minimumUsableZoom(w, h), Math.min(5, z))
    _camera.updateProjectionMatrix()
    _updatePieceSummaryPositions()
    _notifyViewportChange()
  }

  function _resetCamera() {
    if (!_mapW) return
    const w = _container.clientWidth || 320
    const h = _container.clientHeight || 320
    _camera.zoom = _preferredInitialZoom(w, h)
    _camera.position.set(_mapW / 2, 50, _mapH / 2)
    _camera.lookAt(_mapW / 2, 0, _mapH / 2)
    _updateCameraFrustum(w, h)
    _updatePieceSummaryPositions()
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
    const hits = _raycaster.intersectObject(_hitPlane)
    if (!hits.length) return null
    const pt = hits[0].point
    const x = Math.round(pt.x)
    const y = Math.round(pt.z)
    if (x < 0 || y < 0 || x >= _mapW || y >= _mapH) return null
    return { x, y }
  }

  function projectCell(x, y, elevation) {
    if (!_renderer || !_camera || !_container) return null
    const canvasRect = _renderer.domElement.getBoundingClientRect()
    const containerRect = _container.getBoundingClientRect()
    const point = new THREE.Vector3(x, elevation == null ? TILE_H / 2 : elevation, y).project(_camera)
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
      const point = projectCell(x, y, TILE_H / 2 + PIECE_H + 0.002)
      if (!point) return
      const dx = clientX - point.clientX
      const dy = clientY - point.clientY
      const distance = Math.sqrt(dx * dx + dy * dy)
      const hitRadius = Math.max(10, _projectedCellSpan(x, y) * 0.55)
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
  }

  // ── spawnFloater ─────────────────────────────────────────────────────────────
  function spawnFloater(x, z, text, color, big) {
    // Find the floatLayer: use the existing one in the DOM if available
    const layer = _floatLayer || document.getElementById('floatLayer')
    if (!layer) return
    let left = x * 44 + 22  // fallback pixel estimate
    let top  = z * 44 + 4

    const projected = projectCell(x, z, TILE_H / 2 + PIECE_H + 0.2)
    if (projected) {
      left = projected.left
      top = projected.top - 14
    }

    const el = document.createElement('div')
    el.className = 'dmg-float' + (big ? ' big' : '')
    el.style.color = color
    el.style.left  = left + 'px'
    el.style.top   = top  + 'px'
    el.textContent = text
    layer.appendChild(el)
    _floaters.add(el)
    const timer = setTimeout(function () {
      el.remove()
      _floaters.delete(el)
      _floaterTimers.delete(timer)
    }, 1200)
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
    _removeAllListeners()
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
      ;[_tileGeom, _hlPlaneGeom, _selectedRingGeom, _pieceBodyGeom, _pieceRingGeom, _portraitDiscGeom]
        .forEach(function (geometry) { if (geometry) geometries.add(geometry) })
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
    _pieceObjects.clear()
    _tileEffectObjects.clear()
    Object.keys(_tileMats).forEach(function (key) { delete _tileMats[key] })
    Object.keys(_factionMats).forEach(function (key) { delete _factionMats[key] })
    Object.keys(_hlMats).forEach(function (key) { delete _hlMats[key] })
    Object.keys(_tileEffectMats).forEach(function (key) { delete _tileEffectMats[key] })
    Object.keys(_tileEffectIconMats).forEach(function (key) { delete _tileEffectIconMats[key] })
    _anims.length = 0
    _floaterTimers.forEach(function (timer) { clearTimeout(timer) })
    _floaterTimers.clear()
    _floaters.forEach(function (element) { element.remove() })
    _floaters.clear()
    _texCache.clear()
    _pointers.clear()
    _renderer = null
    _camera = null
    _scene = null
    _hpLayer = null
    _floatLayer = null
    _onIntent = null
    _hitPlane = null
    _currentModel = null
    _mapW = 0
    _mapH = 0
    _tileGeom = null
    _hlPlaneGeom = null
    _selectedRingGeom = null
    _pieceBodyGeom = null
    _pieceRingGeom = null
    _portraitDiscGeom = null
    _clock.prev = 0
    _panStart = null
    _panMoved = false
    _pinchDist = 0
    _container = null
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
    screenToCell,
    dispose,
    TILE_EFFECT_VISUALS,
  }
})()
