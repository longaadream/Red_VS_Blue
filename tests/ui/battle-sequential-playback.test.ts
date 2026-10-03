/* eslint-disable @typescript-eslint/no-explicit-any -- Executes the untyped browser modules and inspects rendered models. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, Script } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function setup() {
  // These globals are the real browser modules; only drawing and DOM mounting
  // are replaced. Timers drive the production queue and presentation together.
  const window: Record<string, any> = { setTimeout, clearTimeout }
  const context = createContext({ window, globalThis: window, setTimeout, clearTimeout, console, Date })
  for (const file of ['battle-view-model', 'battle-action-vignette', 'battle-presentation']) {
    new Script(readFileSync(resolve('data/pages/js/battle-ui/' + file + '.js'), 'utf8')).runInContext(context)
  }
  let callbacks: Record<string, any> = {}
  const queue = window.BattleActionVignette.createQueue({
    onPhase: (phase: string, group: unknown) => callbacks.onPlaybackPhase(phase, group),
    onIdle: () => callbacks.onPlaybackIdle(),
  })
  const frames: any[] = []
  const renderer = { init: vi.fn(), update: (model: unknown) => frames.push(JSON.parse(JSON.stringify(model))),
    animateAction: vi.fn(), spawnFloater: vi.fn(), dispose: vi.fn(), settlePresentation: vi.fn((model: unknown) => frames.push(JSON.parse(JSON.stringify(model)))) }
  const vignetteUi = { ...queue, sequencesBoard: true, mount: (input: unknown) => { callbacks = input as typeof callbacks } }
  const presentation = window.BattlePresentation.create({ renderer, domUi: { update() {}, dispose() {} }, vignetteUi })
  presentation.mount({})
  return { presentation, queue, frames, renderer, normalize: window.BattleViewModel.normalizePresentationEvents }
}

function model(hp = 20, events: unknown[] = [], isViewerTurn = false) {
  return { board: { id: 'board', tiles: [] }, effects: [], viewer: { id: 'blue' }, turn: { isViewerTurn }, presentationEvents: events,
    pieces: [{ id: 'target', x: 1, y: 1, visible: true, health: { current: hp, max: 20 }, statuses: [], statusSummary: [] }] }
}
function events() {
  return [
    { eventId: 'hit:0', rootEventId: 'hit:0', kind: 'skill', sequence: 0 },
    { eventId: 'hit:1', rootEventId: 'hit:0', parentEventId: 'hit:0', kind: 'damage', targetPieceIds: ['target'], result: { amount: 3, value: 17 }, sequence: 1 },
    { eventId: 'hit:2', rootEventId: 'hit:0', parentEventId: 'hit:0', kind: 'damage', targetPieceIds: ['target'], result: { amount: 3, value: 14 }, sequence: 2 },
  ]
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('sequential board playback', () => {
  it('starts movement presentation at focus and keeps a following hit behind the movement beat', () => {
    const { presentation, frames, renderer } = setup()
    const before: any = {
      ...model(20),
      pieces: [
        { id: 'source', x: 0, y: 1, visible: true, health: { current: 10, max: 10 }, statuses: [], statusSummary: [] },
        { id: 'target', x: 2, y: 1, visible: true, health: { current: 20, max: 20 }, statuses: [], statusSummary: [] },
      ],
    }
    const sequence = [
      { eventId: 'move:0', rootEventId: 'move:0', kind: 'move', sourcePieceId: 'source', sequence: 0,
        result: { fromX: 0, fromY: 1, toX: 1, toY: 1 }, presentation: { pathCells: [{ x: 0, y: 1 }, { x: 1, y: 1 }] } },
      { eventId: 'move:1', rootEventId: 'move:0', parentEventId: 'move:0', kind: 'damage', targetPieceIds: ['target'],
        result: { amount: 3, value: 17 }, sequence: 1 },
    ]
    const after: any = { ...before, pieces: before.pieces.map((piece: any) => piece.id === 'source'
      ? { ...piece, x: 1 }
      : { ...piece, health: { current: 17, max: 20 } }), presentationEvents: sequence }
    before.presentationEvents = []
    presentation.update(before)
    presentation.update(after)

    expect(renderer.animateAction).toHaveBeenCalledTimes(1)
    expect(frames.at(-1).pieces.find((piece: any) => piece.id === 'target').health.current).toBe(20)
    vi.advanceTimersByTime(199)
    expect(frames.at(-1).pieces.find((piece: any) => piece.id === 'target').health.current).toBe(20)
    vi.advanceTimersByTime(1)
    expect(frames.at(-1).pieces.find((piece: any) => piece.id === 'target').health.current).toBe(20)
    vi.advanceTimersByTime(84)
    expect(frames.at(-1).pieces.find((piece: any) => piece.id === 'target').health.current).toBe(17)
    presentation.dispose()
  })

  it.each([
    ['long walk', { fromX: 0, fromY: 1, toX: 5, toY: 1, movementKind: 'walk' }, 160],
    ['dash', { fromX: 0, fromY: 1, toX: 1, toY: 1, movementKind: 'dash' }, 145],
  ] as const)('at 2× playback keeps a following hit behind the %s renderer duration', (_label, movement, physicalDuration) => {
    const { presentation, frames, renderer, queue } = setup()
    const before: any = {
      ...model(20),
      pieces: [
        { id: 'source', x: movement.fromX, y: movement.fromY, visible: true, health: { current: 10, max: 10 }, statuses: [], statusSummary: [] },
        { id: 'target', x: 6, y: 1, visible: true, health: { current: 20, max: 20 }, statuses: [], statusSummary: [] },
      ],
    }
    const sequence = [
      { eventId: 'move:0', rootEventId: 'move:0', kind: 'move', sourcePieceId: 'source', sequence: 0,
        result: movement, presentation: { pathCells: [{ x: movement.fromX, y: movement.fromY }, { x: movement.toX, y: movement.toY }] } },
      { eventId: 'move:1', rootEventId: 'move:0', parentEventId: 'move:0', kind: 'damage', targetPieceIds: ['target'],
        result: { amount: 3, value: 17 }, sequence: 1 },
    ]
    const after: any = { ...before, pieces: before.pieces.map((piece: any) => piece.id === 'source'
      ? { ...piece, x: movement.toX, y: movement.toY }
      : { ...piece, health: { current: 17, max: 20 } }), presentationEvents: sequence }
    before.presentationEvents = []
    queue.setSpeed(2)
    presentation.update(before)
    presentation.update(after)

    expect(renderer.animateAction).toHaveBeenCalledTimes(1)
    expect(frames.at(-1).pieces.find((piece: any) => piece.id === 'target').health.current).toBe(20)
    vi.advanceTimersByTime(physicalDuration - 1)
    expect(frames.at(-1).pieces.find((piece: any) => piece.id === 'target').health.current).toBe(20)
    vi.advanceTimersByTime(1)
    expect(frames.at(-1).pieces.find((piece: any) => piece.id === 'target').health.current).toBe(20)
    // The following damage beat starts only after the physical movement beat;
    // its result phase is 42ms at 2×.
    vi.advanceTimersByTime(42)
    expect(frames.at(-1).pieces.find((piece: any) => piece.id === 'target').health.current).toBe(17)
    presentation.dispose()
  })

  it('keeps a long movement ahead of the next beat when playback slows from 2× to 1×', () => {
    const { presentation, frames, queue } = setup()
    const before: any = {
      ...model(20),
      pieces: [
        { id: 'source', x: 0, y: 1, visible: true, health: { current: 10, max: 10 }, statuses: [], statusSummary: [] },
        { id: 'target', x: 6, y: 1, visible: true, health: { current: 20, max: 20 }, statuses: [], statusSummary: [] },
      ],
    }
    const sequence = [
      { eventId: 'move:0', rootEventId: 'move:0', kind: 'move', sourcePieceId: 'source', sequence: 0,
        result: { fromX: 0, fromY: 1, toX: 5, toY: 1, movementKind: 'walk' },
        presentation: { pathCells: [{ x: 0, y: 1 }, { x: 5, y: 1 }] } },
      { eventId: 'move:1', rootEventId: 'move:0', parentEventId: 'move:0', kind: 'damage', targetPieceIds: ['target'],
        result: { amount: 3, value: 17 }, sequence: 1 },
    ]
    const after: any = { ...before, pieces: before.pieces.map((piece: any) => piece.id === 'source'
      ? { ...piece, x: 5 }
      : { ...piece, health: { current: 17, max: 20 } }), presentationEvents: sequence }
    before.presentationEvents = []
    queue.setSpeed(2)
    presentation.update(before)
    presentation.update(after)
    vi.advanceTimersByTime(50)
    queue.setSpeed(1)

    vi.advanceTimersByTime(109)
    expect(frames.at(-1).pieces.find((piece: any) => piece.id === 'target').health.current).toBe(20)
    vi.advanceTimersByTime(1)
    expect(frames.at(-1).pieces.find((piece: any) => piece.id === 'target').health.current).toBe(20)
    vi.advanceTimersByTime(84)
    expect(frames.at(-1).pieces.find((piece: any) => piece.id === 'target').health.current).toBe(17)
    presentation.dispose()
  })

  it.each(['statusAdded', 'statusRemoved', 'tileEffectAdded', 'tileEffectRemoved'])('renders every member of an explicit %s batch in the same update', kind => {
    const { presentation, frames, queue } = setup()
    const isTile = kind.startsWith('tile')
    const removing = kind.endsWith('Removed')
    const statuses = ['a','b','c'].map(id => ({id,type:'buff'}))
    const effects = ['a','b','c'].map((id,x) => ({id,type:'fire',icon:'',x,y:0}))
    const before: any = model()
    if (removing) { if (isTile) before.effects = effects; else before.pieces[0].statuses = statuses }
    presentation.update(before)
    const sequence = [events()[0], ...['a','b','c'].map((id,index) => ({
      eventId:'hit:'+id, rootEventId:'hit:0',parentEventId:'hit:0',kind,batchId:'batch-1',sequence:index+1,
      ...(isTile ? {targetCell:{x:index,y:0},result:{effectId:id,effectType:'fire',icon:''}}
        : {statusId:id,statusType:'buff',targetPieceIds:['target']}),
    })), {eventId:'hit:later',rootEventId:'hit:0',parentEventId:'hit:0',kind:'damage',targetPieceIds:['target'],sequence:4,result:{amount:3,value:17}}]
    const final: any = model(17, sequence)
    if (!removing) { if (isTile) final.effects=effects; else final.pieces[0].statuses=statuses }
    presentation.update(final)
    const count = (frame: any) => isTile ? frame.effects.length : frame.pieces[0].statuses.length
    expect(frames.every(frame => count(frame) === (removing ? 3 : 0))).toBe(true)
    vi.advanceTimersByTime(1520)
    expect(count(frames.at(-1))).toBe(removing ? 0 : 3)
    expect(frames.every(frame => [0,3].includes(count(frame)))).toBe(true)
    expect(frames.at(-1).pieces[0].health.current).toBe(20)
    queue.settleAll()
    expect(frames.at(-1).pieces[0].health.current).toBe(17)
    expect(count(frames.at(-1))).toBe(removing ? 0 : 3)
    presentation.dispose()
  })

  it('shows transient tiles then removes them as a separate batch even when final state has none', () => {
    const {presentation,frames} = setup()
    presentation.update(model())
    const sequence = [events()[0], ...['tileEffectAdded','tileEffectRemoved'].flatMap((kind,stage) => ['a','b'].map((id,index) => ({
      eventId:kind+id,rootEventId:'hit:0',parentEventId:'hit:0',kind,batchId:'tiles-'+stage,sequence:1+stage*2+index,
      targetCell:{x:index,y:0},result:{effectId:id,effectType:'fire',icon:''},
    })))]
    presentation.update(model(20,sequence))
    // Tile batches intentionally use the short presentation lane. Verify the
    // add batch is visible before the remove batch settles instead of relying
    // on the old long-action timing.
    vi.advanceTimersByTime(1220)
    expect(frames.at(-1).effects).toHaveLength(2)
    vi.advanceTimersByTime(400)
    expect(frames.at(-1).effects).toHaveLength(0)
    expect(frames.every(frame=>[0,2].includes(frame.effects.length))).toBe(true)
    presentation.dispose()
  })

  it.each([false, true])('does not reset between roots in a catch-up update, including control return=%s', (controlReturn) => {
    const { presentation, frames } = setup()
    presentation.update(model())
    const first = events().slice(0, 2)
    const second = events().slice(0, 2).map(event => ({ ...event,
      eventId: event.eventId.replace('hit:', 'next:'), rootEventId: 'next:0',
      ...(event.parentEventId ? { parentEventId: 'next:0' } : {}),
      ...(event.result ? { result: { amount: 3, value: 14 } } : {}), sequence: event.sequence + 2,
    }))
    presentation.update(model(14, [...first, ...second], controlReturn))
    expect(frames.every(frame => frame.pieces[0].health.current === 20)).toBe(true)
    vi.advanceTimersByTime(1520)
    expect(frames.at(-1).pieces[0].health.current).toBe(17)
    vi.advanceTimersByTime(680)
    expect(frames.at(-1).pieces[0].health.current).toBe(17)
    vi.advanceTimersByTime(1520)
    expect(frames.at(-1).pieces[0].health.current).toBe(14)
    presentation.dispose()
  })
  it.each([false, true])('holds prestate then shows individual HP values, including control return=%s', (controlReturn) => {
    const { presentation, frames, renderer } = setup()
    presentation.update(model())
    const final = model(14, events(), controlReturn)
    presentation.update(final)
    expect(frames.every(frame => frame.pieces[0].health.current === 20)).toBe(true)
    vi.advanceTimersByTime(1100 + 420)
    expect(frames.at(-1).pieces[0].health.current).toBe(17)
    expect(renderer.spawnFloater.mock.calls.map(call => call[2])).toEqual(['−3'])
    vi.advanceTimersByTime(1100)
    expect(frames.at(-1).pieces[0].health.current).toBe(14)
    expect(renderer.spawnFloater.mock.calls.map(call => call[2])).toEqual(['−3', '−3'])
    vi.runAllTimers()
    expect(frames.at(-1).pieces[0].health.current).toBe(14)
    expect(final.pieces[0].health.current).toBe(14)
    presentation.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('consumes skip per beat and settles the board to authority when the queue is cancelled', () => {
    const { presentation, queue, frames } = setup()
    presentation.update(model())
    presentation.update(model(14, events()))
    queue.skip(); vi.advanceTimersByTime(60)
    queue.skip()
    expect(frames.at(-1).pieces[0].health.current).toBe(17)
    queue.settleAll()
    expect(frames.at(-1).pieces[0].health.current).toBe(14)
    expect(vi.getTimerCount()).toBe(0)
    presentation.dispose()
  })

  it('applies sibling status additions together and keeps the summary in sync', () => {
    const { presentation, frames } = setup()
    presentation.update(model())
    const sequence = [events()[0], ...['a', 'b'].map((id, index) => ({
      eventId: 'hit:' + (index + 1), rootEventId: 'hit:0', parentEventId: 'hit:0', kind: 'statusAdded',
      statusId: id, statusType: id, targetPieceIds: ['target'], sequence: index + 1,
    }))]
    const final: any = model(20, sequence)
    final.pieces[0].statuses = ['a', 'b'].map(id => ({ id, type: id }))
    final.pieces[0].statusSummary = final.pieces[0].statuses
    presentation.update(final)
    vi.advanceTimersByTime(1520)
    expect(frames.at(-1).pieces[0].statuses.map((s: any) => s.id)).toEqual(['a', 'b'])
    expect(frames.at(-1).pieces[0].statusSummary).toEqual(frames.at(-1).pieces[0].statuses)
    vi.advanceTimersByTime(1100)
    expect(frames.at(-1).pieces[0].statuses.map((s: any) => s.id)).toEqual(['a', 'b'])
    presentation.dispose()
  })

  it('normalizes explicit batch IDs and a spawn snapshot even when the final board lacks that piece', () => {
    const { presentation, frames, normalize } = setup()
    presentation.update(model())
    const sequence = normalize([events()[0], { eventId: 'hit:1', rootEventId: 'hit:0', parentEventId: 'hit:0', kind: 'spawn', sequence: 1,
      batchId: 'summon-1', targetPieceIds: ['new'], pieceSnapshot: { id: 'new', templateId: 'new', name: 'New', faction: 'red', ownerPlayerId: 'red', x: 3, y: 2, hp: 10, maxHp: 10 } }])
    expect(sequence[1].batchId).toBe('summon-1')
    presentation.update(model(20, sequence))
    vi.advanceTimersByTime(1520)
    expect(frames.at(-1).pieces.find((p: any) => p.id === 'new')).toMatchObject({ x: 3, y: 2, health: { current: 10 } })
    presentation.dispose()
  })
})
