import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { importContentGraph } from '../../electron-editor/content-graph-import'
import { applyContentGraph, assertContentGraphArtifact } from '../../electron-editor/content-graph-document'
import { executeSkillFunction, type SkillDefinition } from '../../lib/game/skills'
import { RuleRuntime, createRuleExecutionContext, withRuleExecutionContext, withRuleRuntime } from '../../lib/game/rule-runtime'
import { TriggerSystem } from '../../lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const baseline = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json','utf8')) as {entries:Record<string,Record<string,unknown>>}
const candidates:Array<{id:string;legacy:SkillDefinition;graph:SkillDefinition}> = []
for (const [key, definition] of Object.entries(baseline.entries)) {
  if (!key.startsWith('skills/') || typeof definition.code !== 'string') continue
  const production = JSON.parse(readFileSync(`data/${key}.json`, 'utf8'))
  if (production.contentGraphField === 'code' || production.gameplayModules?.entries?.code) {
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
  try { result = withRuleExecutionContext(createRuleExecutionContext(new TriggerSystem()),() => withRuleRuntime(runtime,() => executeSkillFunction(definition,context,battle))) }
  catch (cause) { error = cause instanceof Error ? {name:cause.name,message:cause.message} : cause }
  return compareValue({result,error,battle,random:runtime.snapshot()})
}

// Separate runtime contexts instantiate different function identities for the
// same companion rules. Compare their exact source, preserving every data key.
function compareValue(value:unknown):unknown {
  if (typeof value === 'function') return {functionSource:String(value)}
  if (Array.isArray(value)) return value.map(compareValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,nested]) => [key,compareValue(nested)]))
  return value
}

describe('supported skill corpus through the real host', () => {
  it('covers a nonempty frozen corpus', () => expect(candidates.length).toBeGreaterThan(40))
  for (const candidate of candidates) it(candidate.id, () => {
    for (let variant=0;variant<4;variant++) expect(run(candidate.graph,variant),`input ${variant}`).toEqual(run(candidate.legacy,variant))
  })
})
