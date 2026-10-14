/** RED-252: materialize authoring identity without changing executable content. */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertSkillClusterMetadata, buildSkillClusterCatalog, SKILL_CLUSTER_VERSION, type SkillClusterCatalogInput } from '../lib/skill-graph/module-cluster'

type Document = Record<string, unknown>
const groups = ['skills', 'rules', 'pieces', 'cards'] as const
const object = (value: unknown): value is Document => !!value && typeof value === 'object' && !Array.isArray(value)
const ordinary = (id: string, value: Document) => !id.startsWith('pve-') && !(object(value.availability) && Array.isArray(value.availability.modes) && value.availability.modes.length > 0 && value.availability.modes.every(mode => mode === 'pve'))

// Source-reviewed associations; no name/prefix inference. These links are
// authoring relations only and never install rules on a battle piece.
export const VERIFIED_PASSIVE_LINKS: Record<string, { pieceId: string; ruleIds: string[]; shared?: string[]; ruleField?: 'playerRules' }> = {
  'soul-fracture': { pieceId: 'guldan', ruleIds: ['rule-soul-fracture-player'], ruleField: 'playerRules' },
  'hidan-undying': { pieceId: 'red-hidan', ruleIds: ['rule-hidan-undying', 'rule-hidan-dying-immune'] },
  'watcher-form': { pieceId: 'blue-watcher', ruleIds: ['rule-watcher-form'] },
  'muzan-flesh-regeneration': { pieceId: 'dark-muzan', ruleIds: ['rule-muzan-regeneration-damage', 'rule-muzan-regeneration-end'] },
  'akaza-fighting-spirit': { pieceId: 'dark-akaza', ruleIds: ['rule-akaza-fighting-spirit'] },
  'kenshin-tenken-passive': { pieceId: 'blue-kenshin', ruleIds: ['rule-kenshin-tenken', 'rule-kenshin-tenken-boost'] },
  'minato-flying-raijin-passive': { pieceId: 'blue-minato', ruleIds: ['rule-minato-anchor-end-turn', 'rule-minato-flying-raijin-trigger'] },
  'tirion-divine-glory': { pieceId: 'blue-tirion-fordring', ruleIds: ['rule-tirion-divine-shield-start', 'rule-tirion-divine-glory'] },
  'grimmjow-destruction-instinct': { pieceId: 'dark-grimmjow', ruleIds: ['rule-grimmjow-destruction-instinct'] },
  'grimmjow-hunting-instinct': { pieceId: 'dark-grimmjow', ruleIds: ['rule-grimmjow-hunt-after-move', 'rule-grimmjow-hunt-after-skill'] },
  'grimmjow-resurreccion': { pieceId: 'dark-grimmjow', ruleIds: ['rule-grimmjow-resurreccion'] },
  'ulquiorra-high-speed-regeneration': { pieceId: 'dark-ulquiorra', ruleIds: ['rule-ulquiorra-damage-dealt', 'rule-ulquiorra-damage-taken'], shared: ['rule-ulquiorra-damage-dealt', 'rule-ulquiorra-damage-taken'] },
  'ulquiorra-resurreccion': { pieceId: 'dark-ulquiorra', ruleIds: ['rule-ulquiorra-damage-dealt', 'rule-ulquiorra-damage-taken', 'rule-ulquiorra-resurreccion'], shared: ['rule-ulquiorra-damage-dealt', 'rule-ulquiorra-damage-taken'] },
  'hashirama-edo-regen': { pieceId: 'hashirama-edo', ruleIds: ['rule-hashirama-edo-regen'] },
  'kiljaedan-demonic-pact': { pieceId: 'kiljaedan', ruleIds: ['rule-kiljaedan-gamestart'] },
  'blood-echo': { pieceId: 'liadrin', ruleIds: ['rule-blood-echo'] },
  'reap': { pieceId: 'reaper', ruleIds: ['rule-reap'] },
  'rafaam-curse-ward': { pieceId: 'red-rafaam', ruleIds: ['rule-rafaam-curse-ward'] },
  'shishio-combustion-passive': { pieceId: 'red-shishio', ruleIds: ['rule-shishio-cooldown-once', 'rule-shishio-combustion', 'rule-shishio-no-heal'] },
  'pulse-pistol': { pieceId: 'tracer', ruleIds: ['rule-pulse-pistol', 'rule-pulse-pistol-move'] },
  'turalyon-lightforged-march': { pieceId: 'turalyon', ruleIds: ['rule-turalyon-lightforged-march'] },
  'elune-guidance': { pieceId: 'tyrande', ruleIds: ['rule-elune-guidance'] },
  'elune-protection': { pieceId: 'tyrande', ruleIds: ['rule-elune-protection'] },
  'shelly-bandage': { pieceId: 'shelly', ruleIds: ['rule-shelly-bandage'] },
  'mortis-night-construct': { pieceId: 'mortis', ruleIds: ['rule-mortis-damage-counter'] },
  'passive-injury-charge-discount': { pieceId: 'el-primo', ruleIds: ['rule-el-primo-injury-counter'] },
  'colt-big-stride': { pieceId: 'colt', ruleIds: ['rule-colt-big-stride'] },
}

export function loadClusterCatalog(root: string) {
  const catalog: SkillClusterCatalogInput = { skills: {}, rules: {}, pieces: {}, cards: {} }
  const unmanifested: string[] = []
  for (const group of groups) {
    const dir = resolve(root, 'data', group)
    const ids: unknown = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'))
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) || new Set(ids).size !== ids.length) throw new Error(`Invalid ${group} manifest`)
    const target = catalog[group] as Record<string, Document>
    for (const id of ids as string[]) {
      const value: unknown = JSON.parse(readFileSync(resolve(dir, `${id}.json`), 'utf8'))
      if (!object(value) || value.id !== id) throw new Error(`Invalid ${group}/${id} identity`)
      target[id] = value
    }
    for (const file of readdirSync(dir).filter(name => name.endsWith('.json') && name !== 'manifest.json')) {
      if (!ids.includes(file.slice(0, -5))) unmanifested.push(`${group}/${file.slice(0, -5)}`)
    }
  }
  return { catalog, unmanifested: unmanifested.sort() }
}

export function migrateSkillClusters(root = process.cwd(), write = false) {
  const { catalog, unmanifested } = loadClusterCatalog(root)
  const pending: { path: string; content: Document }[] = []
  const identities: string[] = []
  const excluded: string[] = []
  for (const group of ['skills', 'pieces'] as const) {
    for (const [id, value] of Object.entries(catalog[group])) {
      if (!ordinary(id, value)) { excluded.push(`${group}/${id}`); continue }
      identities.push(`${group}/${id}`)
      const previous = value.cluster
      if (previous !== undefined && (!object(previous) || previous.version !== SKILL_CLUSTER_VERSION || previous.id !== `${group}:${id}`)) throw new Error(`Unsupported Cluster identity at ${group}/${id}`)
      assertSkillClusterMetadata(value)
      const metadata: Document = previous === undefined ? { version: SKILL_CLUSTER_VERSION, id: `${group}:${id}`, links: [] } : { ...(previous as Document) }
      if (!Array.isArray(metadata.links)) throw new Error(`Invalid Cluster links at ${group}/${id}`)
      // An existing Cluster is author-owned; reruns must not re-add removed links.
      const mapping = group === 'skills' && previous === undefined ? VERIFIED_PASSIVE_LINKS[id] : undefined
      if (mapping) {
        const piece = catalog.pieces[mapping.pieceId]
        for (const ruleId of mapping.ruleIds) {
          const rules = piece?.[mapping.ruleField ?? 'rules']
          if (!Array.isArray(rules) || !rules.includes(ruleId) || !catalog.rules[ruleId]) throw new Error(`Verified passive association no longer matches: ${id}/${ruleId}`)
          metadata.links.push({ collection: 'rules', id: ruleId, relation: mapping.shared?.includes(ruleId) ? 'shared' : 'owned', source: `pieces/${mapping.pieceId}.${mapping.ruleField ?? 'rules'}` })
        }
      }
      if (JSON.stringify(previous) !== JSON.stringify(metadata)) {
        const next = { ...value, cluster: metadata }
        const beforeExecution = { ...value }; delete beforeExecution.cluster
        const afterExecution = { ...next } as Document; delete afterExecution.cluster
        if (JSON.stringify(beforeExecution) !== JSON.stringify(afterExecution)) throw new Error(`Non-Cluster content changed: ${group}/${id}`)
        ;(catalog[group] as Record<string, Document>)[id] = next
        pending.push({ path: resolve(root, 'data', group, `${id}.json`), content: next })
      }
    }
  }
  const aggregated = buildSkillClusterCatalog(catalog)
  const clusters = aggregated.clusters.filter(cluster => identities.includes(`${cluster.root.collection}/${cluster.root.id}`))
  const report = {
    version: SKILL_CLUSTER_VERSION,
    purpose: 'authoring-aggregation-only',
    completeSemanticMigration: false,
    summary: { skills: clusters.filter(item => item.root.collection === 'skills').length, passiveSkills: clusters.filter(item => item.root.collection === 'skills' && item.kind === 'passive').length, pieceAbilityGroups: clusters.filter(item => item.root.collection === 'pieces').length, changed: pending.length },
    unmanifested, excluded: excluded.sort(),
    clusters: clusters.map(({ clusterId, kind, root: source, members, coverage, diagnostics }) => ({
      clusterId, kind, root: source, coverage, diagnostics,
      members: members.all.map(({ kind: memberKind, id, role, relation, provenance, evidence, editable }) => ({ kind: memberKind, id, role, relation, provenance, evidence, editable })),
    })),
  }
  // All reads and transformations finish before any source document is written.
  if (write) for (const item of pending) writeFileSync(item.path, `${JSON.stringify(item.content, null, 2)}\n`)
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const write = process.argv.includes('--write')
  const report = migrateSkillClusters(process.cwd(), write)
  if (write) writeFileSync(resolve('docs/qa/RED-252-cluster-coverage.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ ...report.summary, written: write, unmanifested: report.unmanifested, completeSemanticMigration: report.completeSemanticMigration }, null, 2))
}
