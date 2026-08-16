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

  // ── State ────────────────────────────────────────────────────────────────────
  let _renderer, _camera, _scene, _animFrameId
  let _container = null
  let _hpLayer = null
  let _floatLayer = null
  let _onIntent = null
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
    const key = tileType || 'default'
    if (_tileEffectMats[key]) return _tileEffectMats[key]
    const colorByType = {
      'flying-raijin-anchor': 0x38bdf8,
      'amaterasu': 0xf97316,
      'shishio-burn': 0xfb923c,
      'shadow-step': 0xa855f7,
    }
    const color = colorByType[key] || 0xfacc15
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.82, depthWrite: false })
    _tileEffectMats[key] = mat
    return mat
  }

  // ── Texture loading ───────────────────────────────────────────────────────────
  function loadTexture(url) {
    if (_texCache.has(url)) return _texCache.get(url)
    const loader = new THREE.TextureLoader()
    const tex = loader.load(url, undefined, undefined, () => {
      // On error, texture stays default (black) — acceptable fallback
    })
    tex.colorSpace = THREE.SRGBColorSpace || 'srgb'
    _texCache.set(url, tex)
    return tex
  }

  function portraitUrl(templateId) {
    const name = templateId.replace(/^(red|blue)-/, '')
    return 'images/' + name + '.jpg'
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  function init(options) {
    const input = options || {}
    if (_mounted || _renderer || _container) dispose()
    if (!input.container) throw new Error('BattleRenderer3D.init requires a container')
    _container = input.container
    _floatLayer = input.floatLayer || null
    _onIntent = typeof input.onIntent === 'function' ? input.onIntent : null
    _mounted = true

    // Shared geometries
    _tileGeom       = new THREE.BoxGeometry(TILE_W, TILE_H, TILE_W)
    _hlPlaneGeom    = new THREE.PlaneGeometry(TILE_W - 0.06, TILE_W - 0.06)
    _selectedRingGeom = new THREE.TorusGeometry(RING_R, RING_T * 0.7, 8, 24)
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

    // HP bar overlay (absolute over canvas)
    _hpLayer = document.createElement('div')
    _hpLayer.id = 'hpBarLayer3d'
    _hpLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:visible'
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
    _updateHpBarPositions()
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
    _camera.zoom = _minimumUsableZoom(_container.clientWidth || 320, _container.clientHeight || 320)

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

      // Portrait texture (load once)
      if (!obj.portraitLoaded && piece.portraitId) {
        const tex = loadTexture(portraitUrl(piece.portraitId))
        if (obj.portraitMesh.material && obj.portraitMesh.material.dispose) obj.portraitMesh.material.dispose()
        obj.portraitMesh.material = new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide })
        obj.portraitLoaded = true
      }

      // Update HP bar DOM element
      _updateHpBar(obj, piece)

      // Show/hide based on alive
      obj.group.visible = piece.visible !== false
    })

    // Remove departed pieces
    _pieceObjects.forEach((obj, id) => {
      if (!seen.has(id)) {
        _scene.remove(obj.group)
        if (obj.body.material && obj.body.material.dispose) obj.body.material.dispose()
        if (obj.portraitMesh.material && obj.portraitMesh.material.dispose) obj.portraitMesh.material.dispose()
        if (obj.hpBarEl && obj.hpBarEl.parentNode) obj.hpBarEl.remove()
        _pieceObjects.delete(id)
      }
    })
  }

  function _effectKey(effect, index) {
    return [
      effect.id || effect.instanceId || effect.effectId || 'tile-effect',
      effect.type || effect.tileType || 'effect',
      effect.sourceId || '',
      effect.x,
      effect.y,
      index,
    ].join(':')
  }

  function _updateTileEffects(effects) {
    const seen = new Set()
    ;(effects || []).forEach((effect, index) => {
      if (effect.x == null || effect.y == null) return
      const key = _effectKey(effect, index)
      seen.add(key)
      if (!_tileEffectObjects.has(key)) {
        const group = new THREE.Group()
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.32, 0.025, 8, 32),
          getTileEffectMat(effect.type || effect.tileType)
        )
        ring.rotation.x = Math.PI / 2
        ring.position.y = TILE_H / 2 + 0.035
        group.add(ring)

        const dot = new THREE.Mesh(
          new THREE.CylinderGeometry(0.055, 0.055, 0.06, 16),
          getTileEffectMat(effect.type || effect.tileType)
        )
        dot.position.y = TILE_H / 2 + 0.06
        group.add(dot)

        _scene.add(group)
        _tileEffectObjects.set(key, group)
      }
      const group = _tileEffectObjects.get(key)
      if (group) group.position.set(effect.x, 0, effect.y)
    })

    _tileEffectObjects.forEach((group, key) => {
      if (!seen.has(key)) {
        _scene.remove(group)
        group.traverse(obj => {
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

    // HP bar div
    const hpBarEl = _createHpBarEl(piece)

    _scene.add(group)
    _pieceObjects.set(piece.id, {
      group, body, ring, portraitMesh,
      hpBarEl,
      portraitLoaded: false,
      animating: false,
      targetX: piece.x, targetZ: piece.y,
    })
  }

  // ── HP Bar overlay ────────────────────────────────────────────────────────────
  function _createHpBarEl(piece) {
    const wrap = document.createElement('div')
    wrap.style.cssText = `
      position:absolute; transform:translateX(-50%);
      width:36px; pointer-events:none;
      display:flex; flex-direction:column; align-items:center; gap:1px;
    `
    const bar = document.createElement('div')
    bar.style.cssText = 'width:100%;height:4px;background:#1e293b;border-radius:2px;overflow:hidden'
    const fill = document.createElement('div')
    fill.style.cssText = 'height:100%;background:#22c55e;transition:width .2s;border-radius:2px'
    bar.appendChild(fill)
    wrap.appendChild(bar)
    wrap.dataset.id = piece.id
    _hpLayer.appendChild(wrap)
    return wrap
  }

  function _updateHpBar(obj, piece) {
    if (!obj.hpBarEl) return
    const currentHp = piece.health ? piece.health.current : 0
    const maxHp = piece.health ? piece.health.max : 1
    const pct = Math.max(0, Math.min(100, Math.round(currentHp / maxHp * 100)))
    const fill = obj.hpBarEl.querySelector('div div')
    if (fill) {
      fill.style.width = pct + '%'
      fill.style.background = pct < 30 ? '#ef4444' : pct < 60 ? '#f59e0b' : '#22c55e'
    }
    obj.hpBarEl.style.display = piece.visible !== false ? '' : 'none'
  }

  function _updateHpBarPositions() {
    if (!_camera || !_renderer) return

    _pieceObjects.forEach(obj => {
      if (!obj.hpBarEl || !obj.group.visible) { if (obj.hpBarEl) obj.hpBarEl.style.display = 'none'; return }
      const projected = projectCell(obj.group.position.x, obj.group.position.z, TILE_H / 2 + PIECE_H + 0.1)
      if (!projected) return
      obj.hpBarEl.style.left = projected.left + 'px'
      obj.hpBarEl.style.top  = (projected.top - 6) + 'px'
      obj.hpBarEl.style.display = ''
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
        ring.position.y = TILE_H / 2 + 0.01
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
    _updateHpBarPositions()
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
      const coords = screenToCell(e.clientX, e.clientY)
      if (!coords) return
      const piece = _findPieceAt(coords.x, coords.y)
      if (piece && _onIntent) _onIntent({ type: 'inspect-piece', pieceId: piece.id })
    })
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
    _updateHpBarPositions()
  }

  function _resetCamera() {
    if (!_mapW) return
    const w = _container.clientWidth || 320
    const h = _container.clientHeight || 320
    _camera.zoom = _minimumUsableZoom(w, h)
    _camera.position.set(_mapW / 2, 50, _mapH / 2)
    _camera.lookAt(_mapW / 2, 0, _mapH / 2)
    _updateCameraFrustum(w, h)
    _updateHpBarPositions()
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
      ;[_tileMats, _factionMats, _hlMats, _tileEffectMats].forEach(function (cache) {
        Object.keys(cache).forEach(function (key) { if (cache[key]) materials.add(cache[key]) })
      })
      geometries.forEach(function (geometry) { if (geometry.dispose) geometry.dispose() })
      materials.forEach(function (material) { if (material.dispose) material.dispose() })
    }
    _texCache.forEach(function (texture) { if (texture && texture.dispose) texture.dispose() })
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
  }
})()
