/* eslint-disable @typescript-eslint/no-explicit-any -- differential fixtures intentionally use minimal trigger contexts. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { importContentGraph } from '@/electron-editor/content-graph-import'
import { applyContentGraph } from '@/electron-editor/content-graph-document'
import { assertCounterPassiveAuthorGraph, buildCounterPassiveGraph } from '@/scripts/migrate-semantic-counter-passives'
import { clearRuleCache, loadRuleById } from '@/lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries

type Execution = { state: any; contexts: any[]; extras?: any; turnNumbers?: number[] }
type Build = () => Execution

function testPiece(options: Record<string, any> = {}): any {
  const { name = options.instanceId || '测试棋子', defense = 4, ...pieceOptions } = options
  const piece: any = makePiece(pieceOptions)
  // makePiece intentionally keeps these two fixture fields canonical; assign
  // them here so differential cases exercise the values used in messages and
  // damage resolution.
  piece.name = name
  piece.defense = defense
  return piece
}

function snapshot(state: any, extras: any): any {
  const plain = JSON.parse(JSON.stringify(state))
  return { state: plain, extras: JSON.parse(JSON.stringify(extras ?? null)) }
}

function execute(id: string, semantic: boolean, build: Build): any {
  const root = mkdtempSync(join(tmpdir(), 'rvb-counter-passives-'))
  const oldRoot = process.env.RVB_PROFILE_ROOT
  mkdirSync(join(root, 'data/rules'), { recursive: true })
  try {
    process.env.RVB_PROFILE_ROOT = root
    const frozen = fixture['rules/' + id]
    const document = semantic ? applyGameplayModuleGraph(frozen, buildCounterPassiveGraph(id), 'skillCode') : frozen
    writeFileSync(join(root, 'data/rules', id + '.json'), JSON.stringify(document))
    clearRuleCache()
    const rule = loadRuleById(id, true, true)!
    const execution = build()
    const results: any[] = []
    for (const [index, context] of execution.contexts.entries()) {
      if (execution.turnNumbers?.[index] !== undefined) execution.state.turn.turnNumber = execution.turnNumbers[index]
      results.push(rule.effect(execution.state, context))
    }
    return { results, ...snapshot(execution.state, execution.extras) }
  } finally {
    clearRuleCache()
    if (oldRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = oldRoot
    rmSync(root, { recursive: true, force: true })
  }
}

function expectEquivalent(id: string, build: Build): any {
  const semantic = execute(id, true, build)
  const legacy = execute(id, false, build)
  expect(semantic, id).toEqual(legacy)
  return semantic
}

function damageContext(rulePiece: any, sourcePiece: any, targetPiece: any, damage: number, extra: Record<string, any> = {}): any {
  return { type: extra.type || 'afterDamageDealt', rulePiece, sourcePiece, targetPiece, damage, ...extra }
}

describe('counter/passive semantic rule graphs', () => {
  it('preserves momentum distance, zero movement, and missing ownership references', () => {
    const build = (variant: 'active' | 'zero' | 'wrong-source' | 'missing-core'): Build => () => {
      const holder = testPiece({ instanceId: 'momentum-holder', ownerPlayerId: 'player-red', name: '动能棋子' })
      holder.statusTags = variant === 'missing-core' ? [] : [{ id: 'momentum-core', type: 'momentum-core', stacks: 1 }]
      const other = testPiece({ instanceId: 'other', ownerPlayerId: 'player-blue', name: '敌方' })
      const state: any = makeState({ pieces: [holder, other], turnNumber: 2 })
      state.actions = variant === 'zero'
        ? [{ type: 'move', payload: { pieceId: holder.instanceId, path: [] } }]
        : [{ type: 'move', payload: {
          pieceId: holder.instanceId,
          path: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
        } }]
      return { state, contexts: [{ type: 'afterMove', rulePiece: holder, sourcePiece: variant === 'wrong-source' ? other : holder }] }
    }
    for (const variant of ['active', 'zero', 'wrong-source', 'missing-core'] as const) expectEquivalent('rule-momentum-gain', build(variant))
    expect(execute('rule-momentum-gain', true, build('active')).results[0]).toMatchObject({ success: true })
  })
  it('updates the exact no-id momentum status instance', () => {
    const build: Build = () => {
      const holder = testPiece({ instanceId: 'momentum-no-id', ownerPlayerId: 'player-red', name: '无标识动能棋子' })
      holder.statusTags = [{ type: 'momentum-core', stacks: 1 }, { type: 'momentum-core', stacks: 8 }]
      const other = testPiece({ instanceId: 'other', ownerPlayerId: 'player-blue', name: '敌方' })
      const state: any = makeState({ pieces: [holder, other], turnNumber: 2 })
      state.actions = [{ type: 'move', payload: { pieceId: holder.instanceId, path: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }] } }]
      return { state, contexts: [{ type: 'afterMove', rulePiece: holder, sourcePiece: holder }] }
    }
    const result = expectEquivalent('rule-momentum-gain', build)
    const statuses = result.state.pieces.find((piece: any) => piece.instanceId === 'momentum-no-id').statusTags
    expect(statuses).toEqual([{ type: 'momentum-core', stacks: 4 }, { type: 'momentum-core', stacks: 8 }])
  })

  it('uses the most recent matching move when opposite-direction moves coexist', () => {
    const build = () => {
      const holder = testPiece({ instanceId: 'momentum-holder', ownerPlayerId: 'player-red', name: '动能棋子' })
      holder.statusTags = [{ id: 'momentum-core', type: 'momentum-core', stacks: 1 }]
      const other = testPiece({ instanceId: 'other', ownerPlayerId: 'player-blue', name: '敌方' })
      const state: any = makeState({ pieces: [holder, other], turnNumber: 2 })
      state.actions = [
        { type: 'move', payload: { pieceId: holder.instanceId, path: [{ x: 1, y: 0 }, { x: 2, y: 0 }] } },
        { type: 'move', payload: {
          pieceId: holder.instanceId,
          // The latest action takes a four-cell detour even though its
          // endpoints are only two cells apart; path length is authoritative.
          path: [{ x: 3, y: 0 }, { x: 3, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 0 }],
        } },
      ]
      return { state, contexts: [{ type: 'afterMove', rulePiece: holder, sourcePiece: holder }] }
    }
    const result = expectEquivalent('rule-momentum-gain', build)
    expect(result.results[0]).toMatchObject({ success: true, message: '动能棋子获得4点动能（5）' })
    expect(result.state.pieces.find((piece: any) => piece.instanceId === 'momentum-holder').statusTags[0].stacks).toBe(5)
  })

  it('preserves Mortis fractional counters and repeated unlock attempts', () => {
    const build = (): Execution => {
      const holder = testPiece({ instanceId: 'mortis', ownerPlayerId: 'player-red', name: '莫提斯' })
      const target = testPiece({ instanceId: 'victim', ownerPlayerId: 'player-blue', name: '目标' })
      const state: any = makeState({ pieces: [holder, target] })
      holder.rules = []
      return {
        state,
        contexts: [
          damageContext(holder, holder, target, 0),
          damageContext(holder, holder, target, 0.5),
          damageContext(holder, holder, target, 2.5),
          damageContext(holder, holder, target, 3),
        ],
      }
    }
    expectEquivalent('rule-mortis-damage-counter', build)
  })

  it('preserves El Primo player counters, fractional damage, and capped discounts', () => {
    const build = (): Execution => {
      const holder = testPiece({ instanceId: 'el-primo', ownerPlayerId: 'player-red', name: '艾尔·普里莫' })
      const target = testPiece({ instanceId: 'attacker', ownerPlayerId: 'player-blue', name: '攻击者' })
      const state: any = makeState({ pieces: [holder, target] })
      return {
        state,
        contexts: [
          damageContext(holder, holder, target, 0, { type: 'afterDamageTaken' }),
          damageContext(holder, holder, target, 3.5, { type: 'afterDamageTaken' }),
          damageContext(holder, holder, target, 0.5, { type: 'afterDamageTaken' }),
          damageContext(holder, holder, target, 12, { type: 'afterDamageTaken' }),
        ],
      }
    }
    expectEquivalent('rule-el-primo-injury-counter', build)
  })

  it('preserves Grimmjow self damage queue filtering and fractional zero guards', () => {
    const build = (): Execution => {
      const holder = testPiece({ instanceId: 'grimmjow', ownerPlayerId: 'player-red', name: '格里姆乔' })
      const target = testPiece({ instanceId: 'target', ownerPlayerId: 'player-blue', name: '目标' })
      const requests: any[] = []
      const state: any = makeState({ pieces: [holder, target] })
      const queue = { push: (value: any) => { requests.push(value); return true } }
      return {
        state,
        extras: { requests },
        contexts: [
          damageContext(holder, holder, target, 0, { damageQueue: queue }),
          damageContext(holder, holder, target, 1.5, { damageQueue: queue, skillId: 'ordinary-skill' }),
          damageContext(holder, holder, target, 1, { damageQueue: queue, skillId: 'grimmjow-destruction-instinct' }),
        ],
      }
    }
    const result = expectEquivalent('rule-grimmjow-destruction-instinct', build)
    expect(result.extras.requests).toHaveLength(1)
  })

  it('preserves Ulquiorra progress, regeneration queues, and self target filtering', () => {
    const build = (): Execution => {
      const holder = testPiece({ instanceId: 'ulquiorra', ownerPlayerId: 'player-red', name: '乌尔奇奥拉', currentHp: 8, maxHp: 10 })
      const target = testPiece({ instanceId: 'target', ownerPlayerId: 'player-blue', name: '目标' })
      const heals: any[] = []
      const state: any = makeState({ pieces: [holder, target] })
      const queue = { push: (value: any) => { heals.push(value); return true } }
      return {
        state,
        extras: { heals },
        contexts: [
          damageContext(holder, holder, target, 0.5, { healQueue: queue }),
          damageContext(holder, holder, target, 1, { healQueue: queue }),
          damageContext(holder, holder, holder, 1, { type: 'afterDamageTaken', healQueue: queue }),
        ],
      }
    }
    const dealt = expectEquivalent('rule-ulquiorra-damage-dealt', build)
    expect(dealt.extras.heals).toHaveLength(3)
    expectEquivalent('rule-ulquiorra-damage-taken', build)
  })

  it('preserves Akaza marker ownership, refresh, and invalid target behavior', () => {
    const build = (): Execution => {
      const holder = testPiece({ instanceId: 'akaza', ownerPlayerId: 'player-red', name: '猗窝座' })
      const target = testPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', name: '敌人' })
      const ally = testPiece({ instanceId: 'ally', ownerPlayerId: 'player-red', name: '友军' })
      const state: any = makeState({ pieces: [holder, target, ally], turnNumber: 3 })
      return {
        state,
        contexts: [
          damageContext(holder, holder, target, 1),
          damageContext(holder, holder, target, 0.5),
          damageContext(holder, holder, ally, 1),
        ],
      }
    }
    expectEquivalent('rule-akaza-damage-mark', build)
  })

  it('preserves Akaza first strike fractional damage and full-health guards', () => {
    const build = (): Execution => {
      const holder = testPiece({ instanceId: 'akaza', ownerPlayerId: 'player-red', name: '猗窝座' })
      const victim = testPiece({ instanceId: 'victim', ownerPlayerId: 'player-blue', name: '满血目标', currentHp: 10, maxHp: 10 })
      const state: any = makeState({ pieces: [holder, victim] })
      const contexts = [
        damageContext(holder, victim, holder, 1.5, { type: 'beforeDamageTaken' }),
        damageContext(holder, victim, holder, 0, { type: 'beforeDamageTaken' }),
      ]
      return { state, contexts }
    }
    const result = expectEquivalent('rule-akaza-fighting-spirit', build)
    expect(result.results[0]).toMatchObject({ success: true })
  })

  it('recognizes only the exact frozen author graphs after receiver normalization', () => {
    for (const id of ['rule-momentum-gain', 'rule-akaza-damage-mark', 'rule-akaza-fighting-spirit'] as const) {
      const original = fixture[`rules/${id}`]
      const current = applyContentGraph(original, importContentGraph(original.skillCode, 'rule'), 'skillCode')
      expect(() => assertCounterPassiveAuthorGraph(current, original, id)).not.toThrow()
      current.skillCode += '\n'
      expect(() => assertCounterPassiveAuthorGraph(current, original, id)).toThrow()
    }
  })

  it('rejects a valid executable graph that snapshots a mutable temporary before later writes', () => {
    const id = 'rule-akaza-damage-mark', original = fixture[`rules/${id}`]
    const graph: any = importContentGraph(original.skillCode, 'rule')
    const initialization = graph.nodes.find((node: any) => node.kind === 'bind' && node.name === '__rvb_import_value_0')
    expect(initialization).toBeTruthy()
    const replaceReads = (value: any): void => {
      if (!value || typeof value !== 'object') return
      if (value.kind === 'ref' && value.name === '__rvb_import_value_0') value.name = 'snapshotValue'
      for (const [key, child] of Object.entries(value)) {
        if (value.kind === 'set' && key === 'target') continue
        replaceReads(child)
      }
    }
    for (const node of graph.nodes) replaceReads(node)
    const alias = { kind: 'bind', id: 'snapshot-alias', name: 'snapshotValue', expr: { kind: 'ref', name: '__rvb_import_value_0' }, next: initialization.next }
    initialization.next = alias.id
    graph.nodes.push(alias)
    const tampered = applyContentGraph(original, graph, 'skillCode')
    expect(tampered.skillCode).toContain('snapshotValue')
    expect(() => assertCounterPassiveAuthorGraph(tampered, original, id)).toThrow(/not the exact frozen importer graph/)
  })

  it('preserves Obito allied accumulation, cap messages, and repeated state updates', () => {
    const build = (): Execution => {
      const holder = testPiece({ instanceId: 'obito', ownerPlayerId: 'player-red', name: '带土', attack: 10 })
      const ally = testPiece({ instanceId: 'ally', ownerPlayerId: 'player-red', name: '友方' })
      const enemy = testPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', name: '敌方' })
      const state: any = makeState({ pieces: [holder, ally, enemy] })
      return {
        state,
        contexts: [
          damageContext(holder, ally, enemy, 1, { type: 'afterDamageTaken' }),
          damageContext(holder, holder, enemy, 1, { type: 'afterDamageTaken' }),
          damageContext(holder, ally, enemy, 1, { type: 'afterDamageTaken' }),
          damageContext(holder, ally, enemy, 1, { type: 'afterDamageTaken' }),
        ],
      }
    }
    expectEquivalent('rule-obito-grudge', build)
  })

  it('preserves Shishio kill count and target naming over repeated kills', () => {
    const build = (): Execution => {
      const holder = testPiece({ instanceId: 'shishio', ownerPlayerId: 'player-red', name: '志志雄' })
      const first = testPiece({ instanceId: 'enemy-1', ownerPlayerId: 'player-blue', name: '敌人一' })
      const second = testPiece({ instanceId: 'enemy-2', ownerPlayerId: 'player-blue', name: '敌人二' })
      const state: any = makeState({ pieces: [holder, first, second] })
      return { state, contexts: [
        damageContext(holder, holder, first, 0, { type: 'afterPieceKilled' }),
        damageContext(holder, holder, second, 0, { type: 'afterPieceKilled' }),
      ] }
    }
    expectEquivalent('rule-shishio-kill-track', build)
  })

  it('preserves Shishio once-per-turn cooldown marking, dead targets, and skill lists', () => {
    const build = (): Execution => {
      const holder = testPiece({ instanceId: 'shishio', ownerPlayerId: 'player-red', name: '志志雄' })
      const target = testPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', name: '敌人', skills: [{ skillId: 'skill-a', currentCooldown: 0 }, { skillId: 'skill-b', currentCooldown: 2 }] as any })
      const state: any = makeState({ pieces: [holder, target], turnNumber: 4 })
      const contexts = [damageContext(holder, holder, target, 1, { type: 'beforeDamageDealt' }), damageContext(holder, holder, target, 1, { type: 'beforeDamageDealt' }), damageContext(holder, holder, target, 1, { type: 'beforeDamageDealt' })]
      return { state, contexts, turnNumbers: [4, 4, 5] }
    }
    expectEquivalent('rule-shishio-cooldown-once', build)
  })

  it('preserves Muzan damage records, action history, fractional damage, and once-per-turn healing', () => {
    const damageBuild = (): Execution => {
      const holder = testPiece({ instanceId: 'muzan', ownerPlayerId: 'player-red', name: '鬼舞辻无惨', currentHp: 8, maxHp: 10 })
      const other = testPiece({ instanceId: 'other', ownerPlayerId: 'player-blue', name: '其他棋子' })
      const state: any = makeState({ pieces: [holder, other], turnNumber: 2 })
      return {
        state,
        contexts: [
          damageContext(holder, holder, holder, 0, { type: 'afterDamageTaken' }),
          damageContext(holder, holder, holder, 0.75, { type: 'afterDamageTaken' }),
          damageContext(holder, other, holder, 3, { type: 'afterDamageTaken' }),
          damageContext(holder, holder, holder, 1.5, { type: 'afterDamageTaken' }),
          { type: 'afterDamageTaken', rulePiece: undefined, sourcePiece: holder, damage: 2 },
        ],
        turnNumbers: [2, 2, 2, 2, Number.NaN],
      }
    }
    expectEquivalent('rule-muzan-regeneration-damage', damageBuild)

    const endBuild = (): Execution => {
      const holder = testPiece({ instanceId: 'muzan', ownerPlayerId: 'player-red', name: '鬼舞辻无惨', currentHp: 7, maxHp: 10 })
      const other = testPiece({ instanceId: 'other', ownerPlayerId: 'player-blue', name: '其他棋子' })
      const state: any = makeState({ pieces: [holder, other], turnNumber: 1 })
      state.actions = [
        { type: 'damage', turn: 2, payload: { targetId: holder.instanceId, finalDamage: 0.25 } },
        { type: 'damage', turn: 2, payload: { targetId: other.instanceId, finalDamage: 5 } },
        { type: 'damage', turn: 2, payload: { targetId: holder.instanceId, finalDamage: 0 } },
      ]
      state.extensions = {
        flowState: [{
          schemaVersion: 1,
          scope: 'piece',
          entityId: holder.instanceId,
          ownerPlayerId: holder.ownerPlayerId,
          namespace: 'muzan-flesh-regeneration',
          name: 'lastDamageTurn',
          value: 3,
          lifetime: 'battle',
          projectionVisibility: 'owner',
        }],
      }
      return {
        state,
        contexts: [
          { type: 'endTurn', rulePiece: holder },
          { type: 'endTurn', rulePiece: holder },
          { type: 'endTurn', rulePiece: holder },
          { type: 'endTurn', rulePiece: holder },
          { type: 'endTurn', rulePiece: holder },
          { type: 'endTurn', rulePiece: holder },
        ],
        turnNumbers: [1, 1, 2, 3, 4, 4],
      }
    }
    const result = expectEquivalent('rule-muzan-regeneration-end', endBuild)
    expect(result.results.filter((entry: any) => entry.success)).toHaveLength(2)
    expect(result.results[0].message).toContain('恢复2点生命')
    expect(result.results[4].message).toContain('恢复1点生命')
  })
})

