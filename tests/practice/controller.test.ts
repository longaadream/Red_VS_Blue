import fs from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

describe('practice page authority receipt lifecycle', () => {
  it('removes the blocking loading overlay when initialization fails so the exit stays accessible', async () => {
    const elements = new Map<string, { style: Record<string, string> }>()
    const context = vm.createContext({ window: {}, sessionStorage: { getItem: () => '{}' },
      document: { getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, { style: {} })
        return elements.get(id)
      }, createElement: () => ({ style: {}, setAttribute() {} }), body: { append() {} } },
      RvBPracticeClient: { create: async () => { throw new Error('resource unavailable') } }, showMsg() {} })
    new vm.Script(fs.readFileSync('data/pages/js/practice/battle-controller.js', 'utf8')).runInContext(context)
    await context.window.initPracticeBattle()
    expect(elements.get('loadingOverlay')?.style.display).toBe('none')
  })
  it('retains a new pending choice installed by rendering the next receipt', async () => {
    const nextChoice = { selectionId: 'second-selection' }
    const context = vm.createContext({ window: {}, G: { pieces: [] }, myPlayerId: 'practice-human',
      pendingSkill: { selectionId: 'old-selection' }, pendingCardAction: {}, nextChoice,
      withClientActionId: (action: unknown) => action, clearTimeout() {},
      beginPendingActionFeedback: () => true, applyAuthorityReceipt() {}, restoreSelectedPieceMenu() {} })
    new vm.Script(fs.readFileSync('data/pages/js/practice/battle-controller.js', 'utf8') + `
      practiceSnapshot = { revision: 1 };
      practiceClient = { request: async () => ({ revision: 2 }) };
      acceptPracticeSnapshot = () => { pendingSkill = nextChoice };
      schedulePracticeAI = () => {};
    `).runInContext(context)
    await context.window.practiceDoAction({ type: 'pendingOptionSelect' })
    expect(context.pendingSkill).toBe(nextChoice)
    expect(context.pendingCardAction).toBeNull()
  })
  it('disposes the worker and ignores a receipt arriving after leaving the page', async () => {
    let reply: (value: unknown) => void = () => {}
    let disposed = false
    const context = vm.createContext({ window: {}, G: { pieces: [] }, myPlayerId: 'practice-human',
      withClientActionId: (action: unknown) => action, clearTimeout() {},
      beginPendingActionFeedback: () => true, request: () => new Promise(resolve => { reply = resolve }),
      dispose: () => { disposed = true }, accepted: false })
    new vm.Script(fs.readFileSync('data/pages/js/practice/battle-controller.js', 'utf8') + `
      practiceSnapshot = { revision: 1 };
      practiceClient = { request, dispose };
      acceptPracticeSnapshot = () => { accepted = true };
      schedulePracticeAI = () => {};
    `).runInContext(context)
    const action = context.window.practiceDoAction({ type: 'endTurn' })
    context.window.disposePracticeBattle()
    reply({ revision: 2 })
    await action
    expect(disposed).toBe(true)
    expect(context.accepted).toBe(false)
  })
})
