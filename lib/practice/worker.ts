import { parseGameProfileIdentityV1 } from '../content-pipeline/runtime/profile-game-identity'
import { practiceCatalog, choosePracticeRoster, createPracticeState, type PracticeSetup } from './setup'
import { PracticeSession } from './session'

// This file is imported only after bootstrap validates and primes every resource.
const scope = globalThis as unknown as {
  __RVB_PRACTICE_PROFILE__: unknown
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (message: unknown) => void
}
const profile = parseGameProfileIdentityV1(scope.__RVB_PRACTICE_PROFILE__)
let session: PracticeSession | undefined
let busy = false
scope.onmessage = async event => {
  const { id, type, payload = {} } = event.data ?? {}
  if (busy) { scope.postMessage({ id, error: { message: '上一条指令尚未完成' } }); return }
  busy = true
  try {
    let result: unknown
    if (type === 'catalog') result = practiceCatalog()
    else if (type === 'choose') result = choosePracticeRoster(payload.alignment, payload.seed, payload.presets)
    else if (type === 'start') {
      if (session) throw new Error('请重新打开准备页开始新局')
      session = new PracticeSession(await createPracticeState(payload as PracticeSetup, profile), payload.seed)
      result = session.snapshot()
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
