/* eslint-disable @typescript-eslint/no-explicit-any -- Differential fixtures preserve the legacy host shape. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { applyGameplayModuleGraph, compileGameplayModuleGraph, GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-document'
import { executeSkillFunction, loadRuleById, type SkillDefinition } from '../../lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'
import { buildTargetEffectGraph, buildTargetEffectPreview, migrateTargetEffects, TARGET_EFFECT_RECIPES } from '../../scripts/migrate-semantic-target-effects'
import { buildProjectileSkillGraph } from '../../scripts/migrate-semantic-projectile-skills'
import { buildAtomicFireballGraph } from '../../scripts/migrate-atomic-author-samples'
import { migrateAtomicAuthorGraph } from '../../scripts/migrate-atomic-author-modules'
import { RuleRuntime, withRuleRuntime } from '../../lib/game/rule-runtime'
import { recordBattlePresentation, recordedBattlePresentation } from '../../lib/game/battle-presentation-recording'

const entries = JSON.parse(fs.readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
function canonicalSkillGraph(id: string): any {
  if (id === 'fireball') return buildAtomicFireballGraph()
  if (id === 'ulquiorra-cero') return migrateAtomicAuthorGraph(buildProjectileSkillGraph(id))
  return migrateAtomicAuthorGraph(buildTargetEffectGraph(id))
}

function run(definition: any, targetHp: number, select: boolean, distance = TARGET_EFFECT_RECIPES[definition.id].minimumDistance ?? 1, rage = false, shield = false, rewrittenTarget?: string) {
  const caster = makePiece({ instanceId: 'caster', name: '施放者', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 7, currentHp: 6, maxHp: 12 })
  const ally = TARGET_EFFECT_RECIPES[definition.id].ally
  const target = makePiece({ instanceId: 'target', ownerPlayerId: ally ? 'player-red' : 'player-blue', x: 1 + distance, y: 1, currentHp: targetHp, maxHp: Math.max(20, targetHp) })
  caster.name = '施放者'
  target.name = '目标'
  target.defense = 1
  const battle = makeState({ pieces: [caster, target], width: 12, height: 12 })
  if (rage) {
    caster.statusTags = [{ id: 'rage', type: 'rage-stance' }]
    caster.rules = [loadRuleById('rule-watcher-rage-dealt', true)!]
  }
  if (shield) {
    target.statusTags = [{ id: 'divine-shield', type: 'divine-shield' }]
    target.rules = [loadRuleById('rule-divine-shield', true)!]
  }
  battle.skillsById[definition.id] = definition
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1700000000000)
  let result
  try { result = recordBattlePresentation(battle, () => executeSkillFunction(definition as SkillDefinition, {
    piece: caster, skill: definition, battle, target: select ? target : null,
    targetPosition: null, targets: select ? [{ info: target, pos: null }] : [],
    ruleRewrittenPrimaryTargetPieceId: rewrittenTarget,
  } as any, battle), () => battle) } finally { clock.mockRestore() }
  const snapshot: any = clone(battle)
  delete snapshot.skillsById
  return { result: clone(result), state: snapshot, presentation: recordedBattlePresentation(battle) }
}

function assertProductionExecutable(id: string, original: any, production: any): void {
  // Keep exact-code checks pointed at the owning canonical graph.  Fireball is
  // one of the public atomic author samples; Cero belongs to projectiles.
  expect(production.code).toBe(applyGameplayModuleGraph(original, canonicalSkillGraph(id)).code)
}

describe('registered target effects preserve production behavior', () => {
  for (const distance of [1, 6, 7]) for (const rewrittenTarget of [undefined, 'target', 'another-piece']) {
    it(`preserves Deadly Gaze distance ${distance} with rewritten target ${rewrittenTarget}`, () => {
      const old = clone(entries['skills/blackwidow-deadly-gaze'])
      const next = applyGameplayModuleGraph(old, buildTargetEffectGraph(old.id))
      const seeded = (definition: any, hp: number, shield: boolean) => {
        const runtime = new RuleRuntime({ rootSeed: 594 })
        return withRuleRuntime(runtime, () => ({ ...run(definition, hp, true, distance, false, shield, rewrittenTarget), runtime: runtime.snapshot() }))
      }
      for (const hp of [1, 50]) for (const shield of [false, true]) {
        const actual = seeded(next, hp, shield)
        expect(actual).toEqual(seeded(old, hp, shield))
        expect(actual.result.success).toBe(distance >= 7 || rewrittenTarget === 'target')
      }
    })
  }
  it('does not apply frostbolt freeze when a shield blocks its damage', () => {
    const old = clone(entries['skills/frostbolt'])
    const next = applyGameplayModuleGraph(old, buildTargetEffectGraph('frostbolt'))
    const actual = run(next, 20, true, 1, false, true)
    expect(actual).toEqual(run(old, 20, true, 1, false, true))
    expect(actual.state.pieces.find((piece: any) => piece.instanceId === 'target').statusTags.some((tag: any) => tag.type === 'freeze')).toBe(false)
  })
  it('preserves Venom success and wording for blocked and unblocked damage', () => {
    const old = clone(entries['skills/venom-claw-rend'])
    const next = applyGameplayModuleGraph(old, buildTargetEffectGraph('venom-claw-rend'))
    for (const hp of [3, 20]) for (const shield of [false, true]) expect(run(next, hp, true, 1, false, shield)).toEqual(run(old, hp, true, 1, false, shield))
    expect(run(next, 20, true, 1, false, true).result).toMatchObject({ success: true, message: '施放者使用利爪撕裂，伤害被阻挡' })
  })
  it('preserves fractional damage until the existing beforeDamageDealt rules finish', () => {
    const old = clone(entries['skills/fireball'])
    const next = applyGameplayModuleGraph(old, buildTargetEffectGraph('fireball'))
    const original = run(old, 30, true, 1, true)
    expect(JSON.stringify(original.state.actions)).toContain('暴怒')
    expect(run(next, 30, true, 1, true)).toEqual(original)
  })
  it('does not overwrite an authored semantic entry when migration is rerun', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-target-migration-'))
    try {
      fs.mkdirSync(path.join(root, 'data/skills'), { recursive: true })
      fs.mkdirSync(path.join(root, 'tests/game/fixtures'), { recursive: true })
      fs.writeFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), JSON.stringify({ entries }))
      for (const id of Object.keys(TARGET_EFFECT_RECIPES)) fs.copyFileSync('data/skills/' + id + '.json', path.join(root, 'data/skills/' + id + '.json'))
      const filename = path.join(root, 'data/skills/ashbringer.json')
      const graph: any = clone(buildTargetEffectGraph('ashbringer'))
      graph.body.find((node: any) => node.id === 'choice').parameters.range = 3
      const authored = applyGameplayModuleGraph(JSON.parse(fs.readFileSync(filename, 'utf8')), graph)
      fs.writeFileSync(filename, JSON.stringify(authored, null, 2) + '\n')
      migrateTargetEffects(root, true)
      expect(JSON.parse(fs.readFileSync(filename, 'utf8'))).toEqual(authored)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  for (const id of Object.keys(TARGET_EFFECT_RECIPES)) {
    if (entries['skills/' + id].previewCode) it(`${id} preserves preview numbers and exact wording across attack values`, () => {
      const original = entries['skills/' + id]
      const code = compileGameplayModuleGraph(buildTargetEffectPreview(id), GAMEPLAY_MODULE_REGISTRY).code
      const oldPreview = Function('return (' + original.previewCode + ')')()
      const newPreview = Function('return (' + code + ')')()
      for (const attack of [0, 1, 7, 12]) expect(newPreview({ attack }, original, 0)).toEqual(oldPreview({ attack }, original, 0))
    })
    for (const hp of [3, 20]) it(`${id} preserves damage/heal, logs and removal with target HP ${hp}`, () => {
      const old = clone(entries['skills/' + id])
      const next = JSON.parse(fs.readFileSync('data/skills/' + id + '.json', 'utf8'))
      assertProductionExecutable(id, old, next)
      if (id === 'fireball') {
        const actual = run(next, hp, true)
        const damageAction = actual.state.actions.find((action: any) => action.type === 'damage') as any
        // Success text is optional, and this existing skill intentionally
        // retains its message. Keep the original wording, including on death.
        expect(actual.result).toEqual(run(old, hp, true).result)
        expect(actual.result).toHaveProperty('message')
        expect(actual.state.actions).toHaveLength(1)
        expect(damageAction).toMatchObject({
          type: 'damage',
          payload: expect.objectContaining({
            skillId: 'fireball',
            damageType: 'physical',
            rawDamage: 10,
            modifiedDamage: 10,
            defense: 1,
            finalDamage: hp === 3 ? 3 : 9,
            resolvedDamage: 9,
            blocked: false,
            killed: hp === 3,
          }),
        })
        expect(actual.presentation).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'damage',
            targetPieceIds: ['target'],
            result: expect.objectContaining({ amount: hp === 3 ? 3 : 9 }),
          }),
        ]))
        if (hp === 3) {
          expect(actual.state.pieces.find((piece: any) => piece.instanceId === 'target')).toBeUndefined()
          expect(actual.state.graveyard).toEqual(expect.arrayContaining([
            expect.objectContaining({ instanceId: 'target', currentHp: 0 }),
          ]))
          expect(actual.presentation).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'death', targetPieceIds: ['target'] }),
          ]))
        } else {
          expect(actual.state.pieces.find((piece: any) => piece.instanceId === 'target')).toMatchObject({ currentHp: 11 })
          expect(actual.state.graveyard ?? []).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ instanceId: 'target' }),
          ]))
          expect(actual.presentation).toHaveLength(1)
        }
        return
      }
      const expected = run(old, hp, true)
      expect(expected.result.success).toBe(true)
      expect(expected.result.needsTargetSelection).not.toBe(true)
      if (TARGET_EFFECT_RECIPES[id].damage) expect(expected.state.actions.length).toBeGreaterThan(0)
      else expect(expected.state.pieces.find((piece: any) => piece.instanceId === 'target').currentHp).toBe(Math.min(20, hp + TARGET_EFFECT_RECIPES[id].heal!))
      expect(run(next, hp, true)).toEqual(expected)
    })
    it(`${id} preserves the initial target-selection request`, () => {
      const old = clone(entries['skills/' + id])
      const next = applyGameplayModuleGraph(old, buildTargetEffectGraph(id))
      expect(run(next, 20, false)).toEqual(run(old, 20, false))
    })
    if (TARGET_EFFECT_RECIPES[id].minimumDistance) it(`${id} rejects a target inside the minimum distance without effects`, () => {
      const old = clone(entries['skills/' + id])
      const next = applyGameplayModuleGraph(old, buildTargetEffectGraph(id))
      expect(run(next, 20, true, 6)).toEqual(run(old, 20, true, 6))
    })
  }
})
