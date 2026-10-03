import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { loadMaps } from '@/config/maps'
import { createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import { listLegalAIActions } from '@/lib/game/ai-environment'
import {
  hashBattleState,
  hashStable,
  runBattleAction,
} from '@/lib/game/battle-runner'
import { recordBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { getPieceById } from '@/lib/game/piece-repository'
import { getCurrentInputOwnerPlayerId } from '@/lib/game/turn-timer'
import { applyBattleAction, safeCloneBattleState } from '@/lib/game/turn'
import type { BattleAction, BattleState } from '@/lib/game/turn'

type Lesson = {
  id: string
  number: number
  title: string
  intro: string
  help: string
  rootSeed: number
  player: { playerId: string }
  opponent: { playerId: string }
}

type LessonsModule = {
  PLAYER: string
  all: Lesson[]
  get(id: string): Lesson
  createBattle(engine: object, lesson: Lesson): Promise<BattleState>
}

const lessonSandbox = {} as { RvBTutorialLessons: LessonsModule }
runInNewContext(readFileSync('data/pages/js/tutorial/tutorial-lessons.js', 'utf8'), lessonSandbox)
const lessons = lessonSandbox.RvBTutorialLessons

function runtimeFunction(source: string, name: string): string {
  const marker = `function ${name}(`
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`Missing runtime function: ${name}`)
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] !== '}') continue
    depth -= 1
    if (depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`Unclosed runtime function: ${name}`)
}

function authorityDigest(state: BattleState): string {
  const debugBattle = (state.extensions as Record<string, unknown> | undefined)?.debugBattle
  return hashStable(debugBattle ?? null)
}

function authorityHash(state: BattleState): string {
  const copy: Record<string, unknown> = { ...state }
  delete copy.skillsById
  return hashBattleState(copy as unknown as BattleState)
}

function canonicalAction(state: BattleState): BattleAction {
  const owner = getCurrentInputOwnerPlayerId(state)
  if (!owner) throw new Error(`No input owner at turn ${state.turn.turnNumber}`)
  const legal = listLegalAIActions(state, owner)
  const candidate = ['deployReservePiece', 'beginPhase', 'endTurn']
    .map(type => legal.find(item => item.action.type === type))
    .find(Boolean) ?? legal[0]
  if (!candidate) throw new Error(`No legal action at turn ${state.turn.turnNumber}`)
  return JSON.parse(JSON.stringify(candidate.action)) as BattleAction
}

async function createTutorialBattle(): Promise<{ state: BattleState; lesson: Lesson }> {
  await loadMaps()
  const lesson = lessons.get('tactical-intuition')
  const state = await lessons.createBattle({ createInitialBattleForPlayers, getPieceById }, lesson)
  return { state, lesson }
}

async function canonicalEightCommands(initial: BattleState, rootSeed: number): Promise<BattleAction[]> {
  let state = initial
  const actions: BattleAction[] = []
  for (let index = 0; index < 8; index += 1) {
    const action = canonicalAction(state)
    actions.push(action)
    state = runBattleAction(state, action, { rootSeed }).state
  }
  return actions
}

function createTrainingBridge(engine: object, lesson: Lesson, tutorialMode = true) {
  const page = readFileSync('data/pages/battle.html', 'utf8')
  const context = {
    window: { RvBGameEngine: { ensure: async () => engine } },
    TUTORIAL_MODE: tutorialMode,
    params: new URLSearchParams(tutorialMode ? 'mode=tutorial&lesson=tactical-intuition' : 'mode=training'),
    tutorialDefinition: tutorialMode ? lesson : null,
    skillsById: {},
  }
  runInNewContext(`async ${runtimeFunction(page, 'trainingApiFetch')}`, context)
  return context as typeof context & {
    trainingApiFetch(method: string, body: unknown): Promise<BattleState>
  }
}

class Element {
  children: Element[] = []
  textContent = ''
  hidden = false
  classList = { toggle: vi.fn() }
  listeners: Record<string, () => void> = {}
  attributes: Record<string, string> = {}
  setAttribute(name: string, value: string) { this.attributes[name] = value }
  append(...items: Element[]) { this.children.push(...items) }
  appendChild(item: Element) { this.append(item) }
  replaceChildren(...items: Element[]) { this.children = items }
  addEventListener(name: string, callback: () => void) { this.listeners[name] = callback }
  remove() { this.removed = true }
  removed = false
}

type TestAction = { type: string; playerId?: string; [key: string]: unknown }
type TestState = {
  owner: string
  turn: { phase: string; turnNumber: number; currentPlayerId: string }
  players: Array<Record<string, unknown>>
  pieces: Array<Record<string, unknown>>
  [key: string]: unknown
}
type RuntimeApi = {
  snapshot: () => Record<string, unknown>
  afterAcceptedAction: (action: TestAction, before: TestState) => Promise<unknown>
  dispose: () => void
}
type RuntimeSandbox = {
  document: { body: Element; createElement: () => Element }
  setTimeout: typeof setTimeout
  performance: { now: () => number }
  RvBTutorialLessons: { all: unknown[]; observe: () => unknown[] }
  RvBTutorialLessonRuntime?: { create: (lesson: Lesson, hooks: unknown) => RuntimeApi }
}

function runtimeFixture() {
  let state: TestState = {
    owner: 'human',
    turn: { phase: 'action', turnNumber: 1, currentPlayerId: 'human' },
    players: [{ playerId: 'human', actionPoints: 3, maxActionPoints: 3, chargePoints: 0 }],
    pieces: [],
  }
  const body = new Element()
  const hooks = {
    getState: () => state,
    getSelectedPieceId: () => null,
    revealPieceSkills: vi.fn(),
    positionGuide: vi.fn(),
    showResourceGrowth: vi.fn(),
    engine: async () => engine,
    search: vi.fn(async () => ({
      nextAction: { action: { type: 'endTurn', playerId: 'opponent' } },
      continuation: { turnKey: 'opponent:1:opponent', nodes: 1, elapsedMs: 0 },
      nodes: 1,
      considered: 1,
      elapsedMs: 0,
      stopReason: 'selected',
    })),
    commit: vi.fn(async (action: TestAction) => {
      if (action.type === 'endTurn') state = { ...state, owner: 'human' }
    }),
    render: vi.fn(),
    setCue: vi.fn(),
    exit: vi.fn(),
    restart: vi.fn(),
    next: vi.fn(),
  }
  const engine = {
    getCurrentInputOwnerPlayerId: (current: TestState) => current.owner,
    getBattleRootSeed: () => 18707,
    hashBattleState: (current: TestState) => JSON.stringify(current),
  }
  hooks.engine = async () => engine
  const sandbox: RuntimeSandbox = {
    document: { body, createElement: () => new Element() },
    setTimeout,
    performance: { now: () => 0 },
    RvBTutorialLessons: { all: [], observe: () => [] },
  }
  runInNewContext(readFileSync('data/pages/js/tutorial/tutorial-lesson-runtime.js', 'utf8'), sandbox)
  const lesson: Lesson = {
    id: 'performance', number: 1, title: '性能', intro: '开场', help: '思路', rootSeed: 18707,
    player: { playerId: 'human' }, opponent: { playerId: 'opponent' },
  }
  const runtime = sandbox.RvBTutorialLessonRuntime!.create(lesson, hooks)
  const root = body.children[0]
  const click = (label: string) => root.children[3].children.find(item => item.textContent === label)?.listeners.click()
  return { runtime, hooks, root, getState: () => state, setState: (next: TestState) => { state = next }, click }
}

describe('RED-232 tutorial submit bridge', () => {
  beforeAll(async () => { await loadMaps() })

  it('uses the runner clone exactly once for tutorial PUTs and keeps the non-tutorial clone boundary', async () => {
    const { state, lesson } = await createTutorialBattle()
    let tutorialCloneCalls = 0
    const tutorialEngine = {
      safeCloneBattleState: (input: BattleState) => { tutorialCloneCalls += 1; return safeCloneBattleState(input) },
      runBattleAction,
      recordBattlePresentation,
      applyBattleAction: (input: BattleState, action: BattleAction) => runBattleAction(input, action, { rootSeed: lesson.rootSeed }).state,
    }
    const tutorial = createTrainingBridge(tutorialEngine, lesson, true)
    const action = canonicalAction(state)
    await tutorial.trainingApiFetch('PUT', { action, battleState: state })
    expect(tutorialCloneCalls).toBe(0)

    let trainingCloneCalls = 0
    const trainingEngine = {
      safeCloneBattleState: (input: BattleState) => { trainingCloneCalls += 1; return safeCloneBattleState(input) },
      applyBattleAction: (input: BattleState, command: BattleAction) => runBattleAction(input, command, { rootSeed: lesson.rootSeed }).state,
      recordBattlePresentation,
    }
    const training = createTrainingBridge(trainingEngine, lesson, false)
    await training.trainingApiFetch('PUT', { action, battleState: state })
    expect(trainingCloneCalls).toBe(1)
  })

  it('preserves input on rejected commands and matches full authority/replay/RNG output over eight commands', async () => {
    const { state: initial, lesson } = await createTutorialBattle()
    const commands = await canonicalEightCommands(initial, lesson.rootSeed)
    const tutorialEngine = { safeCloneBattleState, runBattleAction, recordBattlePresentation, applyBattleAction }
    const bridge = createTrainingBridge(tutorialEngine, lesson, true)

    const rejectedBeforeHash = hashBattleState(initial)
    const rejectedBeforeAuthority = authorityDigest(initial)
    await expect(bridge.trainingApiFetch('PUT', {
      action: { type: 'move', playerId: 'not-the-owner', pieceId: 'missing', toX: 0, toY: 0 },
      battleState: initial,
    })).rejects.toThrow()
    expect(hashBattleState(initial)).toBe(rejectedBeforeHash)
    expect(authorityDigest(initial)).toBe(rejectedBeforeAuthority)

    let direct = safeCloneBattleState(initial)
    let bridged = safeCloneBattleState(initial)
    for (const action of commands) {
      const beforeHash = authorityHash(bridged)
      const beforeAuthority = authorityDigest(bridged)
      const directResult = runBattleAction(direct, action, { rootSeed: lesson.rootSeed })
      const bridgeResult = await bridge.trainingApiFetch('PUT', { action, battleState: bridged })
      expect(authorityHash(bridged)).toBe(beforeHash)
      expect(authorityDigest(bridged)).toBe(beforeAuthority)
      expect(authorityHash(bridgeResult)).toBe(authorityHash(directResult.state))
      expect(authorityDigest(bridgeResult)).toBe(authorityDigest(directResult.state))
      expect(bridgeResult.extensions?.debugBattle?.actionLog).toEqual(directResult.state.extensions?.debugBattle?.actionLog)
      expect(bridgeResult.extensions?.debugBattle?.replay).toEqual(directResult.state.extensions?.debugBattle?.replay)
      direct = directResult.state
      bridged = bridgeResult
    }
  })
})

describe('RED-232 tutorial search payload', () => {
  type SearchPayload = {
    state: unknown
    playerId: string
    rootSeed: number
    continuation: unknown
    actionsTakenThisTurn: number
  }

  it('removes nested compiled callbacks before the real worker structured clone', async () => {
    const { state: authorityState } = await createTutorialBattle()
    let received: { type: string; payload: SearchPayload } | null = null
    const practice = {
      request: vi.fn((type: string, payload: SearchPayload) => {
        received = { type, payload }
        expect(() => globalThis.structuredClone(payload)).not.toThrow()
        return Promise.resolve({ stopReason: 'selected' })
      }),
      dispose: vi.fn(),
    }
    const sandbox = {
      window: {
        RvBPracticeClient: { create: async () => practice },
      },
    }
    runInNewContext(readFileSync('data/pages/js/tutorial/tutorial-search-client.js', 'utf8'), sandbox)
    const client = await (sandbox.window as unknown as {
      RvBTutorialSearchClient: { create: () => Promise<{ request: (type: string, payload: SearchPayload) => Promise<unknown> }> }
    }).RvBTutorialSearchClient.create()
    const compiled = () => 'presentation callback'
    const state = {
      ...authorityState,
      skillsById: { 'frost-bolt': { name: 'presentation only' } },
      pieces: authorityState.pieces.map((piece, index) => index === 0
        ? { ...piece, rules: [{ id: 'frost-bolt', compiled }] }
        : piece),
      extensions: {
        ...(authorityState.extensions || {}),
        debugBattle: { actionLog: ['a1'], replay: ['r1'] },
        rng: { rootSeed: 18707, cursor: 3 },
        rules: [{ id: 'frost-bolt', compiled }],
      },
      rules: { compiled },
    }
    await client.request('tutorial-plan', {
      state,
      playerId: 'opponent',
      rootSeed: 18707,
      continuation: null,
      actionsTakenThisTurn: 2,
    })

    expect(received).not.toBeNull()
    const captured = received!
    const capturedState = captured.payload.state as {
      skillsById?: unknown
      extensions: { debugBattle: unknown; rng: unknown; rules: Array<{ compiled?: unknown }> }
      pieces: Array<{ rules: Array<{ compiled?: unknown }> }>
      rules: { compiled?: unknown }
    }
    expect(captured.type).toBe('tutorial-plan')
    expect(captured.payload).toMatchObject({ playerId: 'opponent', rootSeed: 18707, actionsTakenThisTurn: 2 })
    expect(capturedState.skillsById).toBeUndefined()
    expect(capturedState.extensions.debugBattle).toEqual(state.extensions.debugBattle)
    expect(capturedState.extensions.rng).toEqual(state.extensions.rng)
    expect(capturedState.pieces[0].rules[0].compiled).toBeUndefined()
    expect(capturedState.extensions.rules[0].compiled).toBeUndefined()
    expect(capturedState.rules.compiled).toBeUndefined()
    expect(state.skillsById).toBeDefined()
    expect(state.extensions.rules[0].compiled).toBe(compiled)
  })

  it('disposes an eventual client when page navigation races worker initialization', async () => {
    const page = readFileSync('data/pages/battle.html', 'utf8')
    let resolveClient!: (client: { request: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }) => void
    const create = vi.fn(() => new Promise(resolve => { resolveClient = resolve }))
    const sandbox: Record<string, unknown> = {
      window: {
        RvBPracticeClient: { create },
        RvBTutorialSearchClient: { fromPractice: (practice: unknown) => practice },
      },
      TUTORIAL_MODE: true,
      params: new URLSearchParams('lesson=tactical-intuition'),
      tutorialRuntime: { dispose: vi.fn() },
    }
    const functions = [
      runtimeFunction(page, 'disposeTutorialSearchClient'),
      runtimeFunction(page, 'startTutorialSearchClient'),
      runtimeFunction(page, 'disposeTutorialPage'),
    ].join('\n')
    runInNewContext(`
      let tutorialSearchClient = null
      let tutorialSearchClientPromise = null
      let tutorialSearchClientGeneration = null
      let tutorialSearchClientCancelled = false
      ${functions}
      globalThis.start = startTutorialSearchClient
      globalThis.disposePage = disposeTutorialPage
    `, sandbox)

    const runtime = sandbox.tutorialRuntime as { dispose: ReturnType<typeof vi.fn> }
    const start = sandbox.start as () => Promise<unknown>
    const disposePage = sandbox.disposePage as () => void
    const pending = start()
    disposePage()
    const client = { request: vi.fn(), dispose: vi.fn() }
    resolveClient(client)
    await pending
    await Promise.resolve()
    expect(create).toHaveBeenCalledTimes(1)
    expect(runtime.dispose).toHaveBeenCalledTimes(1)
    expect(client.dispose).toHaveBeenCalled()
  })
})

describe('RED-232 tutorial runtime render handoff', () => {
  it('does not full-render twice when a human action is already waiting for human input', async () => {
    const fixture = runtimeFixture()
    fixture.click('开始本局')
    await vi.waitFor(() => expect(fixture.runtime.snapshot().busy).toBe(false))
    fixture.hooks.render.mockClear()

    const before = fixture.getState()
    await fixture.runtime.afterAcceptedAction({ type: 'move', playerId: 'human' }, before)

    expect(fixture.hooks.render).not.toHaveBeenCalled()
  })

  it('keeps the full render when the same human submit resumes an AI action', async () => {
    vi.useFakeTimers()
    try {
      const fixture = runtimeFixture()
      fixture.click('开始本局')
      await vi.advanceTimersByTimeAsync(0)
      await vi.waitFor(() => expect(fixture.runtime.snapshot().busy).toBe(false))
      fixture.hooks.render.mockClear()
      fixture.setState({ ...fixture.getState(), owner: 'opponent' })

      const playback = fixture.runtime.afterAcceptedAction({ type: 'endTurn', playerId: 'human' }, fixture.getState())
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(2000)
      await playback

      expect(fixture.hooks.render).toHaveBeenCalled()
      expect(fixture.hooks.search).toHaveBeenCalledWith(expect.objectContaining({
        playerId: 'opponent', rootSeed: 18707, actionsTakenThisTurn: 0,
      }))
      expect(fixture.runtime.snapshot().failure).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not submit a late worker result after tutorial disposal', async () => {
    const fixture = runtimeFixture()
    fixture.click('开始本局')
    await vi.waitFor(() => expect(fixture.runtime.snapshot().busy).toBe(false))
    fixture.setState({ ...fixture.getState(), owner: 'opponent' })
    type SearchDecision = {
      nextAction: { action: { type: string; playerId: string } }
      continuation: { turnKey: string; nodes: number; elapsedMs: number }
      nodes: number
      considered: number
      elapsedMs: number
      stopReason: string
    }
    let resolveSearch!: (decision: SearchDecision) => void
    fixture.hooks.search.mockImplementationOnce(() => new Promise<SearchDecision>(resolve => { resolveSearch = resolve }))
    const playback = fixture.runtime.afterAcceptedAction({ type: 'endTurn', playerId: 'human' }, fixture.getState())
    await vi.waitFor(() => expect(fixture.hooks.search).toHaveBeenCalled())
    fixture.runtime.dispose()
    resolveSearch({
      nextAction: { action: { type: 'endTurn', playerId: 'opponent' } },
      continuation: { turnKey: 'opponent:1:opponent', nodes: 1, elapsedMs: 0 },
      nodes: 1,
      considered: 1,
      elapsedMs: 0,
      stopReason: 'selected',
    })
    await playback
    expect(fixture.hooks.commit).not.toHaveBeenCalled()
    expect(fixture.runtime.snapshot().failure).toBe('')
  })

  it('pauses with a worker error instead of silently using the synchronous planner', async () => {
    const fixture = runtimeFixture()
    fixture.click('开始本局')
    await vi.waitFor(() => expect(fixture.runtime.snapshot().busy).toBe(false))
    fixture.setState({ ...fixture.getState(), owner: 'opponent' })
    fixture.hooks.search.mockRejectedValueOnce(Object.assign(new Error('worker paused'), { code: 'PRACTICE_WORKER_BUSY' }))
    await fixture.runtime.afterAcceptedAction({ type: 'endTurn', playerId: 'human' }, fixture.getState())
    expect(fixture.hooks.commit).not.toHaveBeenCalled()
    expect(fixture.runtime.snapshot().failure).toContain('PRACTICE_WORKER_BUSY')
  })

  it('enables the QA replay bootstrap only for an opted-in loopback tutorial page', () => {
    const page = readFileSync('data/pages/battle.html', 'utf8')
    const source = runtimeFunction(page, 'tutorialQaReplayEnabled')
    const context: {
      TUTORIAL_MODE: boolean
      tutorialPerfEnabled: boolean
      params: URLSearchParams
      location: { hostname: string }
      tutorialQaReplayEnabled?: () => boolean
    } = {
      TUTORIAL_MODE: true,
      tutorialPerfEnabled: true,
      params: new URLSearchParams('lesson=tactical-intuition&tutorialPerf=1&qaReplay=1'),
      location: { hostname: '127.0.0.1' },
    }
    runInNewContext(source, context)
    expect(context.tutorialQaReplayEnabled!()).toBe(true)

    context.location.hostname = 'qa.example.test'
    expect(context.tutorialQaReplayEnabled!()).toBe(false)
    context.location.hostname = 'localhost'
    context.params = new URLSearchParams('lesson=tactical-intuition&tutorialPerf=1&qaReplay=0')
    expect(context.tutorialQaReplayEnabled!()).toBe(false)
    context.params = new URLSearchParams('lesson=tactical-intuition&qaReplay=1')
    context.tutorialPerfEnabled = false
    expect(context.tutorialQaReplayEnabled!()).toBe(false)
    context.TUTORIAL_MODE = false
    context.tutorialPerfEnabled = true
    context.params = new URLSearchParams('lesson=tactical-intuition&tutorialPerf=1&qaReplay=1')
    expect(context.tutorialQaReplayEnabled!()).toBe(false)
  })
})
