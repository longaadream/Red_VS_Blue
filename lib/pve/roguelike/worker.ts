import { parseGameProfileIdentityV1 } from '../../content-pipeline/runtime/profile-game-identity'
import { AdventureSession, createAdventureState } from './session'
import { adventureContent } from './content'
import { generateAdventureContent } from './generation'
import { createRootSeed } from '../../game/rule-runtime'
const scope = globalThis as unknown as { __RVB_PRACTICE_PROFILE__: unknown; onmessage: (event: MessageEvent) => void; postMessage: (data: unknown) => void }
const profile = parseGameProfileIdentityV1(scope.__RVB_PRACTICE_PROFILE__)
let session: AdventureSession | undefined
let busy = false
scope.onmessage = async event => {
  const { id, type, payload = {} } = event.data ?? {}
  if (busy) { scope.postMessage({ id, error: { message: '上一条冒险指令尚未完成' } }); return }
  busy = true
  try {
    let result: unknown
    if (type === 'start' && !session) {
      const content = generateAdventureContent(adventureContent, payload.seed ?? createRootSeed())
      session = new AdventureSession(await createAdventureState(profile, content), content); result = session.snapshot()
    }
    else if (session && type === 'human') result = session.human(payload.action, payload.revision)
    else if (session && type === 'interact') result = session.interact(payload.siteId, payload.operation, payload.pieceId, payload.revision, payload.targetPieceId)
    else if (session && type === 'step') result = session.step(payload.revision)
    else if (session && type === 'supply') result = session.supply(payload.operation, payload.choice, payload.revision)
    else throw new Error('冒险未开始或指令无效')
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
