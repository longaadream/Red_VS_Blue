import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { createRed68BattleFixture } from './fixtures/red-68-battle-fixture'

const pagesDir = resolve(process.cwd(), 'data/pages')
type ThreeMaterial = {
  color?: { getHex(): number }
  emissive: { getHex(): number }
  emissiveIntensity: number
  opacity?: number
  dispose(): void
}
type ThreeNode = {
  type: string
  children: ThreeNode[]
  visible: boolean
  material?: ThreeMaterial
  position: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
  userData: Record<string, unknown>
}
type ThreeScene = { children: ThreeNode[]; updateMatrixWorld(force: boolean): void }
type ThreeCamera = { updateMatrixWorld(force: boolean): void }

type RendererApi = {
  init(options: unknown): void
  update(model: unknown): void
  animateAction(action: unknown, previousModel: unknown, nextModel: unknown): void
  resize(): void
  resetView(): void
  projectCell(x: number, y: number, elevation?: number): { clientX: number; clientY: number }
  screenToCell(clientX: number, clientY: number): { x: number; y: number } | null
  getMotionDiagnostics(): {
    activeAnimations: string[]
    playedEventCount: number
    floaterCount: number
    pendingPieceIds: string[]
    highlightCounts: { move: number; skill: number; place: number; selected: number }
  }
  dispose(): void
}

type WindowHarness = {
  [key: string]: unknown
  devicePixelRatio: number
  BattleRenderer3D?: RendererApi
  matchMedia(query: string): { matches: boolean }
  addEventListener(): void
  removeEventListener(): void
}

type FakeRendererRecord = {
  domElement: FakeElement
  pixelRatio: number
  disposed: boolean
  contextLost: boolean
  scene: ThreeScene | null
  camera: ThreeCamera | null
}

type DisposablePrototype = { dispose: (this: object) => unknown }
type ThreeHarness = {
  BufferGeometry: { prototype: DisposablePrototype }
  Material: { prototype: DisposablePrototype }
  WebGLRenderer: unknown
  TextureLoader: unknown
}

class FakeElement {
  readonly tagName: string
  readonly children: FakeElement[] = []
  readonly dataset: Record<string, string> = {}
  readonly attributes: Record<string, string> = {}
  readonly listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>()
  readonly capturedPointers = new Set<number>()
  readonly style: Record<string, unknown> & { setProperty(name: string, value: string): void }
  parentNode: FakeElement | null = null
  className = ''
  id = ''
  textContent = ''
  title = ''
  hidden = false
  tabIndex = -1
  width = 0
  height = 0
  rect = { left: 0, top: 0, width: 0, height: 0 }

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
    this.style = Object.assign(Object.create(null), {
      setProperty: (name: string, value: string) => { this.style[name] = value },
    })
  }

  get firstChild() { return this.children[0] || null }
  get clientWidth() { return this.rect.width }
  get clientHeight() { return this.rect.height }

  appendChild(child: FakeElement) {
    if (child.parentNode) child.remove()
    this.children.push(child)
    child.parentNode = this
    return child
  }

  insertBefore(child: FakeElement, before: FakeElement | null) {
    if (child.parentNode) child.remove()
    const index = before ? this.children.indexOf(before) : -1
    if (index >= 0) this.children.splice(index, 0, child)
    else this.children.push(child)
    child.parentNode = this
    return child
  }

  remove() {
    if (!this.parentNode) return
    const index = this.parentNode.children.indexOf(this)
    if (index >= 0) this.parentNode.children.splice(index, 1)
    this.parentNode = null
  }

  replaceChildren(...children: FakeElement[]) {
    this.children.splice(0).forEach((child) => { child.parentNode = null })
    children.forEach((child) => this.appendChild(child))
  }

  querySelector(selector: string): FakeElement | null {
    const className = selector.startsWith('.') ? selector.slice(1) : ''
    for (const child of this.children) {
      if (className && child.className.split(/\s+/).includes(className)) return child
      const nested = child.querySelector(selector)
      if (nested) return nested
    }
    return null
  }

  setAttribute(name: string, value: string) { this.attributes[name] = value }
  getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height } }

  addEventListener(type: string, handler: (event: Record<string, unknown>) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(handler)
  }

  removeEventListener(type: string, handler: (event: Record<string, unknown>) => void) {
    this.listeners.get(type)?.delete(handler)
  }

  dispatch(type: string, input: Record<string, unknown>) {
    const event = { preventDefault() {}, ...input }
    this.listeners.get(type)?.forEach((handler) => handler(event))
  }

  listenerCount() {
    return Array.from(this.listeners.values()).reduce((total, handlers) => total + handlers.size, 0)
  }

  setPointerCapture(pointerId: number) { this.capturedPointers.add(pointerId) }
  hasPointerCapture(pointerId: number) { return this.capturedPointers.has(pointerId) }
  releasePointerCapture(pointerId: number) { this.capturedPointers.delete(pointerId) }
}

function createHarness(
  width = 390,
  height = 844,
  coarsePointer = true,
  reducedMotion = false,
  textureOutcomes: Record<string, 'loaded' | 'error'> = {},
) {
  const container = new FakeElement('div')
  container.rect = { left: 0, top: 0, width, height }
  const renderers: FakeRendererRecord[] = []
  const observers: Array<{ disconnected: boolean }> = []
  const rafCallbacks = new Map<number, (now: number) => void>()
  const cancelledRafs = new Set<number>()
  const disposeCounts = { geometry: 0, material: 0 }
  const textureRequests: string[] = []
  const textureJobs: Array<() => void> = []
  let nextRafId = 1
  let now = 0

  const document = {
    createElement(tagName: string) { return new FakeElement(tagName) },
    getElementById() { return null },
  }
  const windowObject: WindowHarness = {
    devicePixelRatio: 1,
    matchMedia(query: string) {
      return {
        matches: (coarsePointer && query.includes('pointer: coarse'))
          || (reducedMotion && query.includes('prefers-reduced-motion: reduce')),
      }
    },
    addEventListener() {},
    removeEventListener() {},
  }
  const sandbox: Record<string, unknown> = {
    window: windowObject,
    document,
    console,
    Math,
    Object,
    Array,
    Map,
    Set,
    Number,
    String,
    Boolean,
    Date,
    setTimeout,
    clearTimeout,
    requestAnimationFrame(callback: (time: number) => void) {
      const id = nextRafId++
      rafCallbacks.set(id, callback)
      return id
    },
    cancelAnimationFrame(id: number) {
      cancelledRafs.add(id)
      rafCallbacks.delete(id)
    },
    ResizeObserver: class {
      disconnected = false
      constructor(callback: () => void) { void callback; observers.push(this) }
      observe() {}
      disconnect() { this.disconnected = true }
    },
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  const context = createContext(sandbox)
  new Script(readFileSync(resolve(pagesDir, 'js/three.min.js'), 'utf8'), { filename: 'three.min.js' }).runInContext(context)

  const THREE = sandbox.THREE as ThreeHarness
  const geometryDispose = THREE.BufferGeometry.prototype.dispose
  THREE.BufferGeometry.prototype.dispose = function (this: object) {
    disposeCounts.geometry += 1
    return geometryDispose.call(this)
  }
  const materialDispose = THREE.Material.prototype.dispose
  THREE.Material.prototype.dispose = function (this: object) {
    disposeCounts.material += 1
    return materialDispose.call(this)
  }
  THREE.TextureLoader = class {
    load(url: string, onLoad: (texture: unknown) => void, _onProgress: unknown, onError: (error: Error) => void) {
      const texture = new (sandbox.THREE as { Texture: new () => { colorSpace?: string } }).Texture()
      textureRequests.push(url)
      textureJobs.push(() => {
        if (textureOutcomes[url] === 'error') onError(new Error('simulated texture failure: ' + url))
        else onLoad(texture)
      })
      return texture
    }
  }

  THREE.WebGLRenderer = class {
    readonly domElement = new FakeElement('canvas')
    pixelRatio = 1
    disposed = false
    contextLost = false
    scene: ThreeScene | null = null
    camera: ThreeCamera | null = null
    constructor() { renderers.push(this) }
    setPixelRatio(value: number) { this.pixelRatio = value }
    setSize(nextWidth: number, nextHeight: number) {
      this.domElement.width = nextWidth
      this.domElement.height = nextHeight
      this.domElement.rect = { left: 0, top: 0, width: nextWidth, height: nextHeight }
    }
    render(scene: ThreeScene, camera: ThreeCamera) {
      scene.updateMatrixWorld(true)
      camera.updateMatrixWorld(true)
      this.scene = scene
      this.camera = camera
    }
    dispose() { this.disposed = true }
    forceContextLoss() { this.contextLost = true }
  }

  new Script(readFileSync(resolve(pagesDir, 'js/battle-ui/battle-tactical-geometry.js'), 'utf8'), { filename: 'battle-tactical-geometry.js' }).runInContext(context)
  new Script(readFileSync(resolve(pagesDir, 'js/battle-ui/battle-standee-manifest.js'), 'utf8'), { filename: 'battle-standee-manifest.js' }).runInContext(context)
  new Script(readFileSync(resolve(pagesDir, 'js/battle-renderer-3d.js'), 'utf8'), { filename: 'battle-renderer-3d.js' }).runInContext(context)

  function frame(step = 100) {
    now += step
    const next = Array.from(rafCallbacks.entries()).sort((a, b) => a[0] - b[0])[0]
    if (!next) return
    rafCallbacks.delete(next[0])
    next[1](now)
  }

  function flushTextures() {
    while (textureJobs.length) textureJobs.shift()!()
  }

  return { container, windowObject, renderers, observers, rafCallbacks, cancelledRafs, disposeCounts, textureRequests, flushTextures, frame, renderer: windowObject.BattleRenderer3D! }
}

function runtimeModel() {
  const fixture = createRed68BattleFixture()
  return {
    board: fixture.map,
    pieces: fixture.pieces.map((piece) => ({
      id: piece.instanceId,
      name: piece.instanceId,
      faction: piece.faction,
      ownerPlayerId: piece.ownerPlayerId,
      x: piece.x,
      y: piece.y,
      health: { current: piece.currentHp, max: piece.maxHp },
      statusSummary: piece.statusTags.map((status) => ({ id: status.id, label: status.name })),
      visible: true,
    })),
    effects: [],
    legal: { moveCells: [], targetCells: [], placementCells: [] },
    selection: { pieceId: null },
    interaction: { pendingPieceId: null, pendingCommandId: null },
  }
}

function distance(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

describe('RED-68 BattleRenderer3D runtime', () => {
  it('renders one thin paper map with flat grid and terrain marks over hidden hit proxies', () => {
    const harness = createHarness(1280, 720, false)
    const model = runtimeModel()
    model.board.tiles[0].props.type = 'wall'
    harness.renderer.init({ container: harness.container })
    harness.renderer.update(model)
    harness.frame()

    const scene = harness.renderers[0].scene!
    const byRole = (role: string) => scene.children.find((child) => child.userData.motionRole === role)
    const table = byRole('table-surface')
    const paper = byRole('paper-map')
    const underlay = byRole('paper-underlay')
    const grid = byRole('paper-grid')
    const marks = byRole('paper-map-marks')
    const hitTiles = scene.children.filter((child) => Number.isFinite(child.userData.tileX))

    expect(table?.type).toBe('Mesh')
    expect(paper?.type).toBe('Mesh')
    expect(underlay?.type).toBe('Mesh')
    expect(grid?.type).toBe('LineSegments')
    expect(marks?.type).toBe('LineSegments')
    expect(paper?.position.y).toBeCloseTo(0.035, 4)
    expect(table!.position.y).toBeLessThan(paper!.position.y)
    expect(hitTiles).toHaveLength(20 * 16)
    expect(hitTiles.every((tile) => (tile.material as ThreeMaterial & { visible?: boolean }).visible === false)).toBe(true)

    harness.renderer.dispose()
  })

  it('executes projection, hit, DPR, touch gestures, reset, flash recovery, and rule-state isolation', () => {
    const harness = createHarness()
    const intents: Array<Record<string, unknown>> = []
    const model = runtimeModel()
    const authorityBefore = JSON.stringify(model)
    harness.renderer.init({ container: harness.container, onIntent: (intent: Record<string, unknown>) => intents.push(intent) })
    harness.renderer.update(model)
    harness.frame()

    for (const [x, y] of [[0, 0], [19, 0], [10, 8], [0, 15], [19, 15]]) {
      const point = harness.renderer.projectCell(x, y)
      expect(harness.renderer.screenToCell(point.clientX, point.clientY)).toEqual({ x, y })
    }

    const center = harness.renderer.projectCell(10, 8)
    let minimumCellAxis = Infinity
    for (let y = 0; y < 15; y += 1) {
      for (let x = 0; x < 19; x += 1) {
        const origin = harness.renderer.projectCell(x, y, 0.12)
        const horizontal = harness.renderer.projectCell(x + 1, y, 0.12)
        const vertical = harness.renderer.projectCell(x, y + 1, 0.12)
        minimumCellAxis = Math.min(minimumCellAxis, distance(origin, horizontal), distance(origin, vertical))
      }
    }
    expect(minimumCellAxis).toBeGreaterThanOrEqual(44)

    const canvas = harness.renderers[0].domElement as FakeElement
    canvas.dispatch('pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: center.clientX, clientY: center.clientY })
    canvas.dispatch('pointerup', { pointerId: 1, pointerType: 'touch', clientX: center.clientX, clientY: center.clientY })
    expect(intents).toContainEqual({ type: 'activate-cell', x: 10, y: 8 })

    const beforeTinyDrag = harness.renderer.projectCell(10, 8)
    canvas.dispatch('pointerdown', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 100, clientY: 100 })
    canvas.dispatch('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 105, clientY: 103 })
    canvas.dispatch('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 105, clientY: 103 })
    expect(distance(beforeTinyDrag, harness.renderer.projectCell(10, 8))).toBeLessThan(0.5)

    canvas.dispatch('pointerdown', { pointerId: 3, pointerType: 'touch', button: 0, clientX: 120, clientY: 120 })
    canvas.dispatch('pointermove', { pointerId: 3, pointerType: 'touch', clientX: 168, clientY: 150 })
    canvas.dispatch('pointerup', { pointerId: 3, pointerType: 'touch', clientX: 168, clientY: 150 })
    expect(distance(beforeTinyDrag, harness.renderer.projectCell(10, 8))).toBeGreaterThan(20)
    harness.renderer.resetView()
    expect(distance(beforeTinyDrag, harness.renderer.projectCell(10, 8))).toBeLessThan(0.5)

    const spanBeforePinch = distance(harness.renderer.projectCell(10, 8), harness.renderer.projectCell(11, 8))
    canvas.dispatch('pointerdown', { pointerId: 4, pointerType: 'touch', button: 0, clientX: 100, clientY: 120 })
    canvas.dispatch('pointerdown', { pointerId: 5, pointerType: 'touch', button: 0, clientX: 200, clientY: 120 })
    canvas.dispatch('pointermove', { pointerId: 5, pointerType: 'touch', clientX: 260, clientY: 120 })
    canvas.dispatch('pointerup', { pointerId: 5, pointerType: 'touch', clientX: 260, clientY: 120 })
    canvas.dispatch('pointerup', { pointerId: 4, pointerType: 'touch', clientX: 100, clientY: 120 })
    expect(distance(harness.renderer.projectCell(10, 8), harness.renderer.projectCell(11, 8))).toBeGreaterThan(spanBeforePinch * 1.5)

    harness.windowObject.devicePixelRatio = 3
    harness.renderer.resize()
    expect(harness.renderers[0].pixelRatio).toBe(2)

    const blueGroup = harness.renderers[0].scene!.children.find((child) =>
      child.type === 'Group' && child.children.slice(4, 7).filter((marker) => marker.visible).length === 2,
    )
    expect(blueGroup).toBeTruthy()
    const blueBody = blueGroup!.children[1]
    expect(blueBody.material!.emissive.getHex()).toBe(0x3b82f6)
    const nextModel = structuredClone(model)
    nextModel.pieces[8].health.current -= 1
    harness.renderer.animateAction({}, model, nextModel)
    for (let index = 0; index < 5; index += 1) harness.frame()
    expect(blueBody.material!.emissive.getHex()).toBe(0x3b82f6)
    expect(blueBody.material!.emissiveIntensity).toBe(0.08)
    expect(JSON.stringify(model)).toBe(authorityBefore)
  })

  it('releases RAF, listeners, observer, WebGL context, geometries, and materials across remounts', () => {
    const harness = createHarness(844, 390)
    const model = runtimeModel()
    harness.renderer.init({ container: harness.container })
    harness.renderer.update(model)
    harness.frame()
    const firstRenderer = harness.renderers[0]
    const firstCanvas = firstRenderer.domElement as FakeElement
    expect(firstCanvas.listenerCount()).toBeGreaterThan(0)

    harness.renderer.init({ container: harness.container })
    expect(firstCanvas.listenerCount()).toBe(0)
    expect(firstRenderer.disposed).toBe(true)
    expect(firstRenderer.contextLost).toBe(true)
    expect(harness.observers[0].disconnected).toBe(true)
    expect(harness.disposeCounts.geometry).toBeGreaterThan(0)
    expect(harness.disposeCounts.material).toBeGreaterThan(0)
    expect(harness.cancelledRafs.size).toBeGreaterThan(0)

    const secondRenderer = harness.renderers[1]
    const secondCanvas = secondRenderer.domElement as FakeElement
    harness.renderer.dispose()
    expect(secondCanvas.listenerCount()).toBe(0)
    expect(secondRenderer.disposed).toBe(true)
    expect(secondRenderer.contextLost).toBe(true)
    expect(harness.rafCallbacks.size).toBe(0)
  })

  it('loads only explicit standees and keeps the portrait visible on missing or failed assets', () => {
    const success = createHarness(1280, 720, false)
    const successModel: any = runtimeModel()
    successModel.pieces[0].templateId = 'blue-naruto'
    successModel.pieces[0].portraitId = 'naruto.jpg'
    success.renderer.init({ container: success.container })
    success.renderer.update(successModel)
    expect(success.textureRequests).toContain('public/standees/blue-naruto.png')
    expect(success.textureRequests).toContain('images/naruto.jpg')
    success.flushTextures()
    success.frame()
    const successGroup = success.renderers[0].scene!.children.find((child) => child.userData.pieceId === successModel.pieces[0].id)!
    const successPortrait = successGroup.children.find((child) => child.userData.motionRole === 'portrait-fallback')!
    const successStandee = successGroup.children.find((child) => child.userData.motionRole === 'paper-standee')!
    expect(successPortrait.visible).toBe(false)
    expect(successStandee.visible).toBe(true)
    success.renderer.dispose()

    const failed = createHarness(1280, 720, false, false, {
      'public/standees/blue-naruto.png': 'error',
    })
    const failedModel: any = runtimeModel()
    failedModel.pieces[0].templateId = 'blue-naruto'
    failedModel.pieces[0].portraitId = 'naruto.jpg'
    failed.renderer.init({ container: failed.container })
    failed.renderer.update(failedModel)
    failed.flushTextures()
    failed.frame()
    const failedGroup = failed.renderers[0].scene!.children.find((child) => child.userData.pieceId === failedModel.pieces[0].id)!
    const failedPortrait = failedGroup.children.find((child) => child.userData.motionRole === 'portrait-fallback')!
    const failedStandee = failedGroup.children.find((child) => child.userData.motionRole === 'paper-standee')!
    expect(failedPortrait.visible).toBe(true)
    expect(failedStandee.visible).toBe(false)
    failed.renderer.dispose()

    const unmapped = createHarness(1280, 720, false)
    const unmappedModel: any = runtimeModel()
    unmappedModel.pieces[0].templateId = 'anduin'
    unmappedModel.pieces[0].portraitId = 'anduin.jpg'
    unmapped.renderer.init({ container: unmapped.container })
    unmapped.renderer.update(unmappedModel)
    expect(unmapped.textureRequests.filter((url) => url.includes('/standees/'))).toEqual([])
    expect(unmapped.textureRequests).toContain('images/anduin.jpg')
    unmapped.flushTextures()
    unmapped.frame()
    const unmappedGroup = unmapped.renderers[0].scene!.children.find((child) => child.userData.pieceId === unmappedModel.pieces[0].id)!
    expect(unmappedGroup.children.find((child) => child.userData.motionRole === 'portrait-fallback')!.visible).toBe(true)
    expect(unmappedGroup.children.find((child) => child.userData.motionRole === 'paper-standee')!.visible).toBe(false)
    unmapped.renderer.dispose()
  })

  it('keeps every projected cell axis at least 44px in mobile landscape', () => {
    const harness = createHarness(844, 390, true)
    const model = runtimeModel()
    harness.renderer.init({ container: harness.container })
    harness.renderer.update(model)
    harness.frame()

    let minimumCellAxis = Infinity
    for (let y = 0; y < 15; y += 1) {
      for (let x = 0; x < 19; x += 1) {
        const origin = harness.renderer.projectCell(x, y, 0.12)
        const horizontal = harness.renderer.projectCell(x + 1, y, 0.12)
        const vertical = harness.renderer.projectCell(x, y + 1, 0.12)
        minimumCellAxis = Math.min(minimumCellAxis, distance(origin, horizontal), distance(origin, vertical))
      }
    }

    expect(minimumCellAxis).toBeGreaterThanOrEqual(44)
    harness.renderer.dispose()
  })

  it('uses centered one-axis perspective so near cells are wider while the full board stays visible', () => {
    const harness = createHarness(1280, 720, false)
    const model = runtimeModel()
    model.board.tiles[0].props.type = 'wall'
    model.board.tiles[19].props.type = 'wall'
    harness.renderer.init({ container: harness.container })
    harness.renderer.update(model)
    harness.frame()

    const farLeft = harness.renderer.projectCell(0, 0)
    const farRight = harness.renderer.projectCell(19, 0)
    const nearLeft = harness.renderer.projectCell(0, 15)
    const nearRight = harness.renderer.projectCell(19, 15)
    const farCenter = harness.renderer.projectCell(9.5, 0, 0.12)
    const nearCenter = harness.renderer.projectCell(9.5, 15, 0.12)
    const farWidth = distance(farLeft, farRight)
    const nearWidth = distance(nearLeft, nearRight)

    expect(nearWidth / farWidth).toBeGreaterThanOrEqual(1.25)
    expect(nearWidth / farWidth).toBeLessThanOrEqual(1.4)
    expect(Math.abs(farCenter.clientX - nearCenter.clientX)).toBeLessThan(0.001)
    expect(farLeft.clientX + farRight.clientX).toBeCloseTo(1280, 3)
    expect(nearLeft.clientX + nearRight.clientX).toBeCloseTo(1280, 3)

    for (const point of [farLeft, farRight, nearLeft, nearRight]) {
      expect(point.clientX).toBeGreaterThan(0)
      expect(point.clientX).toBeLessThan(1280)
      expect(point.clientY).toBeGreaterThan(0)
      expect(point.clientY).toBeLessThan(720)
    }
    for (const [point, expected] of [
      [farLeft, { x: 0, y: 0 }],
      [farRight, { x: 19, y: 0 }],
      [nearLeft, { x: 0, y: 15 }],
      [nearRight, { x: 19, y: 15 }],
    ] as const) {
      expect(harness.renderer.screenToCell(point.clientX, point.clientY)).toEqual(expected)
    }
    const elevatedFarLeft = harness.renderer.projectCell(0, 0, 0.52)
    expect(harness.renderer.screenToCell(elevatedFarLeft.clientX, elevatedFarLeft.clientY)).toEqual({ x: 0, y: 0 })
    const elevatedFarRight = harness.renderer.projectCell(19, 0, 0.52)
    expect(harness.renderer.screenToCell(elevatedFarRight.clientX, elevatedFarRight.clientY)).toEqual({ x: 19, y: 0 })
    harness.renderer.dispose()
  })

  it('disposes piece-owned materials when a piece leaves the presentation model', () => {
    const harness = createHarness()
    const model = runtimeModel()
    harness.renderer.init({ container: harness.container })
    harness.renderer.update(model)
    harness.frame()

    const scene = harness.renderers[0].scene!
    const pieceGroups = scene.children.filter((child) => child.type === 'Group')
    expect(pieceGroups).toHaveLength(16)
    const removedGroup = pieceGroups[0]
    const markerMaterial = removedGroup.children[4].material!
    let markerDisposed = false
    const disposeMarker = markerMaterial.dispose.bind(markerMaterial)
    markerMaterial.dispose = () => {
      markerDisposed = true
      disposeMarker()
    }
    const materialDisposalsBefore = harness.disposeCounts.material

    const nextModel = structuredClone(model)
    nextModel.pieces = nextModel.pieces.slice(1)
    harness.renderer.update(nextModel)

    expect(scene.children).not.toContain(removedGroup)
    expect(scene.children.filter((child) => child.type === 'Group')).toHaveLength(15)
    expect(markerDisposed).toBe(true)
    expect(harness.disposeCounts.material - materialDisposalsBefore).toBe(6)
    harness.renderer.dispose()
  })

  it('responds to piece press within one frame and clears it when the gesture becomes a pan', () => {
    const harness = createHarness(844, 390, false)
    const model = runtimeModel()
    harness.renderer.init({ container: harness.container })
    harness.renderer.update(model)
    harness.frame(16)

    const piece = model.pieces[0]
    const group = harness.renderers[0].scene!.children.find((child) => child.userData.pieceId === piece.id)!
    const point = harness.renderer.projectCell(piece.x, piece.y, group.position.y + 0.12)
    const canvas = harness.renderers[0].domElement

    canvas.dispatch('pointerdown', { pointerId: 41, pointerType: 'mouse', button: 0, clientX: point.clientX, clientY: point.clientY })
    harness.frame(16)
    expect(group.scale.x).toBeLessThan(1)
    expect(group.scale.z).toBeLessThan(1)

    canvas.dispatch('pointermove', { pointerId: 41, pointerType: 'mouse', clientX: point.clientX + 18, clientY: point.clientY + 4 })
    for (let index = 0; index < 10; index += 1) harness.frame(16)
    expect(group.scale.x).toBeCloseTo(1, 3)
    expect(group.scale.z).toBeCloseTo(1, 3)
    harness.renderer.dispose()
  })

  it('shows authoritative waiting feedback and retargets movement from the visible position without replaying an event', () => {
    const harness = createHarness(844, 390, false)
    const model: any = runtimeModel()
    const pieceId = model.pieces[0].id
    harness.renderer.init({ container: harness.container })
    harness.renderer.update(model)
    harness.frame(16)
    const group = harness.renderers[0].scene!.children.find((child) => child.userData.pieceId === pieceId)!
    const baseY = group.position.y

    const pendingModel = structuredClone(model)
    pendingModel.interaction = { pendingPieceId: pieceId, pendingCommandId: 'move-1' }
    harness.renderer.update(pendingModel)
    for (let index = 0; index < 10; index += 1) harness.frame(16)
    expect(harness.renderer.getMotionDiagnostics().pendingPieceIds).toEqual([pieceId])

    const firstTarget = structuredClone(model)
    firstTarget.pieces[0].x += 3
    harness.renderer.animateAction({ type: 'move', pieceId, motionEventKey: 'state-1' }, pendingModel, firstTarget)
    harness.renderer.update(firstTarget)
    for (let index = 0; index < 7; index += 1) harness.frame(16)

    const visibleX = group.position.x
    expect(visibleX).toBeGreaterThan(model.pieces[0].x)
    expect(visibleX).toBeLessThan(firstTarget.pieces[0].x)

    const secondTarget = structuredClone(firstTarget)
    secondTarget.pieces[0].x += 2
    harness.renderer.animateAction({ type: 'move', pieceId, motionEventKey: 'state-2' }, firstTarget, secondTarget)
    harness.renderer.update(secondTarget)
    harness.frame(16)
    let maximumY = group.position.y
    expect(group.position.x).toBeGreaterThanOrEqual(visibleX)
    for (let index = 0; index < 20; index += 1) {
      harness.frame(16)
      maximumY = Math.max(maximumY, group.position.y)
    }
    expect(maximumY).toBeLessThanOrEqual(baseY + 0.0801)
    expect(group.position.x).toBeCloseTo(secondTarget.pieces[0].x, 3)

    harness.renderer.animateAction({ type: 'move', pieceId, motionEventKey: 'state-2' }, firstTarget, secondTarget)
    for (let index = 0; index < 20; index += 1) harness.frame(16)
    expect(group.position.x).toBeCloseTo(secondTarget.pieces[0].x, 3)
    expect(harness.renderer.getMotionDiagnostics().playedEventCount).toBe(2)
    harness.renderer.dispose()
  })

  it('removes spatial motion in reduced-motion mode while preserving result feedback and cleanup', () => {
    const harness = createHarness(844, 390, false, true)
    const model = runtimeModel()
    const pieceId = model.pieces[0].id
    harness.renderer.init({ container: harness.container })
    harness.renderer.update(model)
    harness.frame(16)

    const nextModel = structuredClone(model)
    nextModel.pieces[0].x += 4
    nextModel.pieces[0].health.current -= 5
    harness.renderer.animateAction({ type: 'move', pieceId, motionEventKey: 'reduced-1' }, model, nextModel)
    harness.renderer.update(nextModel)

    const group = harness.renderers[0].scene!.children.find((child) => child.userData.pieceId === pieceId)!
    expect(group.position.x).toBe(nextModel.pieces[0].x)
    expect(harness.renderer.getMotionDiagnostics().activeAnimations.some((key) => key.endsWith(':position'))).toBe(false)
    expect(harness.renderer.getMotionDiagnostics().activeAnimations.length).toBeGreaterThan(0)

    harness.renderer.dispose()
    expect(harness.renderer.getMotionDiagnostics()).toMatchObject({
      activeAnimations: [],
      floaterCount: 0,
      pendingPieceIds: [],
    })
  })
  it('enters target cells simultaneously, does not replay stable highlights, and disposes them after exit', () => {
    const harness = createHarness(844, 390, false)
    const model: any = runtimeModel()
    model.legal.targetCells = [{ x: 2, y: 2 }, { x: 4, y: 3 }]
    harness.renderer.init({ container: harness.container })
    harness.renderer.update(model)
    const point = harness.renderer.projectCell(2, 2)
    const canvas = harness.renderers[0].domElement
    canvas.dispatch('pointerdown', { pointerId: 52, pointerType: 'mouse', button: 0, clientX: point.clientX, clientY: point.clientY })
    expect(() => harness.frame(16)).not.toThrow()
    expect(harness.renderer.getMotionDiagnostics().activeAnimations.filter((key) => key === 'highlight:skill:2,2:scale')).toHaveLength(1)
    canvas.dispatch('pointerup', { pointerId: 52, pointerType: 'mouse', button: 0, clientX: point.clientX, clientY: point.clientY })

    expect(harness.renderer.getMotionDiagnostics().highlightCounts.skill).toBe(2)
    for (let index = 0; index < 10; index += 1) harness.frame(16)
    harness.renderer.update(structuredClone(model))
    expect(harness.renderer.getMotionDiagnostics().activeAnimations.filter((key) => (
      key.includes('highlight:skill') && (key.endsWith(':scale') || key.endsWith(':opacity'))
    ))).toEqual([])

    const cleared = structuredClone(model)
    cleared.legal.targetCells = []
    harness.renderer.update(cleared)
    expect(harness.renderer.getMotionDiagnostics().highlightCounts.skill).toBe(2)
    for (let index = 0; index < 9; index += 1) harness.frame(16)
    expect(harness.renderer.getMotionDiagnostics().highlightCounts.skill).toBe(0)
    harness.renderer.dispose()
  })

  it('retargets result outlines from their visible opacity and bounds reduced result durations', () => {
    const harness = createHarness(844, 390, false)
    const model: any = runtimeModel()
    const pieceId = model.pieces[0].id
    harness.renderer.init({ container: harness.container })
    harness.renderer.update(model)
    harness.frame(16)
    const group = harness.renderers[0].scene!.children.find((child) => child.userData.pieceId === pieceId)!
    const feedback = group.children.find((child) => child.userData.motionRole === 'feedback-ring')!

    const damaged = structuredClone(model)
    damaged.pieces[0].health.current -= 5
    harness.renderer.animateAction({ type: 'stateUpdate', motionEventKey: 'hit-1' }, model, damaged)
    for (let index = 0; index < 5; index += 1) harness.frame(16)
    const visibleOpacity = feedback.material!.opacity!
    expect(visibleOpacity).toBeGreaterThan(0)

    const healed = structuredClone(damaged)
    healed.pieces[0].health.current += 2
    harness.renderer.animateAction({ type: 'stateUpdate', motionEventKey: 'heal-1' }, damaged, healed)
    expect(feedback.material!.opacity).toBeCloseTo(visibleOpacity, 6)

    const statusAdded = structuredClone(healed)
    statusAdded.pieces[0].statuses = [{ id: 'slow', label: '减速' }]
    statusAdded.pieces[0].statusSummary = [{ id: 'slow', label: '减速' }]
    harness.renderer.animateAction({ type: 'stateUpdate', motionEventKey: 'status-add' }, healed, statusAdded)
    harness.renderer.update(statusAdded)
    const hpLayer = harness.container.children.find((child) => child.id === 'hpBarLayer3d')!
    const summary = hpLayer.children.find((child) => child.dataset.pieceId === pieceId)!
    const statuses = summary.querySelector('.piece-board-statuses')!
    expect(statuses.children).toHaveLength(1)
    expect(statuses.children[0].className).toContain('is-entering')

    const statusRemoved = structuredClone(statusAdded)
    statusRemoved.pieces[0].statuses = []
    statusRemoved.pieces[0].statusSummary = []
    harness.renderer.animateAction({ type: 'stateUpdate', motionEventKey: 'status-remove' }, statusAdded, statusRemoved)
    harness.renderer.update(statusRemoved)
    expect(statuses.children).toHaveLength(1)
    expect(statuses.children[0].className).toContain('is-exiting')

    harness.renderer.dispose()

    const reduced = createHarness(844, 390, false, true)
    const reducedModel: any = runtimeModel()
    const reducedPieceId = reducedModel.pieces[0].id
    reduced.renderer.init({ container: reduced.container })
    reduced.renderer.update(reducedModel)
    reduced.frame(16)

    const reducedDamage = structuredClone(reducedModel)
    reducedDamage.pieces[0].health.current -= 5
    reduced.renderer.animateAction({ type: 'stateUpdate', motionEventKey: 'reduced-hit' }, reducedModel, reducedDamage)
    for (let index = 0; index < 9; index += 1) reduced.frame(16)
    expect(reduced.renderer.getMotionDiagnostics().activeAnimations.some((key) => key.endsWith(':outline'))).toBe(false)

    const reducedHeal = structuredClone(reducedDamage)
    reducedHeal.pieces[0].health.current += 2
    reduced.renderer.animateAction({ type: 'stateUpdate', motionEventKey: 'reduced-heal' }, reducedDamage, reducedHeal)
    for (let index = 0; index < 9; index += 1) reduced.frame(16)
    expect(reduced.renderer.getMotionDiagnostics().activeAnimations.some((key) => key.endsWith(':outline'))).toBe(false)

    reduced.renderer.animateAction({ type: 'ui-reject', pieceId: reducedPieceId, motionEventKey: 'reduced-reject' }, reducedHeal, reducedHeal)
    for (let index = 0; index < 9; index += 1) reduced.frame(16)
    expect(reduced.renderer.getMotionDiagnostics().activeAnimations.some((key) => key.endsWith(':outline'))).toBe(false)

    const dead = structuredClone(reducedHeal)
    dead.pieces[0].health.current = 0
    dead.pieces[0].visible = false
    reduced.renderer.animateAction({ type: 'stateUpdate', motionEventKey: 'reduced-death' }, reducedHeal, dead)
    reduced.renderer.update(dead)
    for (let index = 0; index < 9; index += 1) reduced.frame(16)
    expect(reduced.renderer.getMotionDiagnostics().activeAnimations.some((key) => key.endsWith(':visibility'))).toBe(false)
    const deadGroup = reduced.renderers[0].scene!.children.find((child) => child.userData.pieceId === reducedPieceId)!
    expect(deadGroup.visible).toBe(false)
    reduced.renderer.dispose()
  })

})
