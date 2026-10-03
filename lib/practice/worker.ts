import {
  parseGameProfileIdentityV1,
  sameGameProfileIdentityV1,
} from '../content-pipeline/runtime/profile-game-identity'
import { practiceCatalog, choosePracticeRoster, createPracticeState, type PracticeSetup } from './setup'
import { PracticeSession } from './session'
import {
  getBattleRootSeed,
  readBattleProfilePinV1,
  type BattleProfilePinV1,
} from '../game/battle-trace'
import { getCurrentInputOwnerPlayerId } from '../game/turn-timer'
import {
  planTutorialAiAction,
  type TutorialAiOptions,
} from '../game/tutorial-ai'
import type { ShortSearchContinuation } from '../game/ai-short-search'
import type { BattleState } from '../game/turn'

// This file is imported only after bootstrap validates and primes every resource.
const scope = globalThis as unknown as {
  __RVB_PRACTICE_PROFILE__: unknown
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (message: unknown) => void
}
const profile = parseGameProfileIdentityV1(scope.__RVB_PRACTICE_PROFILE__)
let session: PracticeSession | undefined
let busy = false

type TutorialPlanPayload = Pick<TutorialAiOptions, 'continuation' | 'actionsTakenThisTurn'> & {
  state: BattleState
  playerId: string
  rootSeed: number
}

type WorkerError = Error & { code?: string; [key: string]: unknown }

function protocolError(code: string, message: string): WorkerError {
  return Object.assign(new Error(message), { code }) as WorkerError
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validateTutorialPlanPayload(payload: unknown): TutorialPlanPayload {
  if (!isRecord(payload) || !isRecord(payload.state)) {
    throw protocolError('TUTORIAL_PLAN_PAYLOAD_INVALID', '教程 AI 请求缺少有效战局状态')
  }
  if (typeof payload.playerId !== 'string' || !payload.playerId.trim()) {
    throw protocolError('TUTORIAL_PLAN_OWNER_INVALID', '教程 AI 请求缺少当前玩家')
  }
  if (!Number.isSafeInteger(payload.rootSeed) || Number(payload.rootSeed) < 0 || Number(payload.rootSeed) > 0xffff_ffff) {
    throw protocolError('TUTORIAL_PLAN_ROOT_SEED_INVALID', '教程 AI 请求的根种子无效')
  }
  if (payload.actionsTakenThisTurn !== undefined
    && (!Number.isSafeInteger(payload.actionsTakenThisTurn) || Number(payload.actionsTakenThisTurn) < 0)) {
    throw protocolError('TUTORIAL_PLAN_ACTION_COUNT_INVALID', '教程 AI 请求的本回合动作数无效')
  }

  const state = payload.state as unknown as BattleState
  const rootSeed = Number(payload.rootSeed) >>> 0
  const pin: BattleProfilePinV1 | undefined = readBattleProfilePinV1(state)
  if (!pin || !sameGameProfileIdentityV1(pin.profileIdentity, profile)) {
    throw protocolError('TUTORIAL_PLAN_PROFILE_MISMATCH', '教程 AI 战局与当前练习资源版本不匹配')
  }
  if (pin.rootSeed !== rootSeed) {
    throw protocolError('TUTORIAL_PLAN_ROOT_SEED_MISMATCH', '教程 AI 请求的根种子与战局记录不匹配')
  }
  const tracedRootSeed = getBattleRootSeed(state)
  if (tracedRootSeed !== undefined && tracedRootSeed !== rootSeed) {
    throw protocolError('TUTORIAL_PLAN_ROOT_SEED_MISMATCH', '教程 AI 请求的根种子与战局记录不匹配')
  }
  const owner = getCurrentInputOwnerPlayerId(state)
  if (owner !== payload.playerId) {
    throw protocolError('TUTORIAL_PLAN_OWNER_MISMATCH', '教程 AI 请求的玩家不是当前局面拥有者')
  }
  return {
    state,
    playerId: payload.playerId,
    rootSeed: pin.rootSeed,
    ...(payload.continuation !== undefined
      ? { continuation: payload.continuation as ShortSearchContinuation }
      : {}),
    ...(payload.actionsTakenThisTurn !== undefined
      ? { actionsTakenThisTurn: payload.actionsTakenThisTurn as number }
      : {}),
  }
}

scope.onmessage = async event => {
  const { id, type, payload = {} } = event.data ?? {}
  if (busy) {
    scope.postMessage({ id, error: { message: '上一条指令尚未完成', code: 'PRACTICE_WORKER_BUSY' } })
    return
  }
  busy = true
  try {
    let result: unknown
    if (type === 'catalog') result = practiceCatalog()
    else if (type === 'choose') result = choosePracticeRoster(payload.alignment, payload.seed, payload.presets)
    else if (type === 'start') {
      if (session) throw new Error('请重新打开准备页开始新局')
      session = new PracticeSession(await createPracticeState(payload as PracticeSetup, profile), payload.seed)
      result = session.snapshot()
    } else if (type === 'tutorial-plan') {
      // Keep the worker's busy guard observable to callers that issue a second
      // message before this request's promise continuation begins.
      await Promise.resolve()
      const request = validateTutorialPlanPayload(payload)
      // Tutorial planning is deliberately independent from PracticeSession: the
      // page still owns authority submission and asks for one fresh plan per
      // accepted action. The worker only evaluates the supplied public state.
      result = planTutorialAiAction(request.state, request.playerId, request.rootSeed, {
        continuation: request.continuation,
        actionsTakenThisTurn: request.actionsTakenThisTurn,
      })
    } else if (session && type === 'human') result = session.human(payload.action, payload.revision)
    else if (session && type === 'step') result = session.step(payload.revision)
    else throw new Error('练习指令无效或战局未初始化')
    scope.postMessage({ id, result })
  } catch (caught) {
    const error = caught as Error & Record<string, unknown>
    // Preserve authoritative preparation data for the normal target-selection flow.
    const aiFailure = type === 'step'
    scope.postMessage({ id, error: aiFailure ? { message: 'AI 无法继续执行，练习已暂停', code: error.code } : {
      message: error.message, code: error.code,
      needsTargetSelection: error.needsTargetSelection, needsOptionSelection: error.needsOptionSelection,
      preparation: error.preparation, targetType: error.targetType, range: error.range, filter: error.filter,
      options: error.options, title: error.title }, paused: aiFailure ? 'AI 无法继续执行，练习已暂停' : session?.snapshot().paused })
  } finally { busy = false }
}
scope.postMessage({ ready: true })
