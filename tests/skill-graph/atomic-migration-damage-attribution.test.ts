import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createSkillCodeFlow, dealDamage } from '../../lib/game/skills'
import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import { atomicDamageAttributionRecipe } from '../../lib/skill-graph/atomic-migration-damage-attribution'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayCallStatement, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

const output = (node: string, port = 'value') => ({ kind: 'output' as const, node, port })
const literal = (value: unknown) => ({ kind: 'literal' as const, value: value as never })

function unattributedGraph(module: string, parameters: Record<string, string>): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    outputs: [{ name: 'result', type: 'record' }],
    body: [
      { kind: 'call', id: 'source', module: 'ref.source', version: '1' },
      { kind: 'call', id: 'target', module: 'ref.target', version: '1' },
      {
        kind: 'call', id: 'damage', module, version: '1',
        inputs: {
          source: output('source', 'piece'), target: output('target', 'piece'), amount: literal(3),
        },
        parameters,
      },
      { kind: 'return', id: 'done', values: { result: output('damage', 'result') } },
    ],
  }
}

function runDamageGraph(graph: GameplayModuleGraph) {
  const source = asPieceInstance(makePiece({ instanceId: 'damage-source', ownerPlayerId: 'player-red' }))
  const target = asPieceInstance(makePiece({ instanceId: 'damage-target', ownerPlayerId: 'player-blue', currentHp: 20, maxHp: 20 }))
  const battle = makeState({ pieces: [source, target] })
  const context = { sourcePiece: source, targetPiece: target, piece: source, skill: { id: 'current-skill' } }
  const flow = createSkillCodeFlow(battle, context, 'skill', { prepareAuthorEffect: (_kind: 'damage' | 'heal', amount: number) => amount })
  const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
  expect(compiled.diagnostics).toEqual([])
  // The historical shishio adapter called the card/skill damage facade with
  // no battle argument. Supply the same closed facade shape to both graphs;
  // the migrated graph goes through flow.effects and the same host beneath it.
  const legacyFacade = (
    attacker: Parameters<typeof dealDamage>[0],
    victim: Parameters<typeof dealDamage>[1],
    amount: number,
    type: Parameters<typeof dealDamage>[3],
    state = battle,
  ) => dealDamage(attacker, victim, amount, type, state)
  const execute = new Function('flow', 'battle', 'dealDamage', `return (${compiled.code})`)(flow, battle, legacyFacade) as (value: unknown) => unknown
  const result = execute(context)
  const eventSnapshot = JSON.stringify(battle.actions, (_key, value) => value === undefined ? '__undefined__' : value)
  return { result, targetHp: target.currentHp, eventSnapshot }
}

describe('independent damage attribution migration', () => {
  it('keeps the real Hidan fatal call source and kill attribution through unified damage', () => {
    const document = JSON.parse(readFileSync('data/rules/rule-hidan-undying-tick.json', 'utf8'))
    const calls: GameplayCallStatement[] = []
    const walk = (value: unknown) => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) { value.forEach(walk); return }
      const record = value as Record<string, unknown>
      if (record.kind === 'literal') return
      if (record.kind === 'call' && record.id === 'fatal') calls.push(record as unknown as GameplayCallStatement)
      Object.values(record).forEach(walk)
    }
    walk(document.gameplayModules)
    expect(calls).toHaveLength(1)
    const fatal = calls[0]
    // Exercise the frozen pre-migration boundary even after production data is
    // rewritten, while retaining the current skill's amount and attribution.
    const source: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'triggerSkill', outputs: [{ name: 'result', type: 'record' }],
      body: [
        { kind: 'call', id: 'holder', module: 'ref.holder', version: '1' },
        { kind: 'call', id: 'enemy', module: 'ref.event-player', version: '1' },
        { ...fatal, module: 'effect.damage-with-killer', version: '1',
          parameters: { damageType: 'true', skillId: 'undying-expire', inputPolicy: 'host' },
          inputs: { source: { kind: 'output', node: 'holder', port: 'piece' }, target: { kind: 'output', node: 'holder', port: 'piece' },
            amount: fatal.inputs!.amount, killerPlayer: { kind: 'output', node: 'enemy', port: 'player' } } },
        { kind: 'return', id: 'done', values: { result: { kind: 'output', node: 'fatal', port: 'result' } } },
      ],
    }
    const run = (graph: GameplayModuleGraph) => {
      const hidan = asPieceInstance(makePiece({ instanceId: 'hidan', currentHp: 2, maxHp: 10 }))
      const battle = makeState({ pieces: [hidan] })
      const flow = createSkillCodeFlow(battle, { piece: hidan, rulePiece: hidan, playerId: 'player-blue' }, 'triggerSkill')
      const code = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
      const execute = new Function('flow', `return (${code})`)(flow) as (context: unknown) => unknown
      const result = execute({})
      return { result, players: battle.players, graveyard: battle.graveyard.map(piece => piece.instanceId) }
    }
    const migrated = rewriteAtomicGraph(source, atomicDamageAttributionRecipe)
    expect(run(migrated)).toEqual(run(source))
    expect(rewriteAtomicGraph(migrated, atomicDamageAttributionRecipe)).toEqual(migrated)
  })

  it.each([
    ['effect.damage-without-skill-id', { damageType: 'physical' }, true],
    ['effect.damage-pieces-unattributed', { damageType: 'true' }, false],
  ] as const)('migrates %s to explicit unattributed policy and preserves settlement events', (module, parameters, exposesFields) => {
    const source = unattributedGraph(module, parameters)
    const migrated = rewriteAtomicGraph(source, atomicDamageAttributionRecipe)
    const migratedCall = migrated.body.find(statement => statement.kind === 'call' && statement.id === 'damage') as GameplayCallStatement
    expect(migratedCall.module).toBe('author.effect.damage')
    expect(migratedCall.version).toBe('2')
    expect(migratedCall.parameters).toMatchObject({ attribution: 'unattributed', sourceType: 'piece', targetType: 'piece', amountType: 'number', resultType: 'record' })
    expect(migratedCall.parameters?.skillId).toBeUndefined()
    if (exposesFields) {
      expect(migrated.body.some(statement => statement.kind === 'call' && statement.module === 'result.field' && statement.parameters?.field === 'success')).toBe(true)
      expect(migrated.body.some(statement => statement.kind === 'call' && statement.module === 'result.field' && statement.parameters?.field === 'damage')).toBe(true)
    } else {
      expect(migrated.body.filter(statement => statement.kind === 'call')).toHaveLength(3)
    }

    const legacy = runDamageGraph(source)
    const next = runDamageGraph(migrated)
    expect(next.targetHp).toBe(legacy.targetHp)
    expect(next.eventSnapshot).toBe(legacy.eventSnapshot)
    const resultRecord = next.result && typeof next.result === 'object' && !Array.isArray(next.result)
      ? next.result as Record<string, unknown>
      : {}
    const nestedResult = resultRecord.result && typeof resultRecord.result === 'object' && !Array.isArray(resultRecord.result)
      ? resultRecord.result as Record<string, unknown>
      : resultRecord
    expect(nestedResult.damage).toBeGreaterThan(0)
  })

  it('rejects an unattributed legacy graph with an absent flame-spirit damage type', () => {
    const source = unattributedGraph('effect.damage-pieces-unattributed', {})
    expect(rewriteAtomicGraph(source, atomicDamageAttributionRecipe).body.find(statement => statement.kind === 'call' && statement.id === 'damage')).toMatchObject({
      module: 'effect.damage-pieces-unattributed', version: '1',
    })
  })
})
