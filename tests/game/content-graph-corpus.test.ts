import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { importContentGraph } from '../../electron-editor/content-graph-import'
import { applyContentGraph, assertContentGraphArtifact } from '../../electron-editor/content-graph'
import { assertGameplayModuleDocument } from '../../lib/skill-graph/module-document'
import { executeSkillFunction, type SkillDefinition } from '../../lib/game/skills'
import { RuleRuntime, createRuleExecutionContext, withRuleExecutionContext, withRuleRuntime } from '../../lib/game/rule-runtime'
import { TriggerSystem } from '../../lib/game/triggers'
import { isSuspendableActionPending } from '../../lib/game/suspendable-action-transaction'
import { makePiece, makeState } from '../helpers/minimal-state'

const baseline = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json','utf8')) as {entries:Record<string,Record<string,unknown>>}
const candidates:Array<{id:string;legacy:SkillDefinition;graph:SkillDefinition}> = []
for (const [key, definition] of Object.entries(baseline.entries)) {
  if (!key.startsWith('skills/') || typeof definition.code !== 'string') continue
  const production = JSON.parse(readFileSync(`data/${key}.json`, 'utf8'))
  if (production.contentGraphField === 'code' || production.gameplayModules?.entries?.code) {
    // The generated Electron bundle is intentionally not the registry source
    // of truth for this corpus.  Validate module-owned artifacts with the
    // current source registry so an explicit id@version (for example the
    // tile.batch-records@2 fixture) cannot fall back to a different latest
    // descriptor.  A missing requested version must still throw.
    assertGameplayModuleDocument(production)
    assertContentGraphArtifact(production)
    candidates.push({id:String(definition.id),legacy:definition as unknown as SkillDefinition,graph:production})
    continue
  }
  let graph
  try { graph = importContentGraph(definition.code,definition.kind === 'passive' ? 'triggerSkill' : 'skill') } catch { continue }
  candidates.push({id:String(definition.id),legacy:definition as unknown as SkillDefinition,graph:applyContentGraph(definition,graph,'code') as unknown as SkillDefinition})
}

/** A broad direct-host differential, complementing command/pending scenario tests.
 * Equal rejection/empty results are only coverage of that input, not proof of a
 * skill's successful effect, and are not counted as whole-content acceptance.
 */
function run(definition:SkillDefinition, variant:number) {
  const caster = {...makePiece({instanceId:'caster',ownerPlayerId:'player-red',x:2,y:2,currentHp:6,maxHp:12,attack:5,actionPoints:10}),name:'施法者'}
  const enemy = {...makePiece({instanceId:'enemy',ownerPlayerId:'player-blue',x:3,y:2,currentHp:9,maxHp:12,attack:3}),name:'敌军'}
  const ally = {...makePiece({instanceId:'ally',ownerPlayerId:'player-red',x:2,y:3,currentHp:4,maxHp:12,attack:4}),name:'友军'}
  const battle = makeState({pieces:[caster,enemy,ally],width:7,height:7})
  battle.players[0].actionPoints = 10
  const target = variant === 1 ? enemy : variant === 2 ? ally : null
  const position = variant === 3 ? {x:3,y:3} : null
  const context = {piece:caster,target,targetPosition:position,targets:variant ? [{info:target,pos:position}] : [],battle,skill:definition}
  const runtime = new RuleRuntime({rootSeed:252})
  let result:unknown
  let error:unknown
  let pending:unknown
  try { result = withRuleExecutionContext(createRuleExecutionContext(new TriggerSystem()),() => withRuleRuntime(runtime,() => executeSkillFunction(definition,context,battle))) }
  catch (cause) {
    error = cause instanceof Error ? {name:cause.name,message:cause.message} : cause
    if (isSuspendableActionPending(cause)) {
      const {candidateState, suspendedTurn, ...prompt} = cause.prompt
      // The private resume checkpoint is covered by pending-host tests. This
      // direct-host corpus checks the complete public prompt and unchanged
      // battle/RNG, instead of treating a suspension as an ordinary failure.
      expect(suspendedTurn).toMatchObject({turnNumber: 1, phase: 'action', currentPlayerId: 'player-red'})
      if (candidateState !== undefined) expect(candidateState).toMatchObject({pieces: expect.any(Array)})
      pending = prompt
    }
  }
  return compareValue({result,error,pending,battle,random:runtime.snapshot()})
}

// Separate runtime contexts instantiate different function identities for the
// same companion rules. Compare their exact source, preserving every data key.
function compareValue(value:unknown):unknown {
  if (typeof value === 'function') return {functionSource:String(value)}
  if (Array.isArray(value)) return value.map(compareValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,nested]) => [key,compareValue(nested)]))
  return value
}

type RunObservation = {
  result: unknown
  error: unknown
  pending: unknown
  battle: unknown
  random: unknown
}

function record(value: unknown): Record<string, unknown> {
  expect(value).not.toBeNull()
  expect(typeof value).toBe('object')
  return value as Record<string, unknown>
}

/** Explicit approved deltas from the frozen pre-authoring corpus. Never edit
 * that fixture or erase arbitrary fields: all unlisted data remains compared. */
function expectedAuthorObservation(id: string, variant: number, legacy: RunObservation): RunObservation {
  const expected = structuredClone(legacy)
  const battle = record(expected.battle)
  const piece = (index: number) => record((battle.pieces as unknown[])[index])
  const addStatusOwner = (holder: Record<string, unknown>, field: string) => {
    const status = record((holder.statusTags as unknown[])[0])
    expect(status[field]).toBeUndefined()
    status[field] = 'player-red'
    record((status.statusOrigins as unknown[])[0])[field] = 'player-red'
  }
  if (id === 'aizen-black-coffin' && variant === 1) addStatusOwner(piece(1), 'sourcePlayerId')
  if ((id === 'itachi-amaterasu' && variant === 1)
    || (id === 'sasuke-kagutsuchi' && (variant === 1 || variant === 2))) addStatusOwner(piece(variant), 'ownerPlayerId')
  if (id === 'blizzard' && variant === 3) {
    addStatusOwner(record((battle.players as unknown[])[0]), 'ownerPlayerId')
    for (const tile of record(battle.extensions).tileEffects as unknown[]) {
      expect(record(tile).ownerPlayerId).toBeUndefined()
      record(tile).ownerPlayerId = 'player-red'
    }
  }
  if (id === 'blizzard-damage' || id === 'minato-flying-raijin-passive') {
    // These are passive entries invoked without their trigger event here.
    // Missing dependencies now skip statements and complete the entry; their
    // real trigger effects are exercised separately through the rule host.
    expect(expected.result).toEqual({success: false, message: id === 'blizzard-damage' ? '找不到暴风雪施法者' : ''})
    expected.result = {success: true}
  }
  if (id === 'fireball' && variant === 1) {
    expect(expected.result).toEqual({success: true, message: '施法者使用了火球术，对敌军造成7点伤害'})
    const payload = record(record((battle.actions as unknown[])[0]).payload)
    expect(payload.damageType).toBe('magical')
    expect(payload.rawDamage).toBe(7.5)
    // Public normal/true damage and engine-level floor replace the old
    // physical/magical distinction, without altering final HP or event order.
    payload.damageType = 'physical'
    payload.rawDamage = 7
  }
  if (id === 'fireball' && variant !== 1) {
    expect(expected.result).toEqual({message: '需要选择目标', success: false, needsTargetSelection: true, targetType: 'piece', range: 5, filter: 'enemy', targetIndex: 0})
    expected.result = undefined
    if (variant === 2) expected.error = {name: 'SuspendableActionReplayError', message: 'Selected author target is no longer legal'}
    else {
      expected.error = {name: 'SuspendableActionPending', message: 'Suspendable action requires target input from skill:fireball'}
      expected.pending = {kind: 'target', playerId: 'player-red', title: '选择火球术目标', targetType: 'piece', range: 5, filter: 'enemy', candidates: [{type: 'piece', pieceId: 'enemy'}], selectionMode: 'single', minSelections: 1, maxSelections: 1, canCancel: true, rollbackOnCancel: true, sourcePieceId: 'caster'}
    }
  }
  if (id === 'naruto-shadow-clone' || id === 'recall') {
    const options = id === 'naruto-shadow-clone'
      ? [{label: '在目标格召唤分身', value: 'summon'}, {label: '传送至目标格，原地留下分身', value: 'teleport'}]
      : Array.from({length: 10}, (_, index) => ({label: String(index + 1), value: index + 1}))
    const title = id === 'naruto-shadow-clone' ? '选择影分身方式' : '选择回溯次数'
    expect(expected.result).toEqual(id === 'naruto-shadow-clone'
      ? {message: '需要选择选项', success: false, needsOptionSelection: true, options, title}
      : {success: false, message: 'Invalid Recall action count'})
    expected.result = undefined
    expected.error = {name: 'SuspendableActionPending', message: `Suspendable action requires option input from skill:${id}`}
    expected.pending = {kind: 'option', playerId: 'player-red', title, options, canCancel: true, sourcePieceId: 'caster'}
  }
  return expected
}

function runWithDiagnosticCapture(definition:SkillDefinition, variant:number) {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const observation = run(definition, variant) as RunObservation
    const calls = spy.mock.calls.map(call => [call[0], call[1]] as const)
    return {observation, calls}
  } finally {
    spy.mockRestore()
  }
}

describe('supported skill corpus through the real host', () => {
  it('covers a nonempty frozen corpus', () => expect(candidates.length).toBeGreaterThan(40))
  it('rejects a missing module version instead of resolving the latest descriptor', () => {
    const production = JSON.parse(readFileSync('data/skills/itachi-amaterasu.json', 'utf8')) as {
      gameplayModules: { entries: { code: { graph: { body: Array<Record<string, unknown>> } } } }
    }
    const request = production.gameplayModules.entries.code.graph.body.find(statement => statement.module === 'tile.batch-records')
    expect(request).toBeDefined()
    request!.version = 'missing-test-version'
    expect(() => assertGameplayModuleDocument(production)).toThrow(/registry\.tile\.batch-records/)
  })
  for (const candidate of candidates) it(candidate.id, () => {
    for (let variant=0;variant<4;variant++) {
      if (candidate.id === 'alfonso-kick' && variant === 3) {
        const legacy = run(candidate.legacy, variant) as RunObservation
        const {observation: graph, calls} = runWithDiagnosticCapture(candidate.graph, variant)
        const diagnostics = calls
          .filter(([label]) => label === '[gameplay-module-diagnostic]')
          .map(([,record]) => record)

        // v1 keeps the original abort contract for this invalid direction.
        expect(legacy.result).toBeUndefined()
        expect(legacy.error).toEqual({
          name: 'Error',
          message: '技能执行失败: Projectile direction must be one cardinal unit vector',
        })

        // v2 isolates the faulty trace statement and returns the authored
        // direction prompt from the independent branch that follows it.
        expect(graph.error).toBeUndefined()
        expect(graph.result).toEqual({success: false, message: '请选择正方向'})
        expect(diagnostics).toEqual(expect.arrayContaining([
          expect.objectContaining({
            statementId: 'trace',
            moduleId: 'projectile.trace-strict',
            message: 'Projectile direction must be one cardinal unit vector',
            errorName: 'RangeError',
            surface: 'skill',
            contentId: 'alfonso-kick',
            actorPlayerId: 'player-red',
            turn: 1,
            phase: 'action',
            rootSeed: 252,
          }),
        ]))

        // The skipped statement cannot spend resources or alter any piece;
        // the two versions must leave the same observable battle and RNG state.
        expect(graph.battle).toEqual(legacy.battle)
        expect(graph.random).toEqual(legacy.random)
        expect(graph.battle).toEqual(expect.objectContaining({
          pieces: expect.arrayContaining([
            expect.objectContaining({instanceId: 'caster', currentHp: 6, x: 2, y: 2}),
            expect.objectContaining({instanceId: 'enemy', currentHp: 9, x: 3, y: 2}),
            expect.objectContaining({instanceId: 'ally', currentHp: 4, x: 2, y: 3}),
          ]),
          players: expect.arrayContaining([
            expect.objectContaining({playerId: 'player-red', actionPoints: 10}),
          ]),
        }))
        continue
      }

      expect(run(candidate.graph, variant),`input ${variant}`).toEqual(expectedAuthorObservation(candidate.id, variant, run(candidate.legacy, variant) as RunObservation))
    }
  })
})
