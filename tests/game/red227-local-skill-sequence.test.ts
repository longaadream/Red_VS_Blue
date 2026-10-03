import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyBattleAction, type BattleAction } from '@/lib/game/turn'
import * as preview from '@/lib/game/skill-preview'
import { prepareAction } from '@/lib/game/targeting'
import { loadRuleById } from '@/lib/game/skills'
import { runBattleAction } from '@/lib/game/battle-runner'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { toPublicBattleState } from '@/lib/game/deployment'
import { readSkillChoices, skillChoicePromptKey } from '@/lib/game/skill-choice-sequence'
import { makePiece, makeState } from '../helpers/minimal-state'

function fixture(momentum = 5) {
  const definition = JSON.parse(readFileSync('data/skills/shadow-ride-sweep.json', 'utf8'))
  const source = makePiece({ instanceId: 'shadow', templateId: 'shadow', ownerPlayerId: 'player-red', x: 1, y: 5,
    attack: 5, skills: [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }] })
  source.momentum = momentum
  source.statusTags = [{ type: 'momentum-core', stacks: momentum, skillIds: [definition.id] }]
  source.rules = [loadRuleById('rule-momentum-consume')!]
  const target = makePiece({ instanceId: 'side-enemy', ownerPlayerId: 'player-blue', x: 2, y: 3, currentHp: 20, maxHp: 20 })
  const state = makeState({ pieces: [source, target], width: 7, height: 8 })
  state.skillsById[definition.id] = definition
  state.players[0].actionPoints = 10
  const draft = { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'shadow', skillId: definition.id } as BattleAction
  const preparation = prepareAction(state, draft)
  if (preparation.kind !== 'needTarget') throw new Error('expected dash targeting')
  const action = { ...draft, targetX: 4, targetY: 5, selectionId: preparation.selectionId, stateRevision: preparation.stateRevision } as BattleAction
  return { state, action }
}

const sideChoice = { kind: 'target', source: { type: 'rule', id: 'rule-momentum-consume', pieceId: 'shadow' }, targetX: 4, targetY: 4 }

function choiceFor(state: ReturnType<typeof makeState>, action: BattleAction) {
  const prepared = preview.preparePublicSkillAction(state, action, 'player-red')
  if (prepared.status !== 'needs-input' || !prepared.preparation?.promptKey) throw new Error('expected local side prompt')
  return { ...sideChoice, promptKey: prepared.preparation.promptKey }
}

describe('RED-227 local skill choice sequence', () => {
  it('rejects an in-flight stale batch even when the root skill has no targeting steps', () => {
    const { state } = fixture()
    const definition = JSON.parse(readFileSync('data/skills/el-primo-meteor-belt.json', 'utf8'))
    state.pieces[0].skills = [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }]
    state.skillsById[definition.id] = definition
    state.targetingRevision = 4
    const runtime = new RuleRuntime({ rootSeed: 227, tick: 1 })
    const initialRuntime = runtime.snapshot()
    const before = JSON.stringify(state)
    const action = { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'shadow', skillId: definition.id,
      stateRevision: 3, skillChoices: [{ ...sideChoice, promptKey: 'public-choice-v1-' + '0'.repeat(64) }] } as BattleAction
    expect(() => withRuleRuntime(runtime, () => applyBattleAction(state, action))).toThrow(/stale/)
    expect(JSON.stringify(state)).toBe(before)
    expect(runtime.snapshot()).toEqual(initialRuntime)
  })
  it('rejects oversized, executable, and authority-shaped continuation payloads before execution', () => {
    const key = 'public-choice-v1-' + '0'.repeat(64)
    const choice = { ...sideChoice, promptKey: key }
    expect(() => readSkillChoices(Array.from({ length: 17 }, () => choice))).toThrow()
    expect(() => readSkillChoices([{ ...choice, selectionId: 'forged-authority-session' }])).toThrow()
    expect(() => readSkillChoices([{ ...choice, selectedOption: () => true }])).toThrow()
    let accessed = false
    const accessor = Object.defineProperty({ ...choice }, 'targetX', { enumerable: true, get: () => { accessed = true; return 4 } })
    expect(() => readSkillChoices([accessor])).toThrow()
    expect(accessed).toBe(false)
  })
  it('prepares option-first root inputs without executing an unsupported summon preview', () => {
    const definition = JSON.parse(readFileSync('data/skills/naruto-shadow-clone.json', 'utf8'))
    const caster = makePiece({ instanceId: 'naruto', templateId: 'red-naruto', ownerPlayerId: 'player-red', x: 1, y: 1,
      skills: [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }] })
    const state = makeState({ pieces: [caster], width: 7, height: 7 })
    state.skillsById[definition.id] = definition
    const root = { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'naruto', skillId: definition.id } as BattleAction
    const first = preview.preparePublicSkillAction(state, root, 'player-red')
    expect(first).toMatchObject({ status: 'needs-input', preparation: { kind: 'needOption', continuation: false, stateRevision: 0 } })
    if (first.status !== 'needs-input' || !first.preparation) return
    const chosen = { ...root, selectedOption: 'summon', selectionId: first.preparation.selectionId, stateRevision: first.preparation.stateRevision } as BattleAction
    expect(preview.preparePublicSkillAction(state, chosen, 'player-red')).toMatchObject({ status: 'needs-input', preparation: { kind: 'needTarget', continuation: false } })
    expect(preview.preparePublicSkillAction(state, { ...chosen, targetX: 2, targetY: 1 } as BattleAction, 'player-red').status).toBe('unavailable')
    state.targetingRevision = 2
    expect(preview.preparePublicSkillAction(state, chosen, 'player-red').status).toBe('unavailable')
    expect(state.pieces).toHaveLength(1)
  })
  it('returns incomplete root targeting locally before executing any skill', () => {
    const { state, action } = fixture()
    const { targetX: _x, targetY: _y, ...draft } = action as BattleAction & { targetX: number; targetY: number }
    void _x
    void _y
    const before = JSON.stringify(state)
    const result = preview.preparePublicSkillAction(state, draft as BattleAction, 'player-red')
    expect(result).toMatchObject({ status: 'needs-input', preparation: { kind: 'needTarget', continuation: false } })
    if (result.status === 'needs-input') expect(result.preparation).not.toHaveProperty('promptKey')
    expect(JSON.stringify(state)).toBe(before)
  })
  it('discovers the next owned choice locally without mutating authority or exposing transactions', () => {
    const { state, action } = fixture()
    const before = JSON.stringify(state)
    const prepare = (preview as unknown as { preparePublicSkillAction: typeof preview.previewBattleAction }).preparePublicSkillAction
    expect(prepare).toBeTypeOf('function')
    const result = prepare(state, action, 'player-red')
    expect(result).toMatchObject({ status: 'needs-input', preparation: { kind: 'needTarget', source: sideChoice.source,
      candidates: expect.arrayContaining([{ type: 'cell', x: 4, y: 4 }]) } })
    expect(JSON.stringify(result)).not.toMatch(/transaction|rootSeed|effectCode|candidateState|triggerContext|continuationContext/)
    expect(JSON.stringify(state)).toBe(before)
  })


  it('rejects an illegal continuation atomically instead of applying the first dash', () => {
    const { state, action } = fixture()
    const before = JSON.stringify(state)
    expect(() => applyBattleAction(state, { ...action, skillChoices: [{ ...choiceFor(state, action), targetX: 0, targetY: 0 }] } as BattleAction)).toThrow()
    expect(JSON.stringify(state)).toBe(before)
  })

  it('rejects extra answers and restores the external runtime on failure', () => {
    const { state, action } = fixture()
    const runtime = new RuleRuntime({ rootSeed: 227, tick: 1 })
    const before = runtime.snapshot()
    const choice = choiceFor(state, action)
    expect(() => withRuleRuntime(runtime, () => applyBattleAction(state, {
      ...action, skillChoices: [choice, choice],
    } as BattleAction))).toThrow('Invalid skill choice sequence')
    expect(runtime.snapshot()).toEqual(before)
    expect(state.players[0].actionPoints).toBe(10)
  })

  it('records one accepted command and deduplicates repeat delivery', () => {
    const { state, action } = fixture()
    const batch = { ...action, skillChoices: [choiceFor(state, action)], clientActionId: 'red227-one-batch' } as BattleAction & { clientActionId: string }
    const first = runBattleAction(state, batch, { rootSeed: 227 })
    expect(first.state.players[0].actionPoints).toBe(9)
    const duplicate = runBattleAction(first.state, batch, { rootSeed: 227 })
    expect(duplicate.duplicate).toBe(true)
    expect(duplicate.state).toBe(first.state)
  })

  it('uses an already-public network snapshot without projecting server transaction data', () => {
    const { state, action } = fixture()
    const networkState = toPublicBattleState(state, 'player-red')
    const result = preview.preparePublicSkillAction(networkState, action, 'player-red')
    expect(result.status).toBe('needs-input')
    expect(result.status === 'needs-input' && result.preparation?.source).toEqual(sideChoice.source)
    expect(state.pendingTargetSelection).toBeUndefined()
    const authorityPending = applyBattleAction(state, action)
    expect(authorityPending.pendingTargetSelection?.transaction).toBeDefined()
    expect(toPublicBattleState(authorityPending, 'player-red').pendingTargetSelection?.transaction).toBeUndefined()
  })

  it('stops on a different same-source prompt and leaves valid authority credentials for normal continuation', () => {
    const { state, action } = fixture()
    const actualPending = applyBattleAction(state, action).pendingTargetSelection!
    const anotherPromptKey = skillChoicePromptKey('target', { ...actualPending, title: '同一来源的另一项选择' } as unknown as Record<string, unknown>)
    const next = applyBattleAction(state, { ...action, skillChoices: [{ ...sideChoice, promptKey: anotherPromptKey }] } as BattleAction)
    expect(next.players[0].actionPoints).toBe(10)
    expect(next.pieces.find(piece => piece.instanceId === 'shadow')).toMatchObject({ x: 1, y: 5 })
    expect(next.pendingTargetSelection?.stateRevision).toBe((state.targetingRevision ?? 0) + 1)
    const pending = next.pendingTargetSelection!
    const completed = applyBattleAction(next, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetX: 4, targetY: 4,
      selectionId: pending.selectionId, stateRevision: pending.stateRevision,
    })
    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.players[0].actionPoints).toBe(9)
    expect(completed.pieces.find(piece => piece.instanceId === 'side-enemy')?.currentHp).toBe(15)
    const cancelled = applyBattleAction(next, {
      type: 'cancelPendingSelection', playerId: 'player-red', selectionId: pending.selectionId, stateRevision: pending.stateRevision,
    })
    expect(cancelled.pendingTargetSelection).toBeUndefined()
  })

  it('distinguishes equal-shaped prompts at different consumer occurrences', () => {
    const { state, action } = fixture()
    const pending = applyBattleAction(state, action).pendingTargetSelection!
    const changed = { ...pending, transaction: { ...pending.transaction!, currentInteraction: {
      ...pending.transaction!.currentInteraction!, consumerOrdinal: pending.transaction!.currentInteraction!.consumerOrdinal + 1,
    } } }
    expect(skillChoicePromptKey('target', pending as unknown as Record<string, unknown>))
      .not.toBe(skillChoicePromptKey('target', changed as unknown as Record<string, unknown>))
  })

  it('rejects stale root credentials before any staged choice changes state or RNG', () => {
    const { state, action } = fixture()
    const choice = choiceFor(state, action)
    state.targetingRevision = 8
    const before = JSON.stringify(state)
    const runtime = new RuleRuntime({ rootSeed: 227, tick: 1 })
    const beforeRuntime = runtime.snapshot()
    expect(() => withRuleRuntime(runtime, () => applyBattleAction(state, { ...action, skillChoices: [choice] } as BattleAction))).toThrow()
    expect(JSON.stringify(state)).toBe(before)
    expect(runtime.snapshot()).toEqual(beforeRuntime)
  })

  it('keeps two choices from one rule in chronological order and stops reordered answers', () => {
    const { state, action } = fixture(4)
    state.pieces[0].rules!.push({
      id: 'test-two-public-choices', name: '双阶段测试', trigger: { type: 'afterSkillUsed' },
      effect: (_battle: unknown, context: Record<string, unknown>) => {
        if (!context.selectedOption) return { success: false, needsOptionSelection: true, playerId: 'player-red',
          title: '选择一个方案', options: [{ label: '继续', value: 'continue' }], canCancel: true }
        if (context.targetX !== 2 || context.targetY !== 2) return { success: false, needsTargetSelection: true,
          playerId: 'player-red', title: '选择落点', targetType: 'grid', candidates: [{ type: 'cell', x: 2, y: 2 }], canCancel: true }
        return { success: true }
      },
    } as never)
    const first = applyBattleAction(state, action)
    const option = first.pendingOptionSelection!
    expect(option).toBeDefined()
    const second = applyBattleAction(first, { type: 'pendingOptionSelect', playerId: 'player-red', selectedOption: 'continue',
      selectionId: option.selectionId, stateRevision: option.stateRevision })
    const target = second.pendingTargetSelection!
    expect(target).toBeDefined()
    const choices = [
      { kind: 'option', source: option.source, promptKey: skillChoicePromptKey('option', option as unknown as Record<string, unknown>), selectedOption: 'continue' },
      { kind: 'target', source: target.source, promptKey: skillChoicePromptKey('target', target as unknown as Record<string, unknown>), targetX: 2, targetY: 2 },
    ]
    const complete = applyBattleAction(state, { ...action, skillChoices: choices } as BattleAction)
    expect(complete.pendingOptionSelection).toBeUndefined()
    expect(complete.pendingTargetSelection).toBeUndefined()
    expect(complete.players[0].actionPoints).toBe(9)
    const reordered = applyBattleAction(state, { ...action, skillChoices: [...choices].reverse() } as BattleAction)
    expect(reordered.pendingOptionSelection).toBeDefined()
    expect(reordered.players[0].actionPoints).toBe(10)
  })
})
