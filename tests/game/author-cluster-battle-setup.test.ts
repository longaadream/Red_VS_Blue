/* eslint-disable @typescript-eslint/no-explicit-any -- this host test assembles JSON-authored graphs. */
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { loadMaps } from '@/config/maps'
import { createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import { runBattleAction } from '@/lib/game/battle-runner'
import { getPieceById } from '@/lib/game/piece-repository'
import { executeSkillFunction } from '@/lib/game/skills'
import { getSkillById } from '@/lib/game/skill-repository'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { compileGameplayModuleGraph, GAMEPLAY_MODULE_COMPILER_VERSION, GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-document'

beforeAll(async () => {
  await loadMaps()
})

afterEach(() => globalTriggerSystem.clearRules())

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function typedFireballDocument(saveCurrentGroup: boolean): any {
  const source = JSON.parse(readFileSync('data/skills/fireball.json', 'utf8')) as any
  const graph = clone(source.gameplayModules.entries.code.graph) as any
  const body = graph.body as any[]
  const damage = body.find(statement => statement.id === 'damage')
  if (!damage) throw new Error('Expected the production Fireball graph to have a damage node')

  damage.version = '3'
  damage.parameters = {
    sourceType: 'piece',
    targetType: 'piece',
    amountType: 'number',
    resultType: 'record',
    damageType: 'normal',
  }
  const damageText = body.find(statement => statement.id === 'damage-text')
  const damageTextIndex = body.findIndex(statement => statement.id === 'damage-text')
  if (!damageText || damageTextIndex < 0) throw new Error('Expected the production Fireball graph to have a damage text node')
  body.splice(damageTextIndex, 0, {
    kind: 'call', id: 'damage-value', module: 'effect.result-number', version: '1',
    inputs: { result: { kind: 'output', node: 'damage', port: 'result' } },
    parameters: { field: 'damage' },
  })
  damageText.inputs.value = { kind: 'output', node: 'damage-value', port: 'value' }

  if (saveCurrentGroup) {
    const targetIndex = body.findIndex(statement => statement.id === 'target')
    const damageIndex = body.findIndex(statement => statement.id === 'damage')
    body.splice(targetIndex, 0,
      { kind: 'call', id: 'current-group', module: 'ref.current-cluster', version: '1', inputs: {}, parameters: {} },
      {
        kind: 'call', id: 'saved-group', module: 'local.declare', version: '2',
        inputs: { initial: { kind: 'output', node: 'current-group', port: 'group' } },
        parameters: { name: 'savedGroup', valueType: 'record' },
      },
    )
    const savedRead = {
      kind: 'call', id: 'saved-group-read', module: 'local.read', version: '1',
      inputs: { handle: { kind: 'output', node: 'saved-group', port: 'handle' } },
      parameters: { valueType: 'record' },
    }
    body.splice(damageIndex + 2, 0, savedRead)
    damage.inputs.abilityGroup = { kind: 'output', node: 'saved-group-read', port: 'value' }
  } else {
    // Keep this scenario on the typed current-group path without introducing
    // a hand-written English skill identifier. The node is evaluated while
    // the real skill host is active and its authenticated record is passed to
    // the damage module after the selector resumes.
    const targetIndex = body.findIndex(statement => statement.id === 'target')
    body.splice(targetIndex, 0,
      { kind: 'call', id: 'current-group', module: 'ref.current-cluster', version: '1', inputs: {}, parameters: {} },
      { kind: 'call', id: 'target-gate', module: 'local.declare', version: '2',
        inputs: { initial: { kind: 'output', node: 'current-group', port: 'group' } },
        parameters: { name: 'targetGate', valueType: 'record' } },
    )
    damage.inputs.abilityGroup = { kind: 'output', node: 'current-group', port: 'group' }
  }

  const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
  return {
    ...source,
    code: compiled.code,
    gameplayModules: {
      ...source.gameplayModules,
      entries: {
        ...source.gameplayModules.entries,
        code: { graph, compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION },
      },
    },
  }
}

async function createJainaFireballBattle() {
  const jaina = getPieceById('jaina')
  const guldan = getPieceById('guldan')
  if (!jaina || !guldan) throw new Error('Expected static Jaina and Guldan templates')

  const battle = await createInitialBattleForPlayers(
    ['player-red', 'player-blue'],
    [jaina, guldan],
    undefined,
    'large-hole-arena',
    { firstPlayerId: 'player-red', rootSeed: 252 },
  )
  if (!battle) throw new Error('Expected an initialized Jaina battle')

  // The production initializer returns the opening start phase. Advance it
  // through the real reducer so selector suspension and its later resume are
  // exercised under the same action-phase invariant as gameplay.
  const actionState = runBattleAction(battle, { type: 'beginPhase' }, { rootSeed: 252 }).state
  const initialCaster = actionState.pieces.find(piece => piece.templateId === 'jaina')
  if (!initialCaster) throw new Error('Expected the initialized Jaina instance')
  // Submit the setup move through the authoritative reducer. This keeps the
  // host evidence on a real legal board position rather than mutating pieces
  // directly just to make the target selector fit within range.
  const movedState = runBattleAction(actionState, {
    type: 'move', playerId: 'player-red', pieceId: initialCaster.instanceId, toX: 7, toY: 3,
  }, { rootSeed: 252 }).state
  // A legal move spends the opening action point. Let both players advance
  // through the normal turn reducer so the next red action phase refreshes
  // resources before Fireball is submitted.
  const blueStart = runBattleAction(movedState, { type: 'endTurn', playerId: 'player-red' }, { rootSeed: 252 }).state
  const blueAction = runBattleAction(blueStart, { type: 'beginPhase' }, { rootSeed: 252 }).state
  const redStart = runBattleAction(blueAction, { type: 'endTurn', playerId: 'player-blue' }, { rootSeed: 252 }).state
  const redAction = runBattleAction(redStart, { type: 'beginPhase' }, { rootSeed: 252 }).state
  // `runBattleAction` intentionally strips the presentation skill cache from
  // its authoritative state. Keep the initialized cache on this test host so
  // the test can replace only Fireball's authored definition before the next
  // reducer action; the reducer will still hydrate it through the normal
  // server-skill boundary.
  redAction.skillsById = battle.skillsById

  const caster = redAction.pieces.find(piece => piece.templateId === 'jaina')
  const target = redAction.pieces.find(piece => piece.templateId === 'guldan')
  if (!caster || !target) throw new Error('Expected initialized Jaina and Guldan instances')
  return { battle: redAction, caster, target }
}

async function createBattle(rootSeed?: number) {
  const mortis = getPieceById('mortis')
  const guldan = getPieceById('guldan')
  if (!mortis || !guldan) throw new Error('Expected static Mortis and Guldan templates')

  const battle = await createInitialBattleForPlayers(
    ['player-red', 'player-blue'],
    [mortis, guldan],
    undefined,
    'large-hole-arena',
    {
      firstPlayerId: 'player-red',
      ...(rootSeed === undefined ? {} : { rootSeed }),
    },
  )
  if (!battle) throw new Error('Expected an initialized battle')
  return battle
}

describe('author Cluster battle setup', () => {
  it('adopts complete ability groups without duplicating their rule roots or adopting player rules', async () => {
    const battle = await createBattle(252)
    const mortis = battle.pieces.find(piece => piece.templateId === 'mortis')
    const guldan = battle.pieces.find(piece => piece.templateId === 'guldan')
    if (!mortis || !guldan) throw new Error('Expected selected pieces on the board')

    expect(mortis.abilityGroups?.map(group => group.id)).toEqual([
      'skills:mortis-night-construct',
      'skills:mortis-shovel-charge',
    ])
    expect(mortis.abilityGroups?.find(group => group.id === 'skills:mortis-night-construct')).toMatchObject({
      skills: ['mortis-night-construct'],
      rules: ['rule-mortis-damage-counter'],
    })
    expect(mortis.rules.map(rule => rule.id)).toEqual(['rule-mortis-damage-counter'])
    expect(mortis.abilityGroupOwnership?.rules['rule-mortis-damage-counter']).toHaveLength(1)

    expect(guldan.abilityGroups?.map(group => group.id)).toEqual([
      'skills:fel-blessing',
      'skills:shadow-bolt',
      'skills:soul-fracture',
    ])
    expect(guldan.abilityGroups?.flatMap(group => group.rules)).not.toContain('rule-soul-fracture-player')
    expect(guldan.rules).toEqual([])
    expect(battle.players.find(player => player.playerId === guldan.ownerPlayerId)?.rules)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'rule-soul-fracture-player' })]))
  })

  it('keeps bootstrap IDs deterministic in a separate ID namespace', async () => {
    const first = await createBattle(252)
    const second = await createBattle(252)
    const groupIds = (battle: typeof first) => battle.pieces
      .filter(piece => piece.templateId === 'mortis')
      .flatMap(piece => piece.abilityGroups ?? [])
      .map(group => group.instanceId)

    expect(groupIds(first)).toEqual(groupIds(second))
    expect(groupIds(first).every(id => id.startsWith('cluster-000000fc-'))).toBe(true)
  })

  it('uses the deterministic piece-local fallback when no RuleRuntime is supplied', async () => {
    const battle = await createBattle(undefined)
    const mortis = battle.pieces.find(piece => piece.templateId === 'mortis')
    if (!mortis) throw new Error('Expected Mortis on the board')

    expect(mortis.abilityGroups?.map(group => group.instanceId)).toEqual([
      'player-red-1:ability-group:skills:mortis-night-construct',
      'player-red-1:ability-group:skills:mortis-shovel-charge',
    ])
  })

  it('installs Velen delayed effects on the owner when prophecy is created in a formal battle', async () => {
    const velen = getPieceById('velen')
    const mortis = getPieceById('mortis')
    if (!velen || !mortis) throw new Error('Expected static Velen and Mortis templates')

    const battle = await createInitialBattleForPlayers(
      ['player-red', 'player-blue'],
      [velen, mortis],
      undefined,
      'large-hole-arena',
      { firstPlayerId: 'player-red', rootSeed: 252 },
    )
    if (!battle) throw new Error('Expected an initialized battle')

    const velenInstance = battle.pieces.find(piece => piece.templateId === 'velen')
    const owner = battle.players.find(player => player.playerId === 'player-red')
    const definition = getSkillById('velen-holy-prophecy')
    if (!velenInstance || !owner || !definition) throw new Error('Expected initialized Velen skill state')

    owner.hand = [{ instanceId: 'formal-prophecy-card', cardId: 'holy-heal', ownerPlayerId: owner.playerId }]
    const result = executeSkillFunction(definition, {
      piece: velenInstance,
      target: null,
      targetPosition: null,
      targets: [],
      selectedOption: 'formal-prophecy-card',
      battle,
      skill: {
        id: definition.id,
        name: definition.name,
        type: definition.type,
        powerMultiplier: definition.powerMultiplier,
      },
    }, battle)

    expect(result).toMatchObject({ success: true })
    expect(owner.rules?.map(rule => rule.id)).toEqual(['rule-velen-delayed-effects'])
    expect(owner.hand[0].contentState?.velenHolyProphecy).toMatchObject({ sourcePieceId: velenInstance.instanceId })
  })

  it('executes typed Fireball attribution on a real initialized Cluster and keeps the ordinary skill root', async () => {
    const { battle, caster, target } = await createJainaFireballBattle()
    battle.skillsById.fireball = typedFireballDocument(false)
    const observed: any[] = []
    globalTriggerSystem.addRule({
      id: 'author-cluster-fireball-observer',
      name: 'author-cluster-fireball-observer',
      description: '',
      trigger: { type: 'afterDamageDealt' },
      effect: (_state: any, context: any) => {
        observed.push({ type: context.type, skillId: context.skillId,
          sourceId: context.sourcePiece?.instanceId, targetId: context.targetPiece?.instanceId })
        return { success: true }
      },
    } as any)

    const group = caster.abilityGroups?.find(candidate => candidate.id === 'skills:fireball')
    expect(group).toBeDefined()
    expect(caster.skills.find(skill => skill.skillId === 'fireball')?.abilityGroupIds)
      .toContain(group?.instanceId)
    const hpBefore = target.currentHp
    const pendingResult = runBattleAction(battle, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: caster.instanceId, skillId: 'fireball',
    }, { rootSeed: 252 }).state
    const pending = pendingResult.pendingTargetSelection
    expect(pending).toMatchObject({ targetType: 'piece', filter: 'enemy' })
    expect(pending?.candidates).toEqual(expect.arrayContaining([{ type: 'piece', pieceId: target.instanceId }]))
    if (!pending) throw new Error('Expected the real Fireball selector to suspend')

    const restored = JSON.parse(JSON.stringify(pendingResult)) as typeof battle
    // Skill definitions are a presentation cache and are intentionally
    // stripped from the authoritative reducer result. Rehydrate the authored
    // Fireball document at the persistence boundary, just as the content
    // graph host does before resuming a pending action.
    restored.skillsById = { fireball: battle.skillsById.fireball }
    const restoredDamageNode = (restored.skillsById.fireball as any).gameplayModules.entries.code.graph.body
      .find((statement: any) => statement.id === 'damage')
    expect(restoredDamageNode?.version).toBe('3')
    expect((restored.skillsById.fireball as any).code).toContain('flow.clusters.attribution')
    const completed = runBattleAction(restored, {
      type: 'pendingTargetSelect', playerId: pending.playerId, targetPieceId: target.instanceId,
      selectionId: pending.selectionId, stateRevision: pending.stateRevision,
    }, { rootSeed: 252 }).state
    const damageLog = completed.actions?.filter(action => action.type === 'damage').at(-1)?.payload as any
    const expectedDamage = Math.max(1, Math.floor(caster.attack * 1.5 - (target.defense || 0)))
    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.pieces.find(piece => piece.instanceId === target.instanceId)?.currentHp)
      .toBe(hpBefore - expectedDamage)
    expect(damageLog).toMatchObject({
      sourceId: caster.instanceId,
      targetId: target.instanceId,
      skillId: 'fireball',
      finalDamage: expectedDamage,
      damageSource: { kind: 'piece', sourceId: caster.instanceId, playerId: 'player-red' },
    })
    expect(observed).toContainEqual({ type: 'afterDamageDealt', skillId: 'fireball',
      sourceId: caster.instanceId, targetId: target.instanceId })
  })

  it('preserves a typed current Cluster saved in a local across the real pending selector', async () => {
    const { battle, caster, target } = await createJainaFireballBattle()
    const document = typedFireballDocument(true)
    battle.skillsById.fireball = document
    const graphBody = document.gameplayModules.entries.code.graph.body as any[]
    const targetIndex = graphBody.findIndex(statement => statement.id === 'target')
    const savedGroupIndex = graphBody.findIndex(statement => statement.id === 'saved-group')
    const damage = graphBody.find(statement => statement.id === 'damage')
    expect(savedGroupIndex).toBeGreaterThanOrEqual(0)
    expect(savedGroupIndex).toBeLessThan(targetIndex)
    expect(damage?.inputs?.abilityGroup).toEqual({ kind: 'output', node: 'saved-group-read', port: 'value' })

    const hpBefore = target.currentHp
    const pendingResult = runBattleAction(battle, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: caster.instanceId, skillId: 'fireball',
    }, { rootSeed: 252 }).state
    const pending = pendingResult.pendingTargetSelection
    expect(pending).toBeDefined()
    if (!pending) throw new Error('Expected the local-save Fireball graph to suspend at its selector')

    // The real reducer serializes the suspended selector transaction. Restore
    // from JSON before submitting the target so the local-held group crosses
    // the same persistence boundary as a saved pending action.
    const restored = JSON.parse(JSON.stringify(pendingResult)) as typeof battle
    restored.skillsById = { fireball: battle.skillsById.fireball }
    const restoredDamageNode = (restored.skillsById.fireball as any).gameplayModules.entries.code.graph.body
      .find((statement: any) => statement.id === 'damage')
    expect(restoredDamageNode?.version).toBe('3')
    const completed = runBattleAction(restored, {
      type: 'pendingTargetSelect', playerId: pending.playerId, targetPieceId: target.instanceId,
      selectionId: pending.selectionId, stateRevision: pending.stateRevision,
    }, { rootSeed: 252 }).state
    const damageLog = completed.actions?.filter(action => action.type === 'damage').at(-1)?.payload as any
    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.pieces.find(piece => piece.instanceId === target.instanceId)?.currentHp)
      .toBe(hpBefore - Math.max(1, Math.floor(caster.attack * 1.5 - (target.defense || 0))))
    expect(damageLog).toMatchObject({ skillId: 'fireball', targetId: target.instanceId })
  })
})
