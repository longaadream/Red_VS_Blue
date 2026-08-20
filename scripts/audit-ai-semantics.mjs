import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd())
const semanticPath = resolve(root, 'data/rules/ai-semantics.json')
const semantics = JSON.parse(readFileSync(semanticPath, 'utf8'))
const groups = ['pieces', 'skills', 'cards', 'rules', 'status-effects']
const result = { automatic: [], metadataRequired: [], evaluatorRequired: [], unsupported: [], errors: [] }
const mechanicVocabulary = new Set(['damage', 'heal', 'control', 'cleanse', 'protect', 'move', 'summon', 'transform', 'resource', 'delayed', 'status', 'combo'])

function manifestHash(ids) { return createHash('sha256').update(JSON.stringify(ids)).digest('hex') }
function declared(group, id, field) { return (semantics[field]?.[group] || []).includes(id) }
function validateProfile(name) {
  const profile = semantics.profiles?.[name]
  if (!profile || !Array.isArray(profile.mechanics) || !Array.isArray(profile.stateSources) || typeof profile.fallback !== 'string') {
    result.errors.push(`schemaVersion ${semantics.schemaVersion}: profile ${name} is missing mechanics, stateSources, or fallback`)
    return
  }
  for (const mechanic of profile.mechanics) if (!mechanicVocabulary.has(mechanic)) result.errors.push(`profile ${name}: invalid mechanic ${mechanic}`)
}
if (semantics.schemaVersion !== 1) result.errors.push(`schemaVersion ${semantics.schemaVersion}: unsupported; expected 1`)
if (semantics.observationScope !== 'public-state') result.errors.push(`observationScope: expected public-state`)
for (const profile of ['automatic', 'metadata-required', 'evaluator-required', 'unsupported']) validateProfile(profile)

for (const group of groups) {
  const manifest = JSON.parse(readFileSync(resolve(root, `data/${group}/manifest.json`), 'utf8'))
  if (manifestHash(manifest) !== semantics.manifestHashes?.[group]) {
    result.errors.push(`${group}: manifest hash differs; add reviewed AI semantics before admitting changed content`)
  }
  for (const id of manifest) {
    const path = resolve(root, `data/${group}/${id}.json`)
    if (declared(group, id, 'unsupported')) { result.unsupported.push(`${group}/${id}`); continue }
    if (!existsSync(path)) { result.errors.push(`${group}/${id}: missing content is not declared unsupported`); continue }
    const definition = JSON.parse(readFileSync(path, 'utf8'))
    const source = JSON.stringify(definition)
    const complex = /extensions|addSkillById|removeSkillById|Math\.random|Date\.now|summon|transform/i.test(source)
    if (declared(group, id, 'evaluatorRequired')) result.evaluatorRequired.push(`${group}/${id}`)
    else if (complex) {
      if (!declared(group, id, 'metadataRequired')) result.errors.push(`${group}/${id}: complex mechanism lacks metadata-required declaration`)
      else result.metadataRequired.push(`${group}/${id}`)
    } else result.automatic.push(`${group}/${id}`)
  }
}

console.log(JSON.stringify({ schemaVersion: semantics.schemaVersion, observationScope: semantics.observationScope, counts: Object.fromEntries(Object.entries(result).map(([key, values]) => [key, values.length])), ...result }, null, 2))
if (result.errors.length) process.exitCode = 1
