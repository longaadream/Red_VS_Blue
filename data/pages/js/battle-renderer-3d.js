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
  let _floatLayer = null  // provided by caller (the existing #floatLayer)
  let _onCellClick = null
  let _onPieceRightClick = null

  let _mapW = 0, _mapH = 0
  const _tileObjects = new Map()       // "x,z" → THREE.Mesh
  const _pieceObjects = new Map()      // instanceId → {group, body, ring, portraitMesh, labelDiv, targetX, targetZ}
  const _tileEffectObjects = new Map()
  const _hlObjects = { move: [], skill: [], place: [], selected: null }
  const _anims = []                    // {mesh, fromX, fromZ, toX, toZ, elapsed, duration, type, ...}
  const _texCache = new Map()
  let _lastG = null
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
    const mat = new THREE.SpriteMaterial({ map: loadTexture(TILE_EFFECT_VISUALS[key].icon), transparent: true, depthWrite: false })
    _tileEffectIconMats[key] = mat
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
  function init(container, onCellClick, onPieceRightClick) {
    if (_renderer) destroy()
    _container = container
    _onCellClick = onCellClick || null
    _onPieceRightClick = onPieceRightClick || null

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
    container.insertBefore(_renderer.domElement, container.firstChild)

    // HP bar overlay (absolute over canvas)
    _hpLayer = document.createElement('div')
    _hpLayer.id = 'hpBarLayer3d'
    _hpLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:visible'
    container.appendChild(_hpLayer)

    // Camera (orthographic, top-down)
    _camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200)
    _camera.position.set(0, 50, 0)
    _camera.lookAt(0, 0, 0)
    _camera.up.set(0, 0, -1)

    // Pointer events on canvas
    _initControls()

    // Resize observer
    const ro = new ResizeObserver(() => resize())
    ro.observe(container)
    _container._ro = ro

    // Start render loop
    _animFrameId = requestAnimationFrame(_tick)
  }

  // ── Resize ───────────────────────────────────────────────────────────────────
  function resize() {
    if (!_renderer || !_container) return
    const w = _container.clientWidth || 320
    const h = _container.clientHeight || 320
    _renderer.setSize(w, h, false)
    _updateCameraFrustum(w, h)
  }

  function _updateCameraFrustum(w, h) {
    if (!_camera || !_mapW) return
    const aspect = w / (h || 1)
    const halfH = (_mapH / 2 + 1) / _camera.zoom
    const halfW = (_mapW / 2 + 1) / _camera.zoom
    const fitH = Math.max(halfH, halfW / aspect)
    _camera.left   = -fitH * aspect
    _camera.right  =  fitH * aspect
    _camera.top    =  fitH
    _camera.bottom = -fitH
    _camera.updateProjectionMatrix()
  }

  // ── Render loop ───────────────────────────────────────────────────────────────
  function _tick(now) {
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

    // Hit plane for raycasting (invisible, covers full map)
    if (_container._hitPlane) _scene.remove(_container._hitPlane)
    const hitGeom = new THREE.PlaneGeometry(_mapW + 2, _mapH + 2)
    const hitMat  = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
    const hitPlane = new THREE.Mesh(hitGeom, hitMat)
    hitPlane.rotation.x = -Math.PI / 2
    hitPlane.position.set(_mapW / 2, 0.02, _mapH / 2)
    _scene.add(hitPlane)
    _container._hitPlane = hitPlane

    resize()
  }

  // ── Pieces ───────────────────────────────────────────────────────────────────
  function _updatePieces(pieces) {
    const seen = new Set()

    pieces.forEach(piece => {
      if (piece.x == null || piece.y == null) return
      seen.add(piece.instanceId)

      if (!_pieceObjects.has(piece.instanceId)) {
        _spawnPieceMesh(piece)
      }

      const obj = _pieceObjects.get(piece.instanceId)
      if (!obj) return

      // If not animating, snap to position
      if (!obj.animating) {
        obj.group.position.set(piece.x, 0, piece.y)
      }

      // Portrait texture (load once)
      if (!obj.portraitLoaded && piece.templateId) {
        const tex = loadTexture(portraitUrl(piece.templateId))
        obj.portraitMesh.material = new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide })
        obj.portraitLoaded = true
      }

      // Update HP bar DOM element
      _updateHpBar(obj, piece)

      // Show/hide based on alive
      obj.group.visible = piece.currentHp > 0
    })

    // Remove departed pieces
    _pieceObjects.forEach((obj, id) => {
      if (!seen.has(id)) {
        _scene.remove(obj.group)
        if (obj.hpBarEl && obj.hpBarEl.parentNode) obj.hpBarEl.remove()
        _pieceObjects.delete(id)
      }
    })
  }

  function _effectSortKey(effect) {
    return [
      effect.tileType || 'effect',
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
          const ringRadius = 0.36 - index * 0.045
          const ring = new THREE.Mesh(
            new THREE.TorusGeometry(ringRadius, 0.018, 8, 32),
            getTileEffectMat(effect.tileType)
          )
          ring.rotation.x = Math.PI / 2
          ring.position.y = TILE_H / 2 + 0.025 + index * 0.004
          group.add(ring)

          const slot = TILE_EFFECT_ICON_SLOTS[index]
          const icon = new THREE.Sprite(getTileEffectIconMat(effect.tileType))
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

    // HP bar div
    const hpBarEl = _createHpBarEl(piece)

    _scene.add(group)
    _pieceObjects.set(piece.instanceId, {
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
    wrap.dataset.id = piece.instanceId
    _hpLayer.appendChild(wrap)
    return wrap
  }

  function _updateHpBar(obj, piece) {
    if (!obj.hpBarEl) return
    const maxHp = piece.maxHp || piece.stats?.maxHp || piece.currentHp || 1
    const pct = Math.max(0, Math.min(100, Math.round(piece.currentHp / maxHp * 100)))
    const fill = obj.hpBarEl.querySelector('div div')
    if (fill) {
      fill.style.width = pct + '%'
      fill.style.background = pct < 30 ? '#ef4444' : pct < 60 ? '#f59e0b' : '#22c55e'
    }
    obj.hpBarEl.style.display = piece.currentHp > 0 ? '' : 'none'
  }

  function _updateHpBarPositions() {
    if (!_camera || !_renderer) return
    const canvas = _renderer.domElement
    const rect = canvas.getBoundingClientRect()
    const containerRect = _container.getBoundingClientRect()
    const offX = rect.left - containerRect.left
    const offY = rect.top - containerRect.top

    _pieceObjects.forEach((obj, id) => {
      if (!obj.hpBarEl || !obj.group.visible) { if (obj.hpBarEl) obj.hpBarEl.style.display = 'none'; return }
      // Project piece top to screen
      const wp = obj.group.position.clone()
      wp.y += TILE_H / 2 + PIECE_H + 0.1
      const v = wp.clone().project(_camera)
      const sx = (v.x + 1) / 2 * canvas.width / window.devicePixelRatio + offX
      const sy = (-v.y + 1) / 2 * canvas.height / window.devicePixelRatio + offY
      obj.hpBarEl.style.left = sx + 'px'
      obj.hpBarEl.style.top  = (sy - 6) + 'px'
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
  function animateAction(action, oldG, newG) {
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
    if (oldG && newG && oldG.pieces && newG.pieces) {
      newG.pieces.forEach(np => {
        const op = oldG.pieces.find(p => p.instanceId === np.instanceId)
        if (op && np.currentHp < op.currentHp) {
          const obj = _pieceObjects.get(np.instanceId)
          if (obj) _anims.push({ type: 'flash', obj, elapsed: 0, duration: 0.3 })
        }
        if (op && op.currentHp > 0 && np.currentHp <= 0) {
          const obj = _pieceObjects.get(np.instanceId)
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

  function _initControls() {
    const canvas = _renderer.domElement
    canvas.style.touchAction = 'none'

    canvas.addEventListener('pointerdown', e => {
      _pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (_pointers.size === 1) {
        _panStart = { x: e.clientX, y: e.clientY }
        _panMoved = false
        canvas.setPointerCapture(e.pointerId)
      } else if (_pointers.size === 2) {
        _pinchDist = _getPinchDist()
      }
      e.preventDefault()
    }, { passive: false })

    canvas.addEventListener('pointermove', e => {
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
          const fov = (_camera.right - _camera.left) / _renderer.domElement.width
          _camera.position.x -= dx * fov
          _camera.position.z -= dy * fov
          _camera.lookAt(_camera.position.x, 0, _camera.position.z)
          _panStart = { x: e.clientX, y: e.clientY }
        }
      }
      e.preventDefault()
    }, { passive: false })

    const endPointer = e => {
      const wasClick = !_panMoved && _pointers.size === 1
      _pointers.delete(e.pointerId)
      if (_pointers.size < 2) _pinchDist = 0
      if (!_pointers.size) { _panStart = null }
      if (wasClick) _handleClick(e)
    }
    canvas.addEventListener('pointerup', endPointer)
    canvas.addEventListener('pointercancel', endPointer)

    canvas.addEventListener('wheel', e => {
      _applyZoom(_camera.zoom * (e.deltaY < 0 ? 1.12 : 0.89))
      e.preventDefault()
    }, { passive: false })

    canvas.addEventListener('dblclick', () => _resetCamera())

    canvas.addEventListener('contextmenu', e => {
      e.preventDefault()
      const coords = _raycastGrid(e)
      if (!coords) return
      const piece = _findPieceAt(coords.x, coords.z)
      if (piece && _onPieceRightClick) _onPieceRightClick(piece)
    })
  }

  function _getPinchDist() {
    const pts = Array.from(_pointers.values())
    if (pts.length < 2) return 0
    const dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y
    return Math.sqrt(dx * dx + dy * dy)
  }

  function _applyZoom(z) {
    _camera.zoom = Math.max(0.4, Math.min(5, z))
    _camera.updateProjectionMatrix()
    _updateHpBarPositions()
  }

  function _resetCamera() {
    if (!_mapW) return
    _camera.zoom = 1
    _camera.position.set(_mapW / 2, 50, _mapH / 2)
    _camera.lookAt(_mapW / 2, 0, _mapH / 2)
    const w = _container.clientWidth || 320
    const h = _container.clientHeight || 320
    _updateCameraFrustum(w, h)
  }

  // ── Raycasting ────────────────────────────────────────────────────────────────
  const _raycaster = new THREE.Raycaster()

  function _raycastGrid(e) {
    if (!_container._hitPlane) return null
    const canvas = _renderer.domElement
    const rect = canvas.getBoundingClientRect()
    const ndcX = ((e.clientX - rect.left) / rect.width)  * 2 - 1
    const ndcY = -((e.clientY - rect.top)  / rect.height) * 2 + 1
    _raycaster.setFromCamera({ x: ndcX, y: ndcY }, _camera)
    const hits = _raycaster.intersectObject(_container._hitPlane)
    if (!hits.length) return null
    const pt = hits[0].point
    return { x: Math.round(pt.x), z: Math.round(pt.z) }
  }

  function _handleClick(e) {
    const coords = _raycastGrid(e)
    if (!coords) return
    if (_onCellClick) _onCellClick(coords.x, coords.z)
  }

  function _findPieceAt(x, z) {
    if (!_lastG) return null
    return (_lastG.pieces || []).find(p => p.x === x && p.y === z && p.currentHp > 0) || null
  }

  // ── syncState — called every render cycle when G changes ──────────────────────
  function syncState(G) {
    if (!G || !G.map) return

    // Build / update tiles on first call or map change
    const mapKey = G.map.width + 'x' + G.map.height
    if (!_container._mapKey || _container._mapKey !== mapKey) {
      _container._mapKey = mapKey
      _buildTiles(G.map)
    }

    _updatePieces(G.pieces || [])
    _updateTileEffects(G.extensions && G.extensions.tileEffects ? G.extensions.tileEffects : [])
    _lastG = G
  }

  // ── spawnFloater ─────────────────────────────────────────────────────────────
  function spawnFloater(x, z, text, color, big) {
    // Find the floatLayer: use the existing one in the DOM if available
    const layer = _floatLayer || document.getElementById('floatLayer')
    if (!layer) return
    const canvas = _renderer ? _renderer.domElement : null
    let left = x * 44 + 22  // fallback pixel estimate
    let top  = z * 44 + 4

    if (canvas && _camera) {
      const wp = new THREE.Vector3(x, TILE_H / 2 + PIECE_H + 0.2, z)
      const v  = wp.project(_camera)
      const rect = canvas.getBoundingClientRect()
      const containerRect = _container.getBoundingClientRect()
      left = (v.x + 1) / 2 * rect.width + (rect.left - containerRect.left)
      top  = (-v.y + 1) / 2 * rect.height + (rect.top - containerRect.top) - 14
    }

    const el = document.createElement('div')
    el.className = 'dmg-float' + (big ? ' big' : '')
    el.style.color = color
    el.style.left  = left + 'px'
    el.style.top   = top  + 'px'
    el.textContent = text
    layer.appendChild(el)
    setTimeout(() => el.remove(), 1200)
  }

  function setFloatLayer(el) { _floatLayer = el }

  // ── Destroy ───────────────────────────────────────────────────────────────────
  function destroy() {
    if (_animFrameId) cancelAnimationFrame(_animFrameId)
    if (_container && _container._ro) { _container._ro.disconnect(); delete _container._ro }
    if (_hpLayer && _hpLayer.parentNode) _hpLayer.remove()
    if (_renderer) { _renderer.dispose(); if (_renderer.domElement.parentNode) _renderer.domElement.remove() }
    _tileObjects.clear()
    _pieceObjects.clear()
    _tileEffectObjects.forEach(entry => {
      entry.group.traverse(obj => {
        if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose()
      })
    })
    _tileEffectObjects.clear()
    _anims.length = 0
    Object.keys(_tileEffectMats).forEach(key => {
      _tileEffectMats[key].dispose()
      delete _tileEffectMats[key]
    })
    Object.keys(_tileEffectIconMats).forEach(key => {
      _tileEffectIconMats[key].dispose()
      delete _tileEffectIconMats[key]
    })
    _texCache.forEach(texture => texture.dispose())
    _texCache.clear()
    _renderer = null
    _camera = null
    _scene = null
    _container = null
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  window.BattleRenderer3D = {
    init,
    syncState,
    animateAction,
    setHighlights,
    spawnFloater,
    setFloatLayer,
    resize,
    destroy,
    TILE_EFFECT_VISUALS,
  }
})()
