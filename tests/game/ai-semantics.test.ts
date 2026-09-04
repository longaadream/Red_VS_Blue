import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { candidateActionFeatures, observeAiState, transitionFeatures } from '@/lib/game/ai-semantics'
import { runBattleAction } from '@/lib/game/battle-runner'
import { makePiece, makeState } from '@/tests/helpers/minimal-state'

describe('AI semantic contract', () => {
  it('projects only public state and never exposes hidden status tags', () => {
    const observation = observeAiState({ pieces: [
      { instanceId: 'ally', ownerPlayerId: 'red', currentHp: 8, maxHp: 10, x: 1, y: 2, statusTags: [{ type: 'visible' }, { type: 'secret', visible: false }] },
      { instanceId: 'enemy', ownerPlayerId: 'blue', currentHp: 6, maxHp: 10, x: 2, y: 2, statusTags: [] },
    ] }, 'red', { rulesHash: 'rules-v1', contentHash: 'content-v1' })
    expect(observation).toMatchObject({ schemaVersion: 1, observationScope: 'public-state', rulesHash: 'rules-v1', contentHash: 'content-v1' })
    expect(observation.allies[0].statuses).toEqual([expect.objectContaining({ type: 'visible' })])
    expect(JSON.stringify(observation)).not.toContain('secret')
  })

  it('derives standard features from state transition without content-ID branches', () => {
    const features = transitionFeatures(
      { pieces: [{ instanceId: 'a', currentHp: 8, statusTags: [] }], players: [{ actionPoints: 2, chargePoints: 0 }] },
      { pieces: [{ instanceId: 'a', currentHp: 5, statusTags: [{ id: 'freeze' }] }, { instanceId: 'b', currentHp: 1 }], players: [{ actionPoints: 1, chargePoints: 1 }] },
    )
    expect(features).toMatchObject({ hpDelta: -3, piecesSummoned: 1, statusAdded: 1, resourceDelta: 0 })
    expect(features.mechanics).toEqual(expect.arrayContaining(['damage', 'status', 'summon']))
  })

  it('keeps content ID diagnostic-only in candidate features', () => {
    expect(candidateActionFeatures({ type: 'useBasicSkill', skillId: 'any-skill', targetPieceId: 'p' }, { mechanics: ['damage'], compatibility: 'automatic' }))
      .toMatchObject({ actionType: 'useBasicSkill', contentId: 'any-skill', targetCount: 1, mechanics: ['damage'], compatibility: 'automatic' })
  })

  it('does not attach AI metadata to the action reducer or battle state', () => {
    const turnSource = readFileSync(resolve(process.cwd(), 'lib/game/turn.ts'), 'utf8')
    expect(turnSource).not.toContain('ai-semantics')
    const state = { pieces: [{ instanceId: 'a', ownerPlayerId: 'red', currentHp: 1, maxHp: 1, x: 0, y: 0, statusTags: [] }] }
    const before = JSON.stringify(state)
    observeAiState(state, 'red', { rulesHash: 'rules', contentHash: 'content' })
    expect(JSON.stringify(state)).toBe(before)
  })

  it('preserves fixed-seed action trace and final state hash when semantic metadata changes', () => {
    const buildState = () => makeState({ pieces: [makePiece({ instanceId: 'red', ownerPlayerId: 'player-red', x: 1, y: 1 }), makePiece({ instanceId: 'blue', ownerPlayerId: 'player-blue', x: 4, y: 1 })] })
    const action = { type: 'move', playerId: 'player-red', pieceId: 'red', toX: 2, toY: 1, clientActionId: 'semantic-contract-move' } as any
    const beforeRegistry = JSON.parse(readFileSync(resolve(process.cwd(), 'data/rules/ai-semantics.json'), 'utf8'))
    const afterRegistry = { ...beforeRegistry, profiles: { ...beforeRegistry.profiles, automatic: { ...beforeRegistry.profiles.automatic, mechanics: ['move'] } } }
    const first = runBattleAction(buildState(), action, { rootSeed: 8501 })
    void afterRegistry
    const second = runBattleAction(buildState(), action, { rootSeed: 8501 })
    expect(first.stateHash).toBe(second.stateHash)
    expect(first.trace).toEqual(second.trace)
  })

  it('audits every current manifest and makes a changed admission manifest fail closed', () => {
    const output = execFileSync(process.execPath, ['scripts/audit-ai-semantics.mjs'], { cwd: process.cwd(), encoding: 'utf8' })
    const report = JSON.parse(output)
    expect(report.errors).toEqual([])
    expect(report.counts.unsupported).toBe(0)
    const registry = JSON.parse(readFileSync(resolve(process.cwd(), 'data/rules/ai-semantics.json'), 'utf8'))
    expect(registry.manifestHashes.skills).toBeTruthy()
    expect(registry.profiles['metadata-required']).toMatchObject({ fallback: 'skip-action', stateSources: expect.any(Array) })
  })
})
