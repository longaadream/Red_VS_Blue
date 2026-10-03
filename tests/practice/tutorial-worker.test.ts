import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readClientProtocolBattleData } from '@/electron-client/client-protocol-resource'
import {
  choosePracticeRoster,
  createPracticeState,
  AI_ID,
} from '@/lib/practice/setup'
import {
  getServerGameProfileIdentityV1,
} from '@/lib/content-pipeline/runtime/profile-game-identity'
import type { BattleState } from '@/lib/game/turn'

const ROOT_SEED = 2003

type WorkerMessage = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- VM protocol fixture
type WorkerContext = {
  onmessage?: (event: MessageEvent) => Promise<void> | void
}

function createWorker() {
  const files = readClientProtocolBattleData({
    htmlRoot: path.resolve('data/pages'),
    appRoot: process.cwd(),
    activePackRoot: null,
    isPackaged: false,
  })
  files['data/rules/rule-lucky-coin-gamestart.json'] = JSON.parse(
    fs.readFileSync('data/rules/rule-lucky-coin-gamestart.json', 'utf8'),
  )
  const messages: WorkerMessage[] = []
  const context = vm.createContext({
    __RVB_PRACTICE_FILES__: files,
    __RVB_PRACTICE_PROFILE__: getServerGameProfileIdentityV1(),
    process: { env: { NODE_ENV: 'production' }, cwd: () => '' },
    console: { ...console, log() {}, info() {} },
    performance,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    postMessage: (message: WorkerMessage) => messages.push(structuredClone(message)),
  }) as WorkerContext
  new vm.Script(fs.readFileSync('data/pages/js/practice/engine.js', 'utf8')).runInContext(context as object)
  expect(messages.shift()).toEqual({ ready: true })
  return {
    context,
    messages,
    dispatch(id: number, type: string, payload?: unknown) {
      if (!context.onmessage) throw new Error('practice worker handler missing')
      return context.onmessage({ data: { id, type, payload } } as MessageEvent)
    },
  }
}

async function createAuthorityState(): Promise<BattleState> {
  const profile = getServerGameProfileIdentityV1()
  const state = await createPracticeState({
    human: choosePracticeRoster('good', 7),
    ai: choosePracticeRoster('evil', 8),
    humanFirst: false,
    mapId: 'large-hole-arena',
    seed: ROOT_SEED,
  }, profile)
  // A browser Worker receives a structured-cloned authority snapshot. Rule
  // effects and presentation skill definitions are rehydrated from its
  // validated VFS; the state envelope and replay metadata stay intact.
  return JSON.parse(JSON.stringify({ ...state, skillsById: {} })) as BattleState
}

async function request(worker: ReturnType<typeof createWorker>, id: number, type: string, payload: unknown) {
  await worker.dispatch(id, type, payload)
  const message = worker.messages.shift()
  if (!message) throw new Error(`worker did not answer ${type}`)
  return message
}

describe('tutorial AI worker protocol', () => {
  it('returns a real bounded plan from the authority state without PracticeSession', async () => {
    const worker = createWorker()
    const state = await createAuthorityState()
    const stateBefore = JSON.stringify(state)
    const response = await request(worker, 1, 'tutorial-plan', {
      state,
      playerId: AI_ID,
      rootSeed: ROOT_SEED,
      actionsTakenThisTurn: 0,
    })

    expect(response.error).toBeUndefined()
    expect(response.result).toMatchObject({
      continuation: { turnKey: expect.stringContaining(AI_ID) },
      stopReason: expect.any(String),
    })
    expect(response.result.nodes).toBeGreaterThan(0)
    expect(response.result.considered).toBeGreaterThan(0)
    expect(response.result.nextAction).toBeDefined()
    expect(response.result.nextAction.action.playerId).toBe(AI_ID)
    expect(JSON.stringify(state)).toBe(stateBefore)
  }, 90000)

  it('rejects mismatched profile, root seed and input owner before searching', async () => {
    const worker = createWorker()
    const state = await createAuthorityState()

    const profileMismatch = await request(worker, 1, 'tutorial-plan', {
      state: { ...state, extensions: { ...state.extensions, battleProfile: undefined } },
      playerId: AI_ID,
      rootSeed: ROOT_SEED,
    })
    expect(profileMismatch.error).toMatchObject({ code: 'TUTORIAL_PLAN_PROFILE_MISMATCH' })

    const seedMismatch = await request(worker, 2, 'tutorial-plan', {
      state,
      playerId: AI_ID,
      rootSeed: ROOT_SEED + 1,
    })
    expect(seedMismatch.error).toMatchObject({ code: 'TUTORIAL_PLAN_ROOT_SEED_MISMATCH' })

    const ownerMismatch = await request(worker, 3, 'tutorial-plan', {
      state,
      playerId: 'practice-human',
      rootSeed: ROOT_SEED,
    })
    expect(ownerMismatch.error).toMatchObject({ code: 'TUTORIAL_PLAN_OWNER_MISMATCH' })
  }, 90000)

  it('rejects a concurrent plan while the first request owns the worker', async () => {
    const worker = createWorker()
    const state = await createAuthorityState()
    const payload = { state, playerId: AI_ID, rootSeed: ROOT_SEED }
    const first = worker.dispatch(1, 'tutorial-plan', payload)
    const second = worker.dispatch(2, 'tutorial-plan', payload)
    await Promise.all([first, second])

    const responses = worker.messages.splice(0)
    expect(responses).toHaveLength(2)
    expect(responses.some(message => message.error?.code === 'PRACTICE_WORKER_BUSY')).toBe(true)
    expect(responses.some(message => message.result?.nextAction)).toBe(true)
  }, 90000)
})
