import { parseGameProfileIdentityV1 } from '../../content-pipeline/runtime/profile-game-identity'
import { createFixedRouteSession, type FixedRouteSession } from './session'
import type { BattleAction } from '../../game/turn'

const scope = globalThis as unknown as {
  __RVB_PRACTICE_PROFILE__: unknown
  onmessage: (event: MessageEvent) => void
  postMessage: (data: unknown) => void
}
const profile = parseGameProfileIdentityV1(scope.__RVB_PRACTICE_PROFILE__)
let session: FixedRouteSession | undefined
let busy = false

function objectPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('固定路线指令参数无效')
  return value as Record<string, unknown>
}

function onlyKeys(payload: Record<string, unknown>, allowed: string[]): void {
  const expected = new Set(allowed)
  if (Object.keys(payload).some(key => !expected.has(key))) throw new Error('固定路线指令包含未允许字段')
}

function optionalSeed(payload: Record<string, unknown>): number | undefined {
  if (!Object.hasOwn(payload, 'seed')) return undefined
  const seed = payload.seed
  if (!Number.isSafeInteger(seed) || (seed as number) < 0 || (seed as number) > 0xffffffff) throw new Error('固定路线种子须为 0～4294967295 的整数')
  return seed as number
}

function revision(payload: Record<string, unknown>): number {
  if (!Number.isSafeInteger(payload.revision) || (payload.revision as number) < 0) throw new Error('固定路线 revision 无效')
  return payload.revision as number
}

function action(payload: Record<string, unknown>): BattleAction {
  const value = payload.action
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { type?: unknown }).type !== 'string') throw new Error('固定路线 action 无效')
  return value as BattleAction
}

scope.onmessage = async event => {
  const message = event.data ?? {}
  const id = message.id
  const type = message.type
  if (busy) { scope.postMessage({ id, error: { message: '上一条固定路线指令尚未完成' } }); return }
  busy = true
  try {
    const payload = message.payload === undefined ? {} : objectPayload(message.payload)
    let result: unknown
    if (type === 'start') {
      onlyKeys(payload, ['seed'])
      if (session) throw new Error('固定路线已经开始')
      session = await createFixedRouteSession(profile, optionalSeed(payload))
      result = session.snapshot()
    } else if (type === 'restart') {
      onlyKeys(payload, ['seed'])
      session = await createFixedRouteSession(profile, optionalSeed(payload))
      result = session.snapshot()
    } else if (type === 'snapshot') {
      onlyKeys(payload, [])
      if (!session) throw new Error('固定路线尚未开始')
      result = session.snapshot()
    } else if (type === 'enter') {
      onlyKeys(payload, ['revision'])
      if (!session) throw new Error('固定路线尚未开始')
      result = session.enter(revision(payload))
    } else if (type === 'continue') {
      onlyKeys(payload, ['revision'])
      if (!session) throw new Error('固定路线尚未开始')
      result = await session.continue(revision(payload))
    } else if (type === 'human') {
      onlyKeys(payload, ['action', 'revision'])
      if (!session) throw new Error('固定路线尚未开始')
      result = session.human(action(payload), revision(payload))
    } else if (type === 'step') {
      onlyKeys(payload, ['revision'])
      if (!session) throw new Error('固定路线尚未开始')
      result = session.step(revision(payload))
    } else if (type === 'supply') {
      onlyKeys(payload, ['operation', 'choice', 'revision'])
      if (!session) throw new Error('固定路线尚未开始')
      if (typeof payload.operation !== 'string' || typeof payload.choice !== 'string') throw new Error('固定路线供给选择无效')
      result = session.supply(payload.operation, payload.choice, revision(payload))
    } else {
      throw new Error('固定路线尚未开始或指令无效')
    }
    scope.postMessage({ id, result })
  } catch (caught) {
    const error = caught as Error & Record<string, unknown>
    scope.postMessage({ id, error: { message: error.message, code: error.code,
      needsTargetSelection: error.needsTargetSelection, needsOptionSelection: error.needsOptionSelection,
      preparation: error.preparation, targetType: error.targetType, range: error.range, filter: error.filter,
      options: error.options, title: error.title } })
  } finally { busy = false }
}

scope.postMessage({ ready: true })
