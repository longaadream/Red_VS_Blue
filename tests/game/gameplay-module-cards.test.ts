/* eslint-disable @typescript-eslint/no-explicit-any -- frozen card fixtures intentionally retain host-shaped state. */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  compileGameplayModuleGraph,
} from '@/lib/skill-graph/module-document'
import { GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-registry'
import {
  buildSemanticCardGraph,
  SEMANTIC_CARD_IDS,
} from '@/scripts/migrate-semantic-cards'
import {
  executeCardFunction,
  loadCardById,
  type CardDefinition,
} from '@/lib/game/skills'
import { getRng, setRng } from '@/lib/game/rng'
import { makePiece, makeState } from '../helpers/minimal-state'

type JsonRecord = Record<string, any>
type Fixture = { entries: Record<string, JsonRecord> }

const fixture = JSON.parse(
  readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8'),
) as Fixture

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function snapshot(value: unknown): unknown {
  if (typeof value === 'function') return { functionSource: String(value) }
  if (Array.isArray(value)) return value.map(snapshot)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, snapshot(nested)]))
  }
  return value
}

function behavior(result: unknown, state: any): unknown {
  const stateCopy = { ...state }
  delete stateCopy.skillsById
  delete stateCopy.cardsById
  return snapshot({ result, state: stateCopy })
}

function withFixedSeed<T>(fn: () => T, seed = 0x252): T {
  const previous = getRng()
  let state = seed >>> 0
  setRng(() => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  })
  try {
    return fn()
  } finally {
    setRng(previous)
  }
}

type Scenario = {
  pieces: any[]
  target?: any
  targetPosition?: { x: number; y: number }
  trigger?: any
  cardInstance?: any
  setup?: (state: any) => void
}

function cardPiece(overrides: Parameters<typeof makePiece>[0] = {}): ReturnType<typeof makePiece> {
  const piece = makePiece(overrides)
  if (Object.prototype.hasOwnProperty.call(overrides, 'name')) piece.name = overrides.name
  return piece
}

function scenarioFor(id: string): Scenario {
  const ally = cardPiece({ instanceId: 'ally-1', templateId: 'ally-template', ownerPlayerId: 'player-red', name: '友方棋子', currentHp: 34, maxHp: 100, attack: 7, x: 1, y: 1 })
  const enemy = cardPiece({ instanceId: 'enemy-1', templateId: 'enemy-template', ownerPlayerId: 'player-blue', name: '敌方棋子', currentHp: 24, maxHp: 100, attack: 8, x: 2, y: 1 })
  const watcher = cardPiece({ instanceId: 'watcher-1', templateId: 'blue-watcher', ownerPlayerId: 'player-red', name: '观察者', currentHp: 80, maxHp: 80, attack: 9, x: 1, y: 2 })
  const hashirama = cardPiece({ instanceId: 'hashirama-1', templateId: 'hashirama-edo', ownerPlayerId: 'player-red', name: '柱间', currentHp: 40, maxHp: 100, attack: 12, x: 1, y: 1 })
  const cardInstance: any = {
    cardId: id,
    instanceId: `card-instance-${id}`,
    ownerPlayerId: 'player-red',
    effectModifiers: [],
  }
  if (id.startsWith('hashirama-edo-')) cardInstance.boundPieceInstanceId = hashirama.instanceId
  const base: Scenario = { pieces: [ally, enemy, watcher, hashirama], target: ally, cardInstance }
  if (id.startsWith('demon-summon-') && id !== 'demon-summon-5') return base
  if (id === 'demon-summon-5') {
    return {
      ...base,
      target: ally,
      targetPosition: { x: 4, y: 3 },
      setup: state => {
        state.extensions.kiljaedanPiecesByPlayerId = {
          'player-red': {
            instanceId: 'kiljaedan-stored', templateId: 'kiljaedan', ownerPlayerId: 'player-red', name: '基尔加丹',
            faction: 'red', maxHp: 100, attack: 10, defense: 0, moveRange: 3,
          },
        }
      },
    }
  }
  if (id === 'hashirama-edo-nature-heal') return { ...base, target: undefined }
  if (id === 'hashirama-edo-thousand-hands') return { ...base, target: enemy }
  if (id === 'holy-charge') return { ...base, target: undefined }
  if (id === 'holy-heal') return { ...base, target: undefined }
  if (id === 'holy-smite') return { ...base, target: undefined }
  if (id === 'sample-reactive-card') {
    return { ...base, target: undefined, trigger: { sourcePiece: enemy, targetPiece: ally } }
  }
  if (id === 'soul-fragment') return { ...base, target: ally }
  if (id === 'watcher-calm') return { ...base, target: undefined }
  if (id === 'watcher-rage') return { ...base, target: enemy }
  return base
}

function run(
  definition: CardDefinition,
  id: string,
  selectionPending = false,
  customize?: (scenario: Scenario, state: any) => void,
): unknown {
  const scenario = scenarioFor(id)
  const state = makeState({ pieces: scenario.pieces })
  scenario.setup?.(state)
  customize?.(scenario, state)
  state.players[0].hand = [scenario.cardInstance]
  if (id.startsWith('holy-')) {
    ;(state.players[0] as any).buffs = { 'elune-blessing-buff': { uses: 1, multiplier: 1.5 } }
  }
  const target = selectionPending ? undefined : scenario.target
  const targetPosition = selectionPending ? undefined : scenario.targetPosition
  const extraTargets = targetPosition ? [{ x: targetPosition.x, y: targetPosition.y }] : []
  const result = executeCardFunction(
    definition,
    'player-red',
    state,
    scenario.trigger,
    target,
    targetPosition,
    undefined,
    extraTargets,
    scenario.cardInstance,
  )
  return behavior(result, state)
}

function semanticDefinition(id: string): CardDefinition {
  const source = clone(fixture.entries[`cards/${id}`])
  const document = applyGameplayModuleGraph(source, buildSemanticCardGraph(id as typeof SEMANTIC_CARD_IDS[number]))
  assertGameplayModuleDocument(document)
  return document as unknown as CardDefinition
}

function modulesIn(graph: any): string[] {
  const modules: string[] = []
  const visit = (body: readonly any[]) => {
    for (const node of body) {
      if (node.kind === 'call') modules.push(node.module)
      if (node.kind === 'if') {
        visit(node.then)
        visit(node.else ?? [])
      }
      if (node.kind === 'foreach') visit(node.body)
    }
  }
  visit(graph.body)
  return modules
}

describe('RED-252 ordinary card semantic migration', () => {
  it('compiles all fourteen graphs from the shared typed registry', () => {
    for (const id of SEMANTIC_CARD_IDS) {
      const graph = buildSemanticCardGraph(id)
      expect(graph.surface, id).toBe('card')
      expect(compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code, id).toContain('function executeCard')
    }
  })

  it('uses reusable typed operations instead of card-specific wrappers', () => {
    const modules = new Set(SEMANTIC_CARD_IDS.flatMap(id => modulesIn(buildSemanticCardGraph(id))))
    expect([...modules]).toEqual(expect.not.arrayContaining([...SEMANTIC_CARD_IDS]))
    expect([...modules]).toEqual(expect.arrayContaining([
      'effect.damage', 'effect.heal', 'query.affectable-pieces', 'query.lowest-hp',
      'status.find-id', 'status.read-number', 'status.set-number', 'status.remove-id',
      'source.capture', 'piece.captured-name', 'attribute.adjust-captured', 'lifecycle.summon-captured',
    ]))
  })

  it('matches the frozen legacy host result and state for one fixed seed scenario per card', () => {
    for (const id of SEMANTIC_CARD_IDS) {
      const legacy = fixture.entries[`cards/${id}`] as unknown as CardDefinition
      const semantic = semanticDefinition(id)
      expect(withFixedSeed(() => run(semantic, id)), id).toEqual(withFixedSeed(() => run(legacy, id)))
    }
  })

  it('loads every migrated production card and preserves the fixed-seed behavior', () => {
    for (const id of SEMANTIC_CARD_IDS) {
      const legacy = fixture.entries[`cards/${id}`] as unknown as CardDefinition
      const production = loadCardById(id, true, true)
      expect(production, id).toBeTruthy()
      expect(withFixedSeed(() => run(production!, id)), id).toEqual(withFixedSeed(() => run(legacy, id)))
    }
  })

  it('matches the frozen initial target-selection request for every target-choice card', () => {
    const targetChoiceCards = [
      'demon-summon-1', 'demon-summon-2', 'demon-summon-3', 'demon-summon-4', 'demon-summon-5',
      'hashirama-edo-thousand-hands', 'soul-fragment', 'watcher-rage',
    ] as const
    for (const id of targetChoiceCards) {
      const legacy = fixture.entries[`cards/${id}`] as unknown as CardDefinition
      const semantic = semanticDefinition(id)
      expect(withFixedSeed(() => run(semantic, id, true)), id).toEqual(withFixedSeed(() => run(legacy, id, true)))
    }
  })

  it('keeps post-kill card effects alive through captured handles', () => {
    const targetDepartureCards = [
      'demon-summon-1', 'demon-summon-5', 'hashirama-edo-thousand-hands', 'holy-smite', 'watcher-rage',
    ] as const
    for (const id of targetDepartureCards) {
      const legacy = fixture.entries[`cards/${id}`] as unknown as CardDefinition
      const semantic = semanticDefinition(id)
      const customize = (scenario: Scenario) => {
        const targetId = id === 'demon-summon-5' || id.startsWith('demon-summon-') ? 'ally-1' : 'enemy-1'
        const target = scenario.pieces.find(piece => piece.instanceId === targetId)
        if (!target) throw new Error(`${id}: missing one-hit target fixture`)
        target.currentHp = 1
      }
      const oldBehavior = withFixedSeed(() => run(legacy, id, false, customize))
      const newBehavior = withFixedSeed(() => run(semantic, id, false, customize))
      expect(newBehavior, id).toEqual(oldBehavior)
      expect((newBehavior as any).result?.success, id).toBe(true)
    }
  })

  it('does not select a same-team piece owned by another player', () => {
    const legacy = fixture.entries['cards/watcher-rage'] as unknown as CardDefinition
    const semantic = semanticDefinition('watcher-rage')
    const customize = (scenario: Scenario, state: any) => {
      state.players[0].teamId = 'red'
      state.players[1].teamId = 'blue'
      state.players.push({ ...state.players[0], playerId: 'player-red-ally', hand: [] })
      const ownedWatcher = scenario.pieces.find(piece => piece.instanceId === 'watcher-1')
      if (!ownedWatcher) throw new Error('watcher-rage: missing watcher fixture')
      ownedWatcher.ownerPlayerId = 'player-red-ally'
      ownedWatcher.faction = 'red'
    }
    const oldBehavior = withFixedSeed(() => run(legacy, 'watcher-rage', false, customize))
    const newBehavior = withFixedSeed(() => run(semantic, 'watcher-rage', false, customize))
    expect(newBehavior).toEqual(oldBehavior)
    expect((newBehavior as any).result?.success).toBe(false)
  })

  it('preserves the reactive card departure baseline without calling it a success path', () => {
    const legacy = fixture.entries['cards/sample-reactive-card'] as unknown as CardDefinition
    const semantic = semanticDefinition('sample-reactive-card')
    const customize = (scenario: Scenario) => {
      const source = scenario.pieces.find(piece => piece.instanceId === 'enemy-1')
      if (!source) throw new Error('sample-reactive-card: missing source fixture')
      source.currentHp = 1
    }
    const invoke = (definition: CardDefinition) => {
      try {
        return withFixedSeed(() => run(definition, 'sample-reactive-card', false, customize))
      } catch (error) {
        return { thrown: String((error as Error)?.message ?? error) }
      }
    }
    const oldBehavior = invoke(legacy)
    const newBehavior = invoke(semantic)
    expect(newBehavior).toEqual(oldBehavior)
    expect((newBehavior as any).state.graveyard.some((piece: any) => piece.instanceId === 'enemy-1')).toBe(true)
  })
  it('allows a reaction whose defending event object was already moved to the graveyard', () => {
    const legacy = fixture.entries['cards/sample-reactive-card'] as unknown as CardDefinition
    const semantic = semanticDefinition('sample-reactive-card')
    const customize = (scenario: Scenario, state: any) => {
      const defender = scenario.trigger.targetPiece
      defender.currentHp = 0
      state.pieces = state.pieces.filter((piece: any) => piece.instanceId !== defender.instanceId)
      state.graveyard = [defender]
    }
    const previous = withFixedSeed(() => run(legacy, 'sample-reactive-card', false, customize))
    const current: any = withFixedSeed(() => run(semantic, 'sample-reactive-card', false, customize))
    expect(current).toEqual(previous)
    expect(current.result.success).toBe(true)
    expect(current.state.pieces.find((piece: any) => piece.instanceId === 'enemy-1').currentHp).toBe(19)
  })
})
