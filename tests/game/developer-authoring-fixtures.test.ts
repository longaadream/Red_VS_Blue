/* eslint-disable @typescript-eslint/no-explicit-any -- UI-produced documents are validated by the real content loader. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyBattleAction, type BattleAction, type BattleState } from '../../lib/game/turn'
import { prepareAction } from '../../lib/game/targeting'
import { RuleRuntime, withRuleRuntime } from '../../lib/game/rule-runtime'
import { globalTriggerSystem } from '../../lib/game/triggers'
import { toPublicBattleState } from '../../lib/game/deployment'
import { clearRuleCache, clearSkillDefinitionCache, dealDamage } from '../../lib/game/skills'
import { assertContentGraphArtifact } from '../../electron-editor/content-graph'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'
import { createAuthorClusterRuntime } from '../../lib/game/author-clusters'
import { planAuthorClusterInitialization } from '../../lib/game/author-cluster-initialization'

// These fixtures must be copied from successful developer-authoring-smoke UI
// output. Do not construct or repair a graph here: the saved program is what
// this suite executes, including its generated code and external Rule.
const fixtureRoot = 'tests/game/fixtures/developer-authoring'
const read = (file: string) => JSON.parse(readFileSync(join(fixtureRoot, file), 'utf8'))

function withAuthoredProfile<T>(run: (documents: Record<string, any>) => T): T {
  const manifest = read('index.json') as Record<string, { collection: string; file: string }>
  const root = mkdtempSync(join(tmpdir(), 'rvb-developer-ui-runtime-'))
  const previousRoot = process.env.RVB_PROFILE_ROOT
  const documents: Record<string, any> = {}
  try {
    for (const [key, source] of Object.entries(manifest)) {
      const document = read(source.file)
      assertContentGraphArtifact(document)
      documents[key] = document
      const directory = join(root, 'data', source.collection)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, document.id + '.json'), JSON.stringify(document))
    }
    process.env.RVB_PROFILE_ROOT = root
    globalTriggerSystem.clearRules()
    clearRuleCache(); clearSkillDefinitionCache()
    return run(documents)
  } finally {
    globalTriggerSystem.clearRules()
    clearRuleCache(); clearSkillDefinitionCache()
    if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
}

function scenario(skill: any) {
  const caster = asPieceInstance(makePiece({ instanceId: 'caster', x: 1, y: 1,
    ownerPlayerId: 'player-red', faction: 'red', currentHp: 37, maxHp: 80, attack: 10, moveRange: 4,
    skills: [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }] }))
  caster.name = '试用本体'; caster.defense = 6; caster.isCore = true
  const enemy = asPieceInstance(makePiece({ instanceId: 'enemy', x: 4, y: 1,
    ownerPlayerId: 'player-blue', faction: 'blue', currentHp: 40, maxHp: 40 }))
  enemy.defense = 2; enemy.isCore = true
  const state = makeState({ pieces: [caster, enemy], width: 8, height: 8, phase: 'action' })
  state.players[0].actionPoints = 5
  state.players[0].chargePoints = 5
  state.skillsById[skill.id] = skill

  // Use the same authoritative static Cluster bootstrap as battle setup. The
  // editor fixture intentionally supplies only the authored skill document,
  // so this keeps the test host realistic without manufacturing a group in
  // the fixture state.
  const clusterRuntime = createAuthorClusterRuntime({})
  const plan = planAuthorClusterInitialization(caster, { skills: state.skillsById })
  for (const definition of plan.definitions) clusterRuntime.adopt(caster, definition)
  return state
}

function cast(initial: BattleState, skill: any, target: Record<string, unknown>, teleport = false, blockTeleport = false) {
  const choose = (prompt: any) => {
    const option = prompt.options?.find((item: any) => teleport ? /传送/.test(item.label) : /召唤/.test(item.label))
    if (!option) throw new Error('作者选项中缺少预期的召唤方式')
    return option.value
  }
  return withRuleRuntime(new RuleRuntime({ rootSeed: 594 }), () => {
    if (blockTeleport) globalTriggerSystem.addRule({
      id: 'developer-teleport-blocker', name: '测试传送阻挡', description: '',
      trigger: { type: 'beforePiecePositionChange' },
      effect: (_battle, context) => context.sourcePiece?.instanceId === 'caster'
        ? { success: true, blocked: true, message: '测试：传送被阻挡' } : { success: true },
    })
    let state = initial
    let action: BattleAction = { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'caster', skillId: skill.id }
    for (let step = 0; step < 8; step += 1) {
      const prepared = prepareAction(state, action)
      if (prepared.kind === 'ready') break
      if (prepared.kind === 'invalid') throw new Error(prepared.message || prepared.code)
      action = { ...action, ...(prepared.kind === 'needOption' ? { selectedOption: choose(prepared) } : target),
        selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }
      if (step === 7) throw new Error('准备选择没有结束')
    }
    for (let step = 0; step < 8; step += 1) {
      state = applyBattleAction(state, action)
      if (state.pendingOptionSelection) {
        const prompt = state.pendingOptionSelection
        action = { type: 'pendingOptionSelect', playerId: prompt.playerId, selectedOption: choose(prompt),
          selectionId: prompt.selectionId, stateRevision: prompt.stateRevision }
      } else if (state.pendingTargetSelection) {
        const prompt = state.pendingTargetSelection
        action = { type: 'pendingTargetSelect', playerId: prompt.playerId, ...target,
          selectionId: prompt.selectionId, stateRevision: prompt.stateRevision }
      } else return state
    }
    throw new Error('效果没有在有限选择步骤内结束')
  })
}

describe('skills authored from blank in the Chinese sentence editor', () => {
  it('executes the saved fireball expression, defenses and resource cost', () => withAuthoredProfile(({ fireball }) => {
    const state = cast(scenario(fireball), fireball, { targetPieceId: 'enemy' })
    expect(state.pieces.find(piece => piece.instanceId === 'enemy')?.currentHp).toBe(27)
    expect(state.players[0].actionPoints).toBe(4)
    expect(state.pendingTargetSelection).toBeUndefined()
    expect(state.pendingOptionSelection).toBeUndefined()
  }))

  it.each([false, true])('executes the saved shadow clone and external hurt Rule (teleport=%s)', teleport => withAuthoredProfile(({ shadowclone, dissolve }) => {
    const state = cast(scenario(shadowclone), shadowclone, { targetX: 3, targetY: 1 }, teleport)
    const caster = state.pieces.find(piece => piece.instanceId === 'caster')!
    const clone = state.pieces.find(piece => !['caster', 'enemy'].includes(piece.instanceId))!
    expect(clone).toBeDefined()
    expect(caster).toMatchObject({ x: teleport ? 3 : 1, y: 1 })
    expect(clone).toMatchObject({ x: teleport ? 1 : 3, y: 1, currentHp: 37, maxHp: 80,
      attack: 10, defense: 6, moveRange: 0, skills: [], statusTags: [], isCore: false, noKillCharge: true })
    expect(clone.rules?.some(rule => rule.id === dissolve.id)).toBe(true)
    expect(state.players[0].actionPoints).toBe(4)
    expect(caster.skills.find(skill => skill.skillId === shadowclone.id)?.currentCooldown).toBe(3)
    // Creation-time display is observable through the same public projection
    // the battle UI consumes; later changes to the original do not refresh it.
    caster.attack = 99
    const publicState = toPublicBattleState(state, 'player-blue')
    const bindings = (publicState.extensions?.skillPresentation as any)?.bindings ?? []
    expect(bindings.find((binding: any) => binding.targetId === clone.instanceId)?.display)
      .toMatchObject({ currentHp: 37, maxHp: 80, attack: 10, defense: 6, moveRange: 4, isCore: true })
    const enemy = state.pieces.find(piece => piece.instanceId === 'enemy')!
    withRuleRuntime(new RuleRuntime({ rootSeed: 594 }), () => dealDamage(enemy, clone, 1, 'true', state, 'developer-hurt-test'))
    expect(state.pieces.some(piece => piece.instanceId === clone.instanceId)).toBe(false)
    expect(state.pieces.some(piece => piece.instanceId === caster.instanceId)).toBe(true)
    expect(state.graveyard?.filter(piece => piece.instanceId === clone.instanceId)).toHaveLength(1)
  }))

  it('rejects an occupied original cell after blocked teleport without author fallback or overlap', () => withAuthoredProfile(({ shadowclone }) => {
    const state = cast(scenario(shadowclone), shadowclone, { targetX: 3, targetY: 1 }, true, true)
    expect(state.pieces).toHaveLength(2)
    expect(state.pieces.find(piece => piece.instanceId === 'caster')).toMatchObject({ x: 1, y: 1 })
    expect(state.players[0].actionPoints).toBe(4)
    expect(state.pendingOptionSelection).toBeUndefined()
    expect(state.pendingTargetSelection).toBeUndefined()
  }))
})
