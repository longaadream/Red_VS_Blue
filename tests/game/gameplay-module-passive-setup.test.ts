/* eslint-disable @typescript-eslint/no-explicit-any -- frozen host parity fixtures. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { clearRuleCache, clearSkillDefinitionCache, loadRuleById } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { createFlowRuntime } from '@/lib/game/flow-runtime'
import { buildPassiveSetupGraph, migratePassiveSetupSkills, PASSIVE_SETUP_SKILL_IDS } from '@/scripts/migrate-semantic-passive-setup'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

const root = process.cwd()
const fixture = JSON.parse(readFileSync(join(root, 'tests', 'game', 'fixtures', 'RED-252-legacy-content.json'), 'utf8')).entries as Record<string, any>
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

type Scenario = {
  holder?: any
  contextPlayerId?: string
  state: any
}

function makeScenario(id: typeof PASSIVE_SETUP_SKILL_IDS[number], kind: 'success' | 'missing-holder' | 'blank-owner' | 'missing-owner'): Scenario {
  if (id === 'grant-lucky-coin') {
    const holder = makePiece({ instanceId: 'grant-holder', ownerPlayerId: kind === 'missing-holder' ? 'missing-player' : 'PLAYER-RED' }) as any
    const state = makeState({ pieces: [holder] }) as any
    state.players[0].name = undefined
    return { holder, contextPlayerId: holder.ownerPlayerId, state }
  }
  if (kind === 'missing-holder') {
    const holder = makePiece({ instanceId: 'missing-holder', ownerPlayerId: 'player-red' }) as any
    return { holder, contextPlayerId: 'player-red', state: makeState({ pieces: [] }) as any }
  }
  const holder = makePiece({
    instanceId: 'kiljaedan-hidden',
    templateId: 'kiljaedan',
    ownerPlayerId: kind === 'blank-owner' ? '  ' : 'player-red',
    faction: 'red',
    x: 2,
    y: 2,
    currentHp: 17,
    maxHp: 17,
    attack: 4,
    defense: 3,
    moveRange: 4,
  }) as any
  if (kind === 'missing-owner') holder.ownerPlayerId = undefined
  holder.rules = [{ id: 'rule-kiljaedan-gamestart', limits: { uses: 1 }, effect: () => true }]
  const state = makeState({ pieces: [holder] }) as any
  state.extensions.kiljaedanPiece = { instanceId: 'old-global', templateId: 'kiljaedan', ownerPlayerId: 'player-blue' }
  if (kind === 'success') {
    state.extensions.flowState = [{
      schemaVersion: 1,
      scope: 'piece',
      entityId: holder.instanceId,
      ownerPlayerId: holder.ownerPlayerId,
      namespace: 'passive-setup-test',
      name: 'whileAliveMarker',
      value: { marker: true },
      lifetime: 'while-alive',
      projectionVisibility: 'owner',
    }]
  }
  return { holder, contextPlayerId: holder.ownerPlayerId, state }
}

function run(id: typeof PASSIVE_SETUP_SKILL_IDS[number], semantic: boolean, kind: 'success' | 'missing-holder' | 'blank-owner' | 'missing-owner', contextPlayerIdOverride?: string | null) {
  const profileRoot = mkdtempSync(join(tmpdir(), 'rvb-passive-setup-'))
  const previousRoot = process.env.RVB_PROFILE_ROOT
  for (const group of ['skills', 'rules', 'cards']) mkdirSync(join(profileRoot, 'data', group), { recursive: true })
  for (const cardId of ['lucky-coin', 'demon-summon-1']) {
    writeFileSync(join(profileRoot, 'data', 'cards', cardId + '.json'), readFileSync(join(root, 'data', 'cards', cardId + '.json')))
  }
  const scenario = makeScenario(id, kind)
  const original = clone(fixture['skills/' + id])
  const definition = semantic ? applyGameplayModuleGraph(original, buildPassiveSetupGraph(id)) : original
  writeFileSync(join(profileRoot, 'data', 'skills', id + '.json'), JSON.stringify(definition))
  writeFileSync(join(profileRoot, 'data', 'rules', 'passive-setup-trigger.json'), JSON.stringify({
    id: 'passive-setup-trigger',
    name: 'passive setup test',
    trigger: { type: 'onGameStart' },
    effect: { type: 'triggerSkill', skillId: id },
  }))
  try {
    process.env.RVB_PROFILE_ROOT = profileRoot
    clearRuleCache(); clearSkillDefinitionCache(); globalTriggerSystem.clearRules()
    const runtime = new RuleRuntime({ rootSeed: 594 })
    return withRuleRuntime(runtime, () => {
      const rule = loadRuleById('passive-setup-trigger', true, true)
      if (!rule) throw new Error('missing passive setup trigger rule')
      const context: any = {
        type: 'onGameStart',
        rulePiece: scenario.holder,
        sourcePiece: scenario.holder,
        piece: scenario.holder,
        playerId: contextPlayerIdOverride === null ? undefined : contextPlayerIdOverride ?? scenario.contextPlayerId,
      }
      const result = rule.effect(scenario.state, context)
      const state = clone(scenario.state)
      delete state.skillsById
      return { result: result === undefined ? undefined : clone(result), state, runtime: runtime.snapshot() }
    })
  } finally {
    clearRuleCache(); clearSkillDefinitionCache(); globalTriggerSystem.clearRules()
    if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousRoot
    rmSync(profileRoot, { recursive: true, force: true })
  }
}

function runGrantCardBoundary(addCard: () => boolean): any {
  const original = clone(fixture['skills/grant-lucky-coin'])
  const definition = applyGameplayModuleGraph(original, buildPassiveSetupGraph('grant-lucky-coin'))
  const players = [{ playerId: 'player-red', name: undefined }, { playerId: 'player-blue', name: '蓝方' }]
  const flow = {
    query: {
      players: () => players.map(player => player.playerId),
      hasPlayer: (playerId: string) => players.some(player => player.playerId === playerId),
      player: (playerId: string) => players.find(player => player.playerId === playerId),
    },
    cards: { add: addCard },
  }
  // The graph is the test subject; this executes its generated code against a
  // deliberately small trusted flow boundary so both host return and throw
  // paths can be asserted without changing the production host.
  const execute = new Function('flow', 'context', `${definition.code}; return executeSkill(context)`) as (flow: any, context: any) => any
  return execute(flow, { playerId: 'PLAYER-RED' })
}

describe('semantic passive setup entry points', () => {
  it('grant-lucky-coin preserves case-insensitive player resolution, fallback name, hand event and result', () => {
    const legacy = run('grant-lucky-coin', false, 'success')
    const semantic = run('grant-lucky-coin', true, 'success')
    expect(semantic).toEqual(legacy)
    expect(semantic.result).toMatchObject({ success: true, message: 'player-red 获得了幸运币' })
    expect(semantic.state.players[0].hand).toHaveLength(1)
  })

  it('grant-lucky-coin keeps the missing-player branch closed', () => {
    const legacy = run('grant-lucky-coin', false, 'missing-holder')
    const semantic = run('grant-lucky-coin', true, 'missing-holder')
    expect(semantic).toEqual(legacy)
    expect(semantic.result).toEqual({ success: false, message: 'Player not found' })
  })

  it('grant-lucky-coin reads context.playerId instead of holder ownership', () => {
    const legacy = run('grant-lucky-coin', false, 'success', 'player-blue')
    const semantic = run('grant-lucky-coin', true, 'success', 'player-blue')
    expect(semantic).toEqual(legacy)
    expect(semantic.state.players.find((player: any) => player.playerId === 'player-red').hand).toHaveLength(0)
    expect(semantic.state.players.find((player: any) => player.playerId === 'player-blue').hand).toHaveLength(1)
  })

  it('grant-lucky-coin preserves the legacy missing-context error and full state', () => {
    const legacy = run('grant-lucky-coin', false, 'success', null)
    const semantic = run('grant-lucky-coin', true, 'success', null)
    expect(semantic).toEqual(legacy)
    expect(semantic.result).toEqual({ success: false, message: "Error: Cannot read properties of undefined (reading 'toLowerCase')" })
    expect(semantic.state.players.every((player: any) => player.hand.length === 0)).toBe(true)
  })

  it('grant-lucky-coin keeps a false card host result as a normal unsuccessful result', () => {
    expect(runGrantCardBoundary(() => false)).toEqual({ success: false, message: 'player-red 获得了幸运币' })
  })

  it('grant-lucky-coin converts a card host throw into the legacy error result', () => {
    expect(runGrantCardBoundary(() => { throw new Error('card failure') })).toEqual({ success: false, message: 'Error: card failure' })
  })

  it('demonic pact preserves detached snapshot, scoped storage and singleton retention', () => {
    const legacy = run('kiljaedan-demonic-pact', false, 'success')
    const semantic = run('kiljaedan-demonic-pact', true, 'success')
    expect(semantic).toEqual(legacy)
    expect(semantic.result).toEqual({ success: true, message: '基尔加丹隐匿于虚空之中，等待召唤...' })
    expect(semantic.state.pieces).toEqual([])
    expect(semantic.state.extensions.kiljaedanPiecesByPlayerId['player-red']).toMatchObject({ templateId: 'kiljaedan', ownerPlayerId: 'player-red' })
    expect(semantic.state.extensions.kiljaedanPiecesByPlayerId['player-red'].rules[0]).not.toHaveProperty('effect')
    expect(semantic.state.extensions.kiljaedanPiece.instanceId).toBe('old-global')
    expect(semantic.state.extensions).not.toHaveProperty('authorOutOfPlay')
    expect(semantic.state.players[0].hand).toHaveLength(1)
  })

  it.each(['missing-holder', 'blank-owner', 'missing-owner'] as const)('demonic pact preserves %s rejection and state ordering', kind => {
    const legacy = run('kiljaedan-demonic-pact', false, kind)
    const semantic = run('kiljaedan-demonic-pact', true, kind)
    expect(semantic).toEqual(legacy)
    if (kind === 'missing-holder') expect(semantic.result).toEqual({ success: false, message: '' })
    else expect(semantic.result).toEqual({ success: false, message: '基尔加丹缺少所属玩家' })
  })

  it('keeps the authoritative trigger-skill detach on the generic out-of-play path', () => {
    const holder = asPieceInstance(makePiece({
      instanceId: 'trigger-detached',
      templateId: 'trigger-piece',
      name: 'trigger piece',
      ownerPlayerId: 'player-red',
      faction: 'red',
    }) as any)
    const state = makeState({ pieces: [holder] }) as any
    const flow = createFlowRuntime(state, { piece: holder }, 'triggerSkill', {})

    expect(flow.lifecycle.detachActive(holder.instanceId, 'preserve')).toBe(true)
    expect(state.pieces).toHaveLength(0)
    expect(state.extensions.authorOutOfPlay.pieces[holder.instanceId]).toBeDefined()
  })
})

function makeMigrationRoot(): string {
  const migrationRoot = mkdtempSync(join(tmpdir(), 'rvb-passive-setup-migration-'))
  mkdirSync(join(migrationRoot, 'tests', 'game', 'fixtures'), { recursive: true })
  mkdirSync(join(migrationRoot, 'data', 'skills'), { recursive: true })
  writeFileSync(join(migrationRoot, 'tests', 'game', 'fixtures', 'RED-252-legacy-content.json'), JSON.stringify({ entries: {} }))
  for (const id of PASSIVE_SETUP_SKILL_IDS) {
    writeFileSync(join(migrationRoot, 'data', 'skills', `${id}.json`), readFileSync(join(root, 'data', 'skills', `${id}.json`)))
  }
  return migrationRoot
}

function mutateFirstLiteral(value: any, from: string, to: string): boolean {
  if (Array.isArray(value)) return value.some(item => mutateFirstLiteral(item, from, to))
  if (!value || typeof value !== 'object') return false
  if (value.kind === 'literal' && value.value === from) {
    value.value = to
    return true
  }
  return Object.values(value).some(item => mutateFirstLiteral(item, from, to))
}

describe('passive setup migration ownership', () => {
  it('preserves a valid author-edited module graph without refreshing the recipe', () => {
    const migrationRoot = makeMigrationRoot()
    try {
      const file = join(migrationRoot, 'data', 'skills', 'grant-lucky-coin.json')
      const current = JSON.parse(readFileSync(file, 'utf8')) as any
      const editedGraph = clone(current.gameplayModules.entries.code.graph)
      expect(mutateFirstLiteral(editedGraph, ' 获得了幸运币', ' 获得了作者编辑的幸运币')).toBe(true)
      const edited = applyGameplayModuleGraph(current, editedGraph)
      writeFileSync(file, JSON.stringify(edited, null, 2) + '\n')
      const beforeMigration = readFileSync(file, 'utf8')

      expect(migratePassiveSetupSkills(migrationRoot, true)).toEqual([])
      expect(readFileSync(file, 'utf8')).toBe(beforeMigration)
      expect(JSON.parse(beforeMigration).code).toContain('作者编辑的幸运币')
    } finally {
      rmSync(migrationRoot, { recursive: true, force: true })
    }
  })

  it('rejects tampered generated source and does not write it back', () => {
    const migrationRoot = makeMigrationRoot()
    try {
      const file = join(migrationRoot, 'data', 'skills', 'grant-lucky-coin.json')
      const tampered = JSON.parse(readFileSync(file, 'utf8')) as any
      tampered.code += '\n// tampered source'
      writeFileSync(file, JSON.stringify(tampered, null, 2) + '\n')
      const beforeMigration = readFileSync(file, 'utf8')

      expect(() => migratePassiveSetupSkills(migrationRoot, true)).toThrow(/generated code does not match its module graph/)
      expect(readFileSync(file, 'utf8')).toBe(beforeMigration)
    } finally {
      rmSync(migrationRoot, { recursive: true, force: true })
    }
  })
})
