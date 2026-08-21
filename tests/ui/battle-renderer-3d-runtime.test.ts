import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { createRed68BattleFixture } from './fixtures/red-68-battle-fixture'

const pagesDir = resolve(process.cwd(), 'data/pages')
type ThreeMaterial = { emissive: { getHex(): number }; emissiveIntensity: number; dispose(): void }
type ThreeNode = { type: string; children: ThreeNode[]; visible: boolean; material?: ThreeMaterial }
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

function createHarness(width = 390, height = 844, coarsePointer = true) {
  const container = new FakeElement('div')
  container.rect = { left: 0, top: 0, width, height }
  const renderers: FakeRendererRecord[] = []
  const observers: Array<{ disconnected: boolean }> = []
  const rafCallbacks = new Map<number, (now: number) => void>()
  const cancelledRafs = new Set<number>()
  const disposeCounts = { geometry: 0, material: 0 }
  let nextRafId = 1
  let now = 0

  const document = {
    createElement(tagName: string) { return new FakeElement(tagName) },
    getElementById() { return null },
  }
  const windowObject: WindowHarness = {
    devicePixelRatio: 1,
    matchMedia(query: string) { return { matches: coarsePointer && query.includes('pointer: coarse') } },
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
  new Script(readFileSync(resolve(pagesDir, 'js/battle-renderer-3d.js'), 'utf8'), { filename: 'battle-renderer-3d.js' }).runInContext(context)

  function frame(step = 100) {
    now += step
    const next = Array.from(rafCallbacks.entries()).sort((a, b) => a[0] - b[0])[0]
    if (!next) return
    rafCallbacks.delete(next[0])
    next[1](now)
  }

  return { container, windowObject, renderers, observers, rafCallbacks, cancelledRafs, disposeCounts, frame, renderer: windowObject.BattleRenderer3D! }
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
  }
}

function distance(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

describe('RED-68 BattleRenderer3D runtime', () => {
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
    const horizontal = harness.renderer.projectCell(11, 8)
    const vertical = harness.renderer.projectCell(10, 9)
    expect(Math.min(distance(center, horizontal), distance(center, vertical))).toBeGreaterThanOrEqual(43.5)

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

  it('makes the board plane visibly rake on one axis and fill the desktop canvas', () => {
    const harness = createHarness(1280, 720, false)
    const model = runtimeModel()
    harness.renderer.init({ container: harness.container })
    harness.renderer.update(model)
    harness.frame()

    const left = harness.renderer.projectCell(0, 8)
    const right = harness.renderer.projectCell(19, 8)
    const backLeft = harness.renderer.projectCell(0, 0)
    const frontLeft = harness.renderer.projectCell(0, 15)

    expect(distance(left, right) / 1280).toBeGreaterThanOrEqual(0.78)
    const projectedCellWidth = distance(left, right) / 19
    const projectedCellDepth = distance(backLeft, frontLeft) / 15
    expect(projectedCellDepth / projectedCellWidth).toBeCloseTo(Math.cos(45 * Math.PI / 180), 2)
    expect(Math.abs(frontLeft.clientX - backLeft.clientX)).toBeLessThan(0.001)
    expect(harness.renderer.screenToCell(backLeft.clientX, backLeft.clientY)).toEqual({ x: 0, y: 0 })
    expect(harness.renderer.screenToCell(frontLeft.clientX, frontLeft.clientY)).toEqual({ x: 0, y: 15 })
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
    expect(harness.disposeCounts.material - materialDisposalsBefore).toBe(3)
    harness.renderer.dispose()
  })
})
