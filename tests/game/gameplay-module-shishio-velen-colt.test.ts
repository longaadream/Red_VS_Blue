/* eslint-disable @typescript-eslint/no-explicit-any -- frozen host differential fixtures. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph, compileGameplayModuleGraph, GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-document'
import { clearRuleCache, loadRuleById } from '@/lib/game/skills'
import { buildShishioVelenColtGraph, SHISHIO_VELEN_COLT_RULE_IDS } from '@/scripts/migrate-semantic-shishio-velen-colt'
import { makePiece, makeState } from '../helpers/minimal-state'

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, any>

type Execution = { state: any; contexts: any[]; extras?: Record<string, any> }
type Build = () => Execution

function testPiece(options: Record<string, any> = {}): any {
  const { name = options.instanceId || '测试棋子', defense = 4, ...pieceOptions } = options
  const piece: any = makePiece(pieceOptions)
  // makePiece deliberately leaves these fixture-controlled fields canonical.
  piece.name = name
  piece.defense = defense
  return piece
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function snapshot(state: any, extras: Record<string, any> | undefined): any {
  const plain = clone(state)
  return { state: plain, extras: clone(extras ?? {}) }
}

function installFixtureRules(root: string): void {
  const rulesRoot = join(root, 'data/rules')
  mkdirSync(rulesRoot, { recursive: true })
  for (const [key, document] of Object.entries(fixture)) {
    if (!key.startsWith('rules/')) continue
    writeFileSync(join(rulesRoot, key.slice('rules/'.length) + '.json'), JSON.stringify(document))
  }
}

function execute(id: string, semantic: boolean, build: Build): any {
  const root = mkdtempSync(join(tmpdir(), 'rvb-shishio-velen-colt-'))
  const previousRoot = process.env.RVB_PROFILE_ROOT
  try {
    process.env.RVB_PROFILE_ROOT = root
    installFixtureRules(root)
    const source = fixture['rules/' + id]
    const document = semantic ? applyGameplayModuleGraph(source, buildShishioVelenColtGraph(id), 'skillCode') : source
    writeFileSync(join(root, 'data/rules', id + '.json'), JSON.stringify(document))
    clearRuleCache()
    const rule = loadRuleById(id, true, true)
    if (!rule) throw new Error(`rule ${id} did not load`)
    const execution = build()
    const results = execution.contexts.map(context => rule.effect(execution.state, context))
    return { results: clone(results), ...snapshot(execution.state, execution.extras) }
  } finally {
    clearRuleCache()
    if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
}

function expectEquivalent(id: string, build: Build): any {
  const semantic = execute(id, true, build)
  const legacy = execute(id, false, build)
  expect(semantic, id).toEqual(legacy)
  return semantic
}

function shishioPieces(): { shishio: any; target: any } {
  return {
    shishio: testPiece({ instanceId: 'shishio', templateId: 'red-shishio', ownerPlayerId: 'player-red', name: '志志雄真实', x: 0, y: 0, currentHp: 100, attack: 7 }),
    target: testPiece({ instanceId: 'target', templateId: 'target', ownerPlayerId: 'player-blue', name: '目标', x: 1, y: 0, currentHp: 9, maxHp: 20 }),
  }
}

describe('Shishio/Velen/Colt semantic rule graphs', () => {
  it('registers all bounded graphs through the central typed registry', () => {
    for (const id of SHISHIO_VELEN_COLT_RULE_IDS) {
      const graph = buildShishioVelenColtGraph(id)
      expect(() => compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY), id).not.toThrow()
      expect(graph).not.toHaveProperty('code')
      const document = applyGameplayModuleGraph(fixture['rules/' + id], graph, 'skillCode')
      expect(document.contentGraph).toBeUndefined()
      expect((document.gameplayModules as any)?.entries?.skillCode?.graph).toEqual(graph)
    }
  })

  it('preserves momentum consumption and reset', () => {
    const result = expectEquivalent('rule-momentum-consume', () => {
      const holder = testPiece({ instanceId: 'momentum-holder', ownerPlayerId: 'player-red', name: '动能棋子', momentum: 2, statusTags: [{ id: 'momentum', type: 'momentum-core', stacks: 2, skillIds: ['ordinary'] }] })
      const state: any = makeState({ pieces: [holder] })
      state.skillsById.ordinary = { id: 'ordinary', momentumGainOnUse: false }
      return { state, contexts: [{ type: 'afterSkillUsed', rulePiece: holder, sourcePiece: holder, skillId: 'ordinary' }] }
    })
    expect(result.results[0]).toMatchObject({ success: true })
    expect(result.state.pieces[0].statusTags[0].stacks).toBe(0)
  })

  it('consumes the exact no-id momentum status instance', () => {
    const result = execute('rule-momentum-consume', true, () => {
      const holder = testPiece({ instanceId: 'momentum-no-id', ownerPlayerId: 'player-red', name: '无标识动能棋子', momentum: 2, statusTags: [
        { type: 'momentum-core', stacks: 2, skillIds: ['ordinary'] },
        { type: 'momentum-core', stacks: 9, skillIds: ['other'] },
      ] })
      const state: any = makeState({ pieces: [holder] })
      state.skillsById.ordinary = { id: 'ordinary', momentumGainOnUse: false }
      return { state, contexts: [{ type: 'afterSkillUsed', rulePiece: holder, sourcePiece: holder, skillId: 'ordinary' }] }
    })
    expect(result.results[0]).toMatchObject({ success: true })
    expect(result.state.pieces[0].statusTags).toEqual([
      { type: 'momentum-core', stacks: 0, skillIds: ['ordinary'] },
      { type: 'momentum-core', stacks: 9, skillIds: ['other'] },
    ])
  })

  it('preserves burn damage on turn end and movement entry', () => {
    expectEquivalent('rule-shishio-burn-endturn', () => {
      const { shishio, target } = shishioPieces()
      const state: any = makeState({ pieces: [shishio, target] })
      state.extensions.shishioBurnTiles = [{ x: target.x, y: target.y, sourcePieceId: shishio.instanceId }]
      return { state, contexts: [{ type: 'endTurn', playerId: 'player-red', triggerPlayerId: 'player-blue', rulePiece: shishio }] }
    })
    const result = expectEquivalent('rule-shishio-burn-move', () => {
      const { shishio, target } = shishioPieces()
      const state: any = makeState({ pieces: [shishio, target] })
      state.extensions.shishioBurnTiles = [{ x: target.x, y: target.y, sourcePieceId: shishio.instanceId }]
      return { state, contexts: [{ type: 'afterPiecePositionChange', playerId: 'player-red', triggerPlayerId: 'player-blue', rulePiece: shishio, sourcePiece: target }] }
    })
    expect(result.results[0]).toMatchObject({ success: true })
  })

  it('preserves combustion counter arithmetic and queued self damage', () => {
    const result = expectEquivalent('rule-shishio-combustion', () => {
      const { shishio, target } = shishioPieces()
      const requests: any[] = []
      const state: any = makeState({ pieces: [shishio, target] })
      return {
        state,
        extras: { requests },
        contexts: [{ type: 'afterDamageDealt', rulePiece: shishio, sourcePiece: shishio, targetPiece: target, damage: 5, damageQueue: { push: (request: any) => { requests.push(request); return true } } }],
      }
    })
    expect(result.results[0]).toMatchObject({ success: true })
    expect(result.extras.requests).toHaveLength(1)
    expect(result.state.pieces[0].statusTags).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'shishio-dmg-counter', intensity: 0 })]))
  })

  it('preserves execute guard and avoids offering an overkill choice for lethal damage below threshold', () => {
    expectEquivalent('rule-shishio-execute-option', () => {
      const { shishio, target } = shishioPieces()
      const state: any = makeState({ pieces: [shishio, target] })
      return { state, contexts: [{ type: 'beforeDamageDealt', rulePiece: shishio, sourcePiece: shishio, targetPiece: target, damage: target.currentHp }] }
    })
  })

  it('preserves infinite blade target selection failure when no enemy is nearby', () => {
    expectEquivalent('rule-shishio-infinite-blade-recast', () => {
      const shishio = testPiece({ instanceId: 'shishio', templateId: 'red-shishio', ownerPlayerId: 'player-red', name: '志志雄真实', x: 0, y: 0 })
      const state: any = makeState({ pieces: [shishio] })
      return { state, contexts: [{ type: 'afterSkillUsed', rulePiece: shishio, sourcePiece: shishio, skillId: 'shishio-infinite-blade' }] }
    })
  })

  it('preserves silence burst status and rule application', () => {
    const result = expectEquivalent('rule-shishio-silence-burst', () => {
      const { shishio, target } = shishioPieces()
      const state: any = makeState({ pieces: [shishio, target] })
      return { state, contexts: [{ type: 'afterDamageDealt', rulePiece: shishio, sourcePiece: shishio, targetPiece: target, damage: 8 }] }
    })
    expect(result.results[0]).toMatchObject({ success: true })
    expect(result.state.pieces[1].statusTags).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'silenced', currentDuration: 1 })]))
  })

  it('preserves Velen death cleanup across hand, battlefield, and graveyard', () => {
    const result = expectEquivalent('rule-velen-death-cleanup', () => {
      const velen = testPiece({ instanceId: 'velen', templateId: 'velen', ownerPlayerId: 'player-red', name: '维伦', currentHp: 0 })
      const ally = testPiece({ instanceId: 'ally', ownerPlayerId: 'player-red', statusTags: [{ id: 'shelter', type: 'velen-fate-shelter', sourceId: velen.instanceId }], rules: [{ id: 'rule-velen-fate-target' }] })
      const grave = testPiece({ instanceId: 'grave', ownerPlayerId: 'player-blue', statusTags: [{ id: 'grave-shelter', type: 'velen-fate-shelter', sourceId: velen.instanceId }], rules: [{ id: 'rule-velen-fate-target' }] })
      const other = testPiece({ instanceId: 'other-source-shelter', ownerPlayerId: 'player-red', statusTags: [{ id: 'other-shelter', type: 'velen-fate-shelter', sourceId: 'other-velen' }], rules: [{ id: 'rule-velen-fate-target' }] })
      const state: any = makeState({ pieces: [velen, ally, other] })
      state.graveyard = [grave]
      state.players[0].hand = [{ instanceId: 'prophecy-1', cardId: 'holy-smite', contentState: { velenHolyProphecy: { sourcePieceId: velen.instanceId, createdTurnNumber: 1 } } }]
      return { state, contexts: [{ type: 'onPieceDied', rulePiece: velen, sourcePiece: velen, playerId: 'player-red' }] }
    })
    expect(result.results[0]).toMatchObject({ success: true })
    expect(result.state.players[0].hand[0].contentState.velenHolyProphecy).toBeUndefined()
    expect(result.state.graveyard[0].statusTags).toEqual([])
    expect(result.state.pieces[2].rules).toEqual([{ id: 'rule-velen-fate-target' }])
  })

  it('preserves Velen delayed prophecy enhancement', () => {
    const result = expectEquivalent('rule-velen-delayed-effects', () => {
      const velen = testPiece({ instanceId: 'velen', templateId: 'velen', ownerPlayerId: 'player-red', name: '维伦' })
      const state: any = makeState({ pieces: [velen], turnNumber: 2 })
      state.players[0].hand = [
        { instanceId: 'prophecy-smite', cardId: 'holy-smite', contentState: { velenHolyProphecy: { sourcePieceId: velen.instanceId, createdTurnNumber: 1 } } },
        { instanceId: 'prophecy-heal', cardId: 'holy-heal', contentState: { velenHolyProphecy: { sourcePieceId: velen.instanceId, createdTurnNumber: 1 } } },
        { instanceId: 'prophecy-charge', cardId: 'holy-charge', contentState: { velenHolyProphecy: { sourcePieceId: velen.instanceId, createdTurnNumber: 1 } } },
      ]
      return { state, contexts: [{ type: 'endTurn', rulePiece: velen, playerId: 'player-red' }] }
    })
    expect(result.results[0]).toMatchObject({ success: true })
    expect(result.state.players[0].hand).toEqual(expect.arrayContaining([
      expect.objectContaining({ cardId: 'holy-smite', contentState: { velenHolyProphecyEnhanced: true }, effectModifiers: [{ effect: 'damage', operation: 'multiply', value: 1.5 }] }),
      expect.objectContaining({ cardId: 'holy-heal', contentState: { velenHolyProphecyEnhanced: true }, effectModifiers: [{ effect: 'heal', operation: 'multiply', value: 1.5 }] }),
      expect.objectContaining({ cardId: 'holy-charge', contentState: { velenHolyProphecyEnhanced: true }, effectModifiers: [{ effect: 'statusIntensity', operation: 'multiply', value: 1.5, statusType: 'damage-buff' }] }),
    ]))

    const sheltered = expectEquivalent('rule-velen-delayed-effects', () => {
      const velen = testPiece({ instanceId: 'velen', templateId: 'velen', ownerPlayerId: 'player-red', name: '维伦' })
      const ally = testPiece({ instanceId: 'ally', ownerPlayerId: 'player-red', name: '受庇护友军', currentHp: 40, maxHp: 100, statusTags: [{ id: 'shelter', type: 'velen-fate-shelter', sourceId: velen.instanceId, createdTurnNumber: 1 }], rules: [{ id: 'rule-velen-fate-target' }] })
      const state: any = makeState({ pieces: [velen, ally], turnNumber: 2 })
      return { state, contexts: [{ type: 'endTurn', rulePiece: velen, playerId: 'player-red' }] }
    })
    expect(sheltered.results[0]).toMatchObject({ success: true })
    expect(sheltered.state.pieces[1].statusTags).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'divine-shield' })]))
  })

  it('keeps prophecy records whose creation turn is missing', () => {
    const result = expectEquivalent('rule-velen-delayed-effects', () => {
      const velen = testPiece({ instanceId: 'velen', templateId: 'velen', ownerPlayerId: 'player-red', name: '维伦' })
      const state: any = makeState({ pieces: [velen], turnNumber: 2 })
      state.players[0].hand = [{ instanceId: 'prophecy-missing-turn', cardId: 'holy-smite', contentState: { velenHolyProphecy: { sourcePieceId: velen.instanceId } } }]
      return { state, contexts: [{ type: 'endTurn', rulePiece: velen, playerId: 'player-red' }] }
    })
    expect(result.results[0]).toMatchObject({ success: true })
    expect(result.state.players[0].hand[0]).toMatchObject({
      contentState: { velenHolyProphecyEnhanced: true },
      effectModifiers: [{ effect: 'damage', operation: 'multiply', value: 1.5 }],
    })
  })

  it('preserves Velen fate target cleanup and no-op behavior', () => {
    const result = expectEquivalent('rule-velen-fate-target', () => {
      const velen = testPiece({ instanceId: 'velen', templateId: 'velen', ownerPlayerId: 'player-red', name: '目标', statusTags: [{ id: 'shelter', type: 'velen-fate-shelter' }], rules: [{ id: 'rule-velen-fate-target' }] })
      const state: any = makeState({ pieces: [velen] })
      return { state, contexts: [{ type: 'onPieceDied', rulePiece: velen, sourcePiece: velen, playerId: 'player-red' }] }
    })
    expect(result.results[0]).toMatchObject({ success: true })
    expect(result.state.pieces[0].statusTags).toEqual([])
  })

  it('preserves Colt free movement with an explicit destination', () => {
    const result = expectEquivalent('rule-colt-big-stride', () => {
      const colt = testPiece({ instanceId: 'colt', templateId: 'colt', ownerPlayerId: 'player-red', name: '柯尔特', x: 0, y: 0 })
      const state: any = makeState({ pieces: [colt] })
      return { state, contexts: [{ type: 'endTurn', rulePiece: colt, playerId: 'player-blue', selectedTargets: [{ type: 'cell', x: 1, y: 0 }] }] }
    })
    expect(result.results[0]).toMatchObject({ success: true })
    expect(result.state.pieces[0]).toMatchObject({ x: 1, y: 0 })
  })

  it('preserves Colt revolver zone damage and expiry', () => {
    const result = expectEquivalent('rule-colt-zone-endturn', () => {
      const holder = testPiece({ instanceId: 'holder', templateId: 'colt', ownerPlayerId: 'player-red', name: '柯尔特', x: 0, y: 0 })
      const source = testPiece({ instanceId: 'source', templateId: 'colt', ownerPlayerId: 'player-red', name: '射手', x: 0, y: 0, attack: 4, statusTags: [{ id: 'colt-zone-source', type: 'colt-zone', stacks: 1, intensity: 1 }] })
      const target = testPiece({ instanceId: 'target', ownerPlayerId: 'player-blue', name: '敌军', x: 2, y: 0, currentHp: 10 })
      const state: any = makeState({ pieces: [holder, source, target] })
      state.extensions.coltZones = { [holder.instanceId]: { sourceId: source.instanceId, kind: 'revolver', dx: 1, dy: 0, turns: 1 } }
      return { state, contexts: [{ type: 'endTurn', rulePiece: holder }] }
    })
    expect(result.results[0]).toMatchObject({ success: true })
    expect(result.state.pieces[2].currentHp).toBeLessThan(10)
    expect(result.state.extensions.coltZones).toEqual({})
  })

  it('preserves Colt storm distance order over battle array order', () => {
    const result = expectEquivalent('rule-colt-zone-endturn', () => {
      const colt = testPiece({ instanceId: 'colt', templateId: 'colt', ownerPlayerId: 'player-red', name: '柯尔特', x: 0, y: 0, attack: 4 })
      const far = testPiece({ instanceId: 'far', ownerPlayerId: 'player-blue', name: '远方敌军', x: 3, y: 0, currentHp: 10 })
      const near = testPiece({ instanceId: 'near', ownerPlayerId: 'player-blue', name: '近处敌军', x: 1, y: 0, currentHp: 10 })
      const state: any = makeState({ pieces: [colt, far, near] })
      state.extensions.coltZones = { [colt.instanceId]: { sourceId: colt.instanceId, kind: 'storm', dx: 1, dy: 0, turns: 1 } }
      return { state, contexts: [{ type: 'endTurn', rulePiece: colt }] }
    })
    const damageTargets = result.state.actions
      .filter((action: any) => action.type === 'damage')
      .map((action: any) => action.payload?.targetId)
    expect(damageTargets).toEqual(['near', 'far'])
  })

  it.each([
    { name: 'expired', zone: { kind: 'revolver', dx: 1, dy: 0, turns: 0 } },
    { name: 'unknown kind', zone: { kind: 'laser', dx: 1, dy: 0, turns: 1 } },
    { name: 'fractional direction', zone: { kind: 'storm', dx: 0.5, dy: 1, turns: 1 } },
  ])('keeps Colt zone state unchanged on $name invalid shape', ({ zone }) => {
    const result = expectEquivalent('rule-colt-zone-endturn', () => {
      const holder = testPiece({ instanceId: 'holder', templateId: 'colt', ownerPlayerId: 'player-red', name: '柯尔特', x: 0, y: 0 })
      const source = testPiece({ instanceId: 'source', templateId: 'colt', ownerPlayerId: 'player-red', name: '射手', x: 0, y: 0, statusTags: [{ id: 'colt-zone-source', type: 'colt-zone', stacks: 1, intensity: 1 }] })
      const state: any = makeState({ pieces: [holder, source] })
      state.extensions.coltZones = { [holder.instanceId]: { sourceId: source.instanceId, ...zone } }
      return { state, contexts: [{ type: 'endTurn', rulePiece: holder }] }
    })
    expect(result.results[0]).toEqual({ success: false, message: '' })
    expect(result.state.extensions.coltZones).toEqual({ holder: { sourceId: 'source', ...zone } })
    expect(result.state.pieces[1].statusTags).toEqual([{ id: 'colt-zone-source', type: 'colt-zone', stacks: 1, intensity: 1 }])
  })
})
