import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type VignetteModule = {
  eventCells(group: unknown, model: unknown): { source: unknown }
  groupEvents(events: unknown[]): Array<{ rootEventId: string; root: { eventId: string }; children: unknown[] }>
  createQueue(options?: Record<string, unknown>): {
    update(model: unknown): void
    skip(): boolean
    setSpeed(speed: number): void
    dispose(): void
    getDiagnostics(): { activeRootId: string | null; pendingRootIds: string[]; speed: number; playedRootCount: number }
  }
  create(options?: Record<string, unknown>): {
    mount(options: unknown): void
    update(model: unknown): void
    resize(): void
    settleAll(): void
    setSpeed(speed: number): void
    getDiagnostics(): { activeRootId: string | null; pendingRootIds: string[]; speed: number; playedRootCount: number }
    dispose(): void
  }
  constants: { normalDurationMs: number; cardDurationMs: number; reducedDurationMs: number; skipSettleMs: number }
}

class FakeElement {
  getBoundingClientRect() { return { width: 1280, height: 720 } }
  children: FakeElement[] = []
  listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>()
  attributes: Record<string, string> = {}
  dataset: Record<string, string> = {}
  parentNode: FakeElement | null = null
  className = ''
  hidden = false
  innerHTML = ''

  appendChild(child: FakeElement) {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }

  removeEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string, event: Record<string, unknown>) {
    this.listeners.get(type)?.forEach(listener => listener(event))
  }

  setAttribute(name: string, value: string) { this.attributes[name] = value }
  contains() { return true }
  remove() {
    if (!this.parentNode) return
    this.parentNode.children = this.parentNode.children.filter(child => child !== this)
    this.parentNode = null
  }
}

function loadModule(): VignetteModule {
  const windowObject: Record<string, unknown> = {
    setTimeout,
    clearTimeout,
  }
  const context = createContext({ window: windowObject, globalThis: windowObject, console, setTimeout, clearTimeout })
  new Script(readFileSync(resolve(process.cwd(), 'data/pages/js/hand-card-face.js'), 'utf8')).runInContext(context)
  const identitySource = readFileSync(resolve(process.cwd(), 'data/pages/js/battle-ui/battle-action-identity.js'), 'utf8')
  const source = readFileSync(resolve(process.cwd(), 'data/pages/js/battle-ui/battle-action-vignette.js'), 'utf8')
  new Script(identitySource, { filename: 'battle-action-identity.js' }).runInContext(context)
  new Script(source, { filename: 'battle-action-vignette.js' }).runInContext(context)
  return windowObject.BattleActionVignette as VignetteModule
}

function root(index: number, overrides: Record<string, unknown> = {}) {
  return {
    eventId: `action-${index}:0`,
    rootEventId: `action-${index}:0`,
    parentEventId: null,
    sequence: index * 10,
    kind: 'skill',
    iconId: 'action-skill',
    skippable: true,
    ...overrides,
  }
}

function child(index: number, childIndex: number, overrides: Record<string, unknown> = {}) {
  return {
    eventId: `action-${index}:${childIndex}`,
    rootEventId: `action-${index}:0`,
    parentEventId: `action-${index}:0`,
    sequence: index * 10 + childIndex,
    kind: 'damage',
    iconId: 'action-damage',
    skippable: true,
    ...overrides,
  }
}

describe('RED-167 action vignette queue', () => {
  it('keeps authority arrival order when separate actions both number their root sequence zero', () => {
    const groups = loadModule().groupEvents([root(9, { sequence: 0 }), root(1, { sequence: 0 })])
    expect(groups.map(group => group.rootEventId)).toEqual(['action-9:0', 'action-1:0'])
  })
  it('does not replay a long retained chain when its beat count exceeds the deduplication root budget', () => {
    const queue = loadModule().createQueue()
    queue.update({ presentationEvents: [], turn: { isViewerTurn: false } })
    const events = [root(1), ...Array.from({ length: 300 }, (_, i) => child(1, i + 1))]
    queue.update({ presentationEvents: events, turn: { isViewerTurn: false } })
    const pending = queue.getDiagnostics().pendingRootIds
    queue.update({ presentationEvents: events, turn: { isViewerTurn: false } })
    expect(queue.getDiagnostics().pendingRootIds).toEqual(pending)
    queue.dispose()
  })
  it('separates movement and repeated hits while keeping only one explicit same-kind batch together', () => {
    const groups = loadModule().groupEvents([
      root(1),
      child(1, 1, { kind: 'forceMove' }),
      child(1, 2, { batchId: 'hit-1' }),
      child(1, 3, { batchId: 'hit-1' }),
      child(1, 4, { batchId: 'hit-2' }),
      child(1, 5, { kind: 'heal', batchId: 'hit-2' }),
    ])
    expect(groups.map(group => [group.root.eventId, group.children.length])).toEqual([
      ['action-1:0', 0], ['action-1:1', 0], ['action-1:2', 1], ['action-1:4', 0], ['action-1:5', 0],
    ])
  })
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not invent a source at (0,0) for a card without a caster', () => {
    expect(loadModule().eventCells({ root: root(1, { kind: 'card' }), children: [] }, { pieces: [] }).source).toBeNull()
  })

  it('queues another caster pending banner after the original skill, once even across control changes', () => {
    const vignetteModule = loadModule()
    const phases: string[] = []
    const queue = vignetteModule.createQueue({ onPhase: (phase: string, group: { rootEventId: string }) => {
      if (phase === 'focus') phases.push(group.rootEventId)
    } })
    queue.update({ presentationEvents: [], turn: { isViewerTurn: false } })
    const events = [root(1, { sourcePieceId: 'attacker', skillId: 'shot' }),
      child(1, 1, { kind: 'passive', sourcePieceId: 'defender', skillId: 'counter', result: { pending: true } })]
    queue.update({ presentationEvents: events, turn: { isViewerTurn: false } })
    queue.update({ presentationEvents: events, turn: { isViewerTurn: true } })
    expect(queue.getDiagnostics().activeRootId).toBe('action-1:0')
    expect(queue.getDiagnostics().pendingRootIds).toEqual(['action-1:1'])
    vi.advanceTimersByTime(vignetteModule.constants.normalDurationMs)
    expect(phases).toEqual(['action-1:0', 'action-1:1'])
    queue.update({ presentationEvents: events, turn: { isViewerTurn: true } })
    vi.advanceTimersByTime(vignetteModule.constants.normalDurationMs)
    expect(phases).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renders a pending response with its own portrait and skill name rather than the initiating caster', () => {
    const vignetteModule = loadModule()
    const floatLayer = new FakeElement()
    const vignette = vignetteModule.create({ document: { createElement: () => new FakeElement() } })
    vignette.mount({ boardContainer: new FakeElement(), floatLayer })
    vignette.update({ presentationEvents: [], turn: { isViewerTurn: true } })
    vignette.update({ presentationEvents: [root(2, { kind: 'choiceResolved', sourcePieceId: 'reactor', skillId: 'shield' })],
      turn: { isViewerTurn: true }, pieces: [{ id: 'reactor', name: '乌瑟尔', portraitId: 'uther.jpg', faction: 'blue' }],
      skillSummariesById: { shield: { name: '圣光盾' } } })
    expect(floatLayer.children[0].className).toContain('is-skill-banner')
    expect(floatLayer.children[0].innerHTML).toContain('响应技能 · 乌瑟尔')
    expect(floatLayer.children[0].innerHTML).toContain('images/uther.jpg')
    expect(floatLayer.children[0].innerHTML).toContain('圣光盾')
    vignette.dispose()
  })

  it('keeps a concealed response neutral after a newer action replaces the current event model', () => {
    const vignetteModule = loadModule()
    const floatLayer = new FakeElement()
    const vignette = vignetteModule.create({ document: { createElement: () => new FakeElement() } })
    vignette.mount({ boardContainer: new FakeElement(), floatLayer })
    const model = { turn: { isViewerTurn: false }, pieces: [{ id: 'reactor', name: '乌瑟尔' }], skillSummariesById: { shield: { name: '圣光盾' } } }
    vignette.update({ ...model, presentationEvents: [] })
    vignette.update({ ...model, presentationEvents: [root(2, { kind: 'choiceResolved', sourcePieceId: 'reactor', skillId: 'shield' }), child(2, 1, { kind: 'concealed' })] })
    vignette.update({ ...model, presentationEvents: [root(3, { kind: 'move' })] })
    vi.advanceTimersByTime(420)
    expect(floatLayer.children[0].className).not.toContain('is-skill-banner')
    vignette.dispose()
  })

  it.each([false, true])('anchors a visible result accent and clears it after playback (reduced=%s)', (reducedMotion) => {
    const vignetteModule = loadModule()
    const floatLayer = new FakeElement()
    const projectCell = vi.fn(() => ({ left: 500, top: 400 }))
    const vignette = vignetteModule.create({ document: { createElement: () => new FakeElement() }, reducedMotion })
    vignette.mount({ boardContainer: new FakeElement(), floatLayer, projectCell })
    vignette.update({ presentationEvents: [], pieces: [], turn: { isViewerTurn: false } })
    const model = { presentationEvents: [root(1), child(1, 1, { targetPieceIds: ['victim'] })], pieces: [{ id: 'victim', x: 3, y: 4 }], turn: { isViewerTurn: false } }
    const before = JSON.stringify(model)
    vignette.update(model)
    if (!reducedMotion) vi.advanceTimersByTime(420)
    const layer = floatLayer.children[0]
    expect(layer.innerHTML).not.toContain('battle-comic-beat is-damage')
    expect(layer.innerHTML).not.toContain('砰!')
    expect(layer.innerHTML).not.toContain('恢复!')
    // Numeric feedback is owned by the renderer, without a duplicate vignette label.
    expect(JSON.stringify(model)).toBe(before)
    vi.advanceTimersByTime(2200)
    expect(layer.hidden).toBe(true)
    vignette.dispose()
    expect(floatLayer.children).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['concealed', 'death'])('does not invent coordinates for %s with no visible target', (kind) => {
    const vignetteModule = loadModule()
    const floatLayer = new FakeElement()
    const projectCell = vi.fn()
    const vignette = vignetteModule.create({ document: { createElement: () => new FakeElement() } })
    vignette.mount({ boardContainer: new FakeElement(), floatLayer, projectCell })
    vignette.update({ presentationEvents: [], pieces: [], turn: { isViewerTurn: false } })
    vignette.update({ presentationEvents: [root(1), child(1, 1, { kind, targetPieceIds: kind === 'death' ? ['removed-target'] : [] })], pieces: [], turn: { isViewerTurn: false } })
    vi.advanceTimersByTime(420)
    expect(floatLayer.children[0].innerHTML).not.toContain('battle-comic-beat')
    expect(projectCell).not.toHaveBeenCalled()
    vignette.dispose()
  })

  it('groups children under stable roots and rejects orphan child-only groups', () => {
    const vignetteModule = loadModule()
    const groups = vignetteModule.groupEvents([
      child(2, 2),
      root(2),
      child(2, 1),
      child(3, 1),
      root(1),
      root(2),
    ])

    expect(groups.map(group => group.rootEventId)).toEqual(['action-1:0', 'action-2:0', 'action-2:1', 'action-2:2'])
    expect(groups.every(group => group.children.length === 0)).toBe(true)
  })

  it('plays five authoritative roots once in stable order without overlapping', () => {
    const vignetteModule = loadModule()
    const phases: string[] = []
    const actionKinds = ['move', 'skill', 'card', 'passive', 'statusAdded']
    const queue = vignetteModule.createQueue({
      onPhase: (phase: string, group: { rootEventId: string }) => phases.push(`${group.rootEventId}:${phase}`),
    })
    queue.update({ presentationEvents: [], turn: { isViewerTurn: false } })
    for (let index = 1; index <= 5; index += 1) {
      queue.update({
        presentationEvents: [root(index, { kind: actionKinds[index - 1] }), child(index, 1)],
        turn: { isViewerTurn: false },
      })
    }

    expect(queue.getDiagnostics().activeRootId).toBe('action-1:0')
    expect(queue.getDiagnostics().pendingRootIds).toEqual([
      'action-1:1', 'action-2:0', 'action-2:1', 'action-3:0', 'action-3:1', 'action-4:0', 'action-4:1', 'action-5:0', 'action-5:1',
    ])
    vi.advanceTimersByTime(vignetteModule.constants.normalDurationMs * 9 + vignetteModule.constants.cardDurationMs)
    queue.update({ presentationEvents: [root(5), child(5, 1)], turn: { isViewerTurn: false } })

    expect(phases.filter(value => value.endsWith(':focus'))).toEqual([
      'action-1:0:focus', 'action-1:1:focus', 'action-2:0:focus', 'action-2:1:focus', 'action-3:0:focus', 'action-3:1:focus',
      'action-4:0:focus', 'action-4:1:focus', 'action-5:0:focus', 'action-5:1:focus',
    ])
    expect(queue.getDiagnostics()).toMatchObject({
      activeRootId: null,
      pendingRootIds: [],
      playedRootCount: 5,
    })
  })

  it('settles a skipped action within 100ms and consumes one queued root at a time', () => {
    const vignetteModule = loadModule()
    const phases: string[] = []
    const queue = vignetteModule.createQueue({
      onPhase: (phase: string, group: { rootEventId: string }) => phases.push(`${group.rootEventId}:${phase}`),
    })
    queue.update({ presentationEvents: [], turn: { isViewerTurn: false } })
    queue.update({ presentationEvents: [root(1)], turn: { isViewerTurn: false } })
    queue.update({ presentationEvents: [root(2)], turn: { isViewerTurn: false } })
    vi.advanceTimersByTime(200)

    expect(queue.skip()).toBe(true)
    expect(phases.at(-1)).toBe('action-1:0:settle')
    vi.advanceTimersByTime(vignetteModule.constants.skipSettleMs)
    expect(queue.getDiagnostics().activeRootId).toBe('action-2:0')
  })

  it('uses rapid consecutive clicks to settle consecutive roots instead of delaying one root', () => {
    const vignetteModule = loadModule()
    const phases: string[] = []
    const queue = vignetteModule.createQueue({
      onPhase: (phase: string, group: { rootEventId: string }) => phases.push(`${group.rootEventId}:${phase}`),
    })
    queue.update({ presentationEvents: [], turn: { isViewerTurn: false } })
    queue.update({ presentationEvents: [root(1)], turn: { isViewerTurn: false } })
    queue.update({ presentationEvents: [root(2)], turn: { isViewerTurn: false } })

    expect(queue.skip()).toBe(true)
    vi.advanceTimersByTime(20)
    expect(queue.skip()).toBe(true)
    expect(phases).toContain('action-1:0:settle')
    expect(phases).toContain('action-2:0:settle')
    expect(queue.getDiagnostics().activeRootId).toBe('action-2:0')
    vi.advanceTimersByTime(vignetteModule.constants.skipSettleMs)
    expect(queue.getDiagnostics().activeRootId).toBeNull()
  })

  it('halves timing at 2x without changing order and uses a static reduced-motion beat', () => {
    const vignetteModule = loadModule()
    const normalOrder: string[] = []
    const queue = vignetteModule.createQueue({
      onPhase: (phase: string, group: { rootEventId: string }) => {
        if (phase === 'focus') normalOrder.push(group.rootEventId)
      },
    })
    queue.update({ presentationEvents: [], turn: { isViewerTurn: false } })
    queue.setSpeed(2)
    queue.update({ presentationEvents: [root(1)], turn: { isViewerTurn: false } })
    queue.update({ presentationEvents: [root(2)], turn: { isViewerTurn: false } })
    vi.advanceTimersByTime(vignetteModule.constants.normalDurationMs)
    expect(normalOrder).toEqual(['action-1:0', 'action-2:0'])
    expect(queue.getDiagnostics().speed).toBe(2)

    const reducedPhases: string[] = []
    const reduced = vignetteModule.createQueue({
      reducedMotion: true,
      onPhase: (phase: string) => reducedPhases.push(phase),
    })
    reduced.update({ presentationEvents: [], turn: { isViewerTurn: false } })
    reduced.update({ presentationEvents: [root(3)], turn: { isViewerTurn: false } })
    expect(reducedPhases).toEqual(['static'])
    vi.advanceTimersByTime(vignetteModule.constants.reducedDurationMs)
    expect(reduced.getDiagnostics().activeRootId).toBeNull()
  })

  it('retimes the currently playing action when 2x is toggled mid-flight', () => {
    const vignetteModule = loadModule()
    const queue = vignetteModule.createQueue({ now: () => Date.now() })
    queue.update({ presentationEvents: [], turn: { isViewerTurn: false } })
    queue.update({ presentationEvents: [root(1)], turn: { isViewerTurn: false } })
    vi.advanceTimersByTime(100)

    queue.setSpeed(2)
    vi.advanceTimersByTime(499)
    expect(queue.getDiagnostics().activeRootId).toBe('action-1:0')
    vi.advanceTimersByTime(1)
    expect(queue.getDiagnostics().activeRootId).toBeNull()
  })

  it('holds each played card before the next card or pending skill and retimes the remaining hold', () => {
    const vignetteModule = loadModule()
    const queue = vignetteModule.createQueue({ now: () => Date.now() })
    queue.update({ presentationEvents: [], turn: { isViewerTurn: true } })
    queue.update({ presentationEvents: [root(1, { kind: 'card', cardId: 'coin' }),
      root(2, { kind: 'card', cardId: 'heal' }), child(2, 1, { kind: 'passive', skillId: 'reaction', sourcePieceId: 'other', result: { pending: true } })], turn: { isViewerTurn: true } })
    vi.advanceTimersByTime(1000)
    expect(queue.getDiagnostics().activeRootId).toBe('action-1:0')
    queue.setSpeed(2)
    vi.advanceTimersByTime(399)
    expect(queue.getDiagnostics().activeRootId).toBe('action-1:0')
    vi.advanceTimersByTime(1)
    expect(queue.getDiagnostics().activeRootId).toBe('action-2:0')
    vi.advanceTimersByTime(vignetteModule.constants.cardDurationMs / 2)
    expect(queue.getDiagnostics().activeRootId).toBe('action-2:1')
    queue.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renders the public played card with the shared face after it leaves the hand, but never looks up hidden cards', () => {
    const vignetteModule = loadModule()
    const floatLayer = new FakeElement()
    const getCardDefinition = vi.fn(() => ({ name: '幸运币', description: '获得1点行动点。', actionPointCost: 0, image: 'coin.png' }))
    const vignette = vignetteModule.create({ document: { createElement: () => new FakeElement() }, getCardDefinition })
    vignette.mount({ boardContainer: new FakeElement(), floatLayer })
    const model = { presentationEvents: [] as unknown[], pieces: [], turn: { isViewerTurn: true } }
    vignette.update(model)
    vignette.update({ ...model, presentationEvents: [root(1, { kind: 'card', cardId: 'coin' })] })
    const layer = floatLayer.children[0]
    expect(layer.className).toContain('is-card-reveal')
    expect(layer.innerHTML).toContain('images/card-art/coin.png')
    expect(layer.innerHTML).toContain('幸运币')
    expect(layer.innerHTML).toContain('获得1点行动点。')
    expect(layer.innerHTML).not.toContain('battle-vignette-action-name')
    vi.advanceTimersByTime(vignetteModule.constants.cardDurationMs)
    vignette.update({ ...model, presentationEvents: [root(2, { kind: 'concealed', cardId: 'secret' })] })
    expect(getCardDefinition).toHaveBeenCalledTimes(1)
    expect(layer.innerHTML).not.toContain('幸运币')
    expect(layer.innerHTML).not.toContain('secret')
    vignette.dispose()
  })

  it('accepts late card metadata only for the same active reveal and ignores it after skipping', async () => {
    const vignetteModule = loadModule()
    const floatLayer = new FakeElement()
    let deliver!: (value: unknown) => void
    const getCardDefinition = vi.fn(() => new Promise(resolve => { deliver = resolve }))
    const vignette = vignetteModule.create({ document: { createElement: () => new FakeElement() }, getCardDefinition, now: () => Date.now() })
    vignette.mount({ boardContainer: new FakeElement(), floatLayer })
    const model = { presentationEvents: [] as unknown[], pieces: [], turn: { isViewerTurn: true } }
    vignette.update(model)
    vignette.update({ ...model, presentationEvents: [root(1, { kind: 'card', cardId: 'late' })] })
    expect(floatLayer.children[0].innerHTML).toContain('资料暂不可用')
    vi.advanceTimersByTime(900)
    deliver({ name: '迟到卡牌', description: '真实描述', actionPointCost: 2 })
    await Promise.resolve()
    expect(floatLayer.children[0].innerHTML).toContain('真实描述')
    expect(floatLayer.children[0].innerHTML).toContain('--banner-elapsed:-900ms')
    vi.advanceTimersByTime(vignetteModule.constants.cardDurationMs)
    vignette.update({ ...model, presentationEvents: [root(2, { kind: 'card', cardId: 'later' })] })
    vignette.settleAll()
    vignette.update({ ...model, presentationEvents: [root(3, { kind: 'move' })] })
    deliver({ name: '过期卡牌', description: '不可覆盖移动' })
    await Promise.resolve()
    expect(floatLayer.children[0].innerHTML).not.toContain('过期卡牌')
    expect(floatLayer.children[0].className).toContain('is-action-banner')
    vignette.dispose()
  })

  it('fast-settles the active queue when control returns to the viewer and disposes all timers', () => {
    const vignetteModule = loadModule()
    const phases: string[] = []
    const queue = vignetteModule.createQueue({ onPhase: (phase: string) => phases.push(phase) })
    queue.update({ presentationEvents: [], turn: { isViewerTurn: false } })
    queue.update({ presentationEvents: [root(1)], turn: { isViewerTurn: false } })
    queue.update({ presentationEvents: [root(2)], turn: { isViewerTurn: false } })
    queue.update({ presentationEvents: [root(2)], turn: { isViewerTurn: true } })

    expect(phases).toContain('settle')
    expect(queue.getDiagnostics()).toMatchObject({ activeRootId: null, pendingRootIds: [] })
    queue.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('plays a newly committed skill root during the viewer own turn', () => {
    const vignetteModule = loadModule()
    const phases: string[] = []
    const queue = vignetteModule.createQueue({
      onPhase: (phase: string, group: { rootEventId: string }) => phases.push(`${group.rootEventId}:${phase}`),
    })
    queue.update({ presentationEvents: [], turn: { isViewerTurn: true } })
    queue.update({ presentationEvents: [root(1)], turn: { isViewerTurn: true } })

    expect(phases).toEqual(['action-1:0:focus'])
    expect(queue.getDiagnostics().activeRootId).toBe('action-1:0')
  })

  it('settles the opponent action before playing a new root committed as control returns', () => {
    const vignetteModule = loadModule()
    const phases: string[] = []
    const queue = vignetteModule.createQueue({
      onPhase: (phase: string, group: { rootEventId: string }) => phases.push(`${group.rootEventId}:${phase}`),
    })
    queue.update({ presentationEvents: [], turn: { isViewerTurn: false } })
    queue.update({ presentationEvents: [root(1)], turn: { isViewerTurn: false } })
    queue.update({ presentationEvents: [root(1), root(2)], turn: { isViewerTurn: true } })

    expect(phases).toEqual([
      'action-1:0:focus',
      'action-1:0:settle',
      'action-2:0:focus',
    ])
    expect(queue.getDiagnostics().activeRootId).toBe('action-2:0')
  })

  it('runs a three-minute 16-piece queue without retaining timers or unbounded roots', () => {
    const vignetteModule = loadModule()
    const queue = vignetteModule.createQueue()
    const pieces = Array.from({ length: 16 }, (_, index) => ({
      id: `piece-${index}`,
      x: index % 8,
      y: Math.floor(index / 8),
    }))
    queue.update({ presentationEvents: [], pieces, turn: { isViewerTurn: false } })
    for (let index = 1; index <= 160; index += 1) {
      queue.update({
        presentationEvents: [root(index, {
          sourcePieceId: pieces[index % pieces.length].id,
          targetPieceIds: [pieces[(index + 1) % pieces.length].id],
        })],
        pieces,
        turn: { isViewerTurn: false },
      })
    }

    vi.advanceTimersByTime(180_000)

    expect(queue.getDiagnostics()).toMatchObject({
      activeRootId: null,
      pendingRootIds: [],
      playedRootCount: 160,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renders projectile travel to the authoritative endpoint and consumes pointer/click skip input', () => {
    const vignetteModule = loadModule()
    const floatLayer = new FakeElement()
    const board = new FakeElement()
    const windowListeners = new Map<string, Set<(event: Record<string, unknown>) => void>>()
    let now = 1000
    const windowObject = {
      setTimeout,
      clearTimeout,
      matchMedia: () => ({ matches: false }),
      addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set())
        windowListeners.get(type)!.add(listener)
      },
      removeEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
        windowListeners.get(type)?.delete(listener)
      },
    }
    const documentObject = { createElement: () => new FakeElement() }
    const showAreaFlash = vi.fn()
    const clearAreaFlash = vi.fn()
    const showPath = vi.fn()
    const clearPath = vi.fn()
    const vignette = vignetteModule.create({
      document: documentObject,
      window: windowObject,
      now: () => now,
      icons: {
        resolveAction: () => ({ label: '弹射物', assetPath: 'images/effect-icons/action-skill.svg', color: '#60a5fa' }),
      },
    })
    vignette.mount({
      boardContainer: board,
      floatLayer,
      showAreaFlash,
      clearAreaFlash,
      showPath,
      clearPath,
    })
    vignette.update({ presentationEvents: [], pieces: [], turn: { isViewerTurn: false } })
    vignette.update({
      pieces: [
        { id: 'source', name: '阿尔萨斯', portraitId: 'arthas.jpg', faction: 'blue', x: 0, y: 0 },
        { id: 'actual-target', x: 4, y: 0 },
      ],
      skillSummariesById: {
        'arthas-icebound-fortitude': { id: 'arthas-icebound-fortitude', name: '寒冰坚忍' },
      },
      turn: { isViewerTurn: false },
      presentationEvents: [root(1, {
        sourcePieceId: 'source',
        skillId: 'arthas-icebound-fortitude',
        targetCell: { x: 1, y: 0 },
        presentation: {
          cue: 'projectile',
          selectedCell: { x: 1, y: 0 },
          pathCells: [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }],
          endPoint: { x: 4, y: 0 },
          endReason: 'hit',
        },
      }), child(1, 1, {
        targetPieceIds: ['actual-target'], result: { amount: 4 },
      }), child(1, 2, {
        kind: 'statusAdded', iconId: 'status-add', targetPieceIds: ['actual-target'],
        statusType: 'stunned', result: { stacks: 1 },
      })],
    })

    const layer = floatLayer.children[0]
    expect(layer.hidden).toBe(false)
    vi.advanceTimersByTime(120)
    expect(showPath).toHaveBeenCalledWith({
      source: { x: 0, y: 0 },
      end: { x: 4, y: 0 },
      selected: { x: 1, y: 0 },
    })
    expect(layer.innerHTML).not.toContain('battle-vignette-path-segment')
    expect(layer.innerHTML).not.toContain('battle-vignette-point')
    expect(layer.innerHTML).not.toContain('battle-vignette-action-icon')
    expect(layer.innerHTML).toContain('class="battle-vignette-avatar"')
    expect(layer.innerHTML).toContain('src="images/arthas.jpg"')
    expect(layer.innerHTML).toContain('寒冰坚忍')
    expect(layer.innerHTML).not.toContain('使用技能')
    expect(layer.innerHTML).not.toContain('images/effect-icons/action-skill.svg')
    vi.advanceTimersByTime(300)
    expect(layer.innerHTML).not.toContain('battle-vignette-result')
    expect(layer.innerHTML).not.toContain('>4<')

    const speedPointerEvent = {
      target: { closest: () => ({ dataset: { vignetteControl: 'speed' } }) },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    }
    layer.dispatch('pointerdown', speedPointerEvent)
    expect(speedPointerEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(layer.dataset.phase).toBe('result')

    const event = {
      target: { closest: () => null },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    }
    layer.dispatch('pointerdown', event)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
    expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(1)
    expect(layer.dataset.phase).toBe('settle')
    vi.advanceTimersByTime(vignetteModule.constants.skipSettleMs)
    expect(layer.dataset.rootId).toBe('action-1:1')
    vignette.settleAll()
    expect(layer.hidden).toBe(true)

    now += 20
    const trailingClick = {
      target: {},
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    }
    windowListeners.get('click')?.forEach(listener => listener(trailingClick))
    expect(trailingClick.preventDefault).toHaveBeenCalledTimes(1)

    vignette.update({
      pieces: [{ id: 'source', x: 0, y: 0 }],
      turn: { isViewerTurn: false },
      presentationEvents: [root(2, {
        sourcePieceId: 'source',
        presentation: {
          cue: 'area', selectedCell: { x: 2, y: 1 }, endPoint: { x: 2, y: 1 },
          endReason: 'resolved', pathCells: [],
          areaCells: [{ x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }],
        },
      })],
    })
    showAreaFlash.mockClear()
    showPath.mockClear()
    vi.advanceTimersByTime(120)
    expect(layer.className).toContain('is-cue-area')
    expect(showAreaFlash).toHaveBeenCalledWith([
      { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 },
    ])
    expect(showPath).toHaveBeenCalledWith({ selected: { x: 2, y: 1 } })
    expect(layer.innerHTML).not.toContain('battle-vignette-point')
    expect(layer.innerHTML).not.toContain('battle-vignette-area-flash')
    expect(layer.innerHTML).not.toContain('battle-vignette-path-segment')
    expect(layer.innerHTML).not.toContain('battle-vignette-action-icon')
    vignette.dispose()
    expect(clearAreaFlash).toHaveBeenCalled()
    expect(clearPath).toHaveBeenCalled()
    expect(floatLayer.children).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps an idle speed control available and applies its choice without skipping the next vignette', () => {
    const vignetteModule = loadModule()
    const floatLayer = new FakeElement()
    const board = new FakeElement()
    const documentObject = { createElement: () => new FakeElement() }
    const vignette = vignetteModule.create({
      document: documentObject,
      window: {
        setTimeout,
        clearTimeout,
        matchMedia: () => ({ matches: false }),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    })

    vignette.mount({ boardContainer: board, floatLayer })

    const speedControl = floatLayer.children.find(child => child.className === 'battle-vignette-speed-control')
    expect(speedControl).toBeDefined()
    expect(speedControl?.hidden).toBe(false)
    expect(speedControl?.innerHTML).toBe('1×')
    expect(speedControl?.attributes['aria-pressed']).toBe('false')

    const speedClick = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    }
    speedControl?.dispatch('click', speedClick)

    expect(speedClick.preventDefault).toHaveBeenCalledTimes(1)
    expect(speedClick.stopPropagation).toHaveBeenCalledTimes(1)
    expect(speedControl?.innerHTML).toBe('2×')
    expect(speedControl?.attributes['aria-pressed']).toBe('true')
    expect(vignette.getDiagnostics().speed).toBe(2)

    vignette.update({ presentationEvents: [], pieces: [], turn: { isViewerTurn: false } })
    vignette.update({ presentationEvents: [root(91)], pieces: [], turn: { isViewerTurn: false } })
    expect(vignette.getDiagnostics().activeRootId).toBe('action-91:0')

    speedControl?.dispatch('click', speedClick)
    expect(vignette.getDiagnostics()).toMatchObject({ activeRootId: 'action-91:0', speed: 1 })

    vignette.setSpeed(2)
    vi.advanceTimersByTime(vignetteModule.constants.normalDurationMs / 2)
    expect(vignette.getDiagnostics().activeRootId).toBeNull()
    expect(speedControl?.hidden).toBe(false)
    expect(speedControl?.innerHTML).toBe('2×')

    vignette.dispose()
    expect(floatLayer.children).toHaveLength(0)
  })

  it.each([
    ['focus', 0],
    ['path', 120],
    ['result', 420],
  ] as const)('consumes battlefield input during %s without changing commands, logs, payloads, or hash', (phase, elapsedMs) => {
    const vignetteModule = loadModule()
    const floatLayer = new FakeElement()
    const board = new FakeElement()
    let battlePointerCount = 0
    const submittedPayloads: unknown[] = []
    board.addEventListener('pointerdown', () => { battlePointerCount += 1 })
    const windowObject = {
      setTimeout,
      clearTimeout,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const vignette = vignetteModule.create({
      document: { createElement: () => new FakeElement() },
      window: windowObject,
      icons: { resolveAction: () => ({ label: '技能', assetPath: '', color: '#60a5fa' }) },
      onIntent: (payload: unknown) => submittedPayloads.push(payload),
    })
    vignette.mount({
      boardContainer: board,
      floatLayer,
      projectCell: (x: number, y: number) => ({ left: x * 10, top: y * 10 }),
    })
    vignette.update({ presentationEvents: [], pieces: [], turn: { isViewerTurn: false } })
    const model = {
      stateHash: 'stable-hash',
      actions: [{ type: 'damage', payload: { amount: 3 } }],
      log: [{ message: 'settled' }],
      pieces: [{ id: 'source', x: 0, y: 0 }, { id: 'target', x: 2, y: 0 }],
      turn: { isViewerTurn: false },
      presentationEvents: [root(90, {
        sourcePieceId: 'source',
        targetPieceIds: ['target'],
        presentation: {
          cue: 'projectile', selectedCell: { x: 1, y: 0 },
          pathCells: [{ x: 1, y: 0 }, { x: 2, y: 0 }],
          endPoint: { x: 2, y: 0 }, endReason: 'hit',
        },
      })],
    }
    const before = structuredClone(model)
    vignette.update(model)
    if (elapsedMs > 0) vi.advanceTimersByTime(elapsedMs)
    const layer = floatLayer.children[0]
    expect(layer.dataset.phase).toBe(phase)

    const event = {
      target: { closest: () => null },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    }
    layer.dispatch('pointerdown', event)
    if (!event.stopPropagation.mock.calls.length) board.dispatch('pointerdown', event)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
    expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(1)
    expect(battlePointerCount).toBe(0)
    expect(submittedPayloads).toEqual([])
    expect(model).toEqual(before)
    vignette.dispose()
  })
})
