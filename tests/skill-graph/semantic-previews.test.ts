/* eslint-disable @typescript-eslint/no-explicit-any -- frozen JSON fixtures are intentionally untyped. */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildSemanticPreviewGraph,
  parseSemanticPreview,
  runSemanticPreviewMigrations,
  SEMANTIC_PREVIEW_GAMEPLAY_REGISTRY,
} from '../../scripts/migrate-semantic-previews'
import { compileGameplayModuleGraph, compileGameplayModuleGraphV2 } from '../../lib/skill-graph/module-document'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'

type JsonRecord = Record<string, any>

const baseline = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')) as {
  entries: Record<string, JsonRecord>
  baseSha: string
}

const remainingPreviewIds = [
  'skills/akaza-annihilation',
  'skills/akaza-disorder',
  'skills/akaza-flash-step',
  'skills/arthas-frostmourne',
  'skills/blackwidow-lethal-strike',
  'skills/blizzard',
  'skills/death-blossom',
  'skills/earthshatter',
  'skills/edgar-fisticuffs',
  'skills/frostbolt',
  'skills/hashirama-edo-wood-dragon',
  'skills/hashirama-edo-wood-spike',
  'skills/hellfire-shotgun',
  'skills/hidan-sacrifice',
  'skills/ichigo-black-getsuga-tensho',
  'skills/ichigo-getsuga-tensho',
  'skills/illidan-blade-dash',
  'skills/itachi-totsuka-blade',
  'skills/kenshin-amakakeru',
  'skills/kenshin-ryusosen',
  'skills/kenshin-ryutsuisen',
  'skills/kiljaedan-fel-fire',
  'skills/muzan-blood-whip',
  'skills/muzan-demon-body',
  'skills/naruto-rasengan',
  'skills/rafaam-temporal-distortion',
  'skills/rocket-punch',
  'skills/sasuke-chidori',
  'skills/shelly-shotgun',
  'skills/shelly-super-shell',
  'skills/shishio-flame-spirit',
  'skills/shishio-infinite-blade',
  'skills/venom-claw-rend',
] as const

const protectedPreviewIds = [
  'skills/minato-rasengan',
  'skills/rafaam-curse-amplify',
  'skills/turalyon-expedition-order',
  'skills/turalyon-grand-crusade',
] as const

const fixtureBaseline = {
  baseSha: baseline.baseSha,
  entries: Object.fromEntries([...remainingPreviewIds, ...protectedPreviewIds].map(id => [id, baseline.entries[id]])),
}

let fixtureRoot = ''

function createFixture(): string {
  const root = join(tmpdir(), `red-252-semantic-previews-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  for (const id of [...remainingPreviewIds, ...protectedPreviewIds]) {
    const file = join(root, 'data', `${id}.json`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(baseline.entries[id], null, 2) + '\n', 'utf8')
  }
  return root
}

function migrationRunForFixture() {
  return runSemanticPreviewMigrations(fixtureRoot, fixtureBaseline)
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => clone(item)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T
  return value
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  }
  return value
}

function execute(source: string, piece: JsonRecord, skillDef: JsonRecord, currentCooldown: number | undefined): unknown {
  const calculate = new Function(`${source}; return calculatePreview;`)() as (piece?: unknown, skillDef?: unknown, currentCooldown?: unknown) => unknown
  return calculate(piece, skillDef, currentCooldown)
}

const variedInputs: readonly (readonly [JsonRecord, JsonRecord, number | undefined])[] = [
  [
    { attack: 12, defense: 4, moveRange: 3, currentHp: 17, maxHp: 20, statusTags: [], source: 'red', target: 'blue' },
    { description: '普通技能', powerMultiplier: 1.25, actionPointCost: 1, chargeCost: 0, cooldown: 2 },
    2,
  ],
  [
    { attack: 0, defense: 0, moveRange: 0, currentHp: 0, maxHp: 0, statusTags: [], source: 'red', target: 'blue' },
    { description: '', powerMultiplier: 0, actionPointCost: 0, chargeCost: 0, cooldown: 0 },
    0,
  ],
  [
    { attack: 2.5, defense: -1.5, moveRange: 1.5, currentHp: 7.5, stats: { maxHp: 20 }, statusTags: [{ type: 'shishio-kills', intensity: 1.25 }], source: 'red', target: 'blue' },
    { description: '小数技能', powerMultiplier: 0.75, actionPointCost: 0.5, chargeCost: 1.5, cooldown: 0.25 },
    0.5,
  ],
  [
    { defense: 4, moveRange: 3, statusTags: [{ type: 'shishio-kills' }], source: 'red', target: 'blue' },
    { actionPointCost: 1, chargeCost: 0, cooldown: 1 },
    undefined,
  ],
  [
    { attack: -3, defense: 2, moveRange: 0, currentHp: 15, stats: { maxHp: 30 }, statusTags: [{ type: 'shishio-kills', intensity: 2 }], source: 'red', target: 'blue' },
    { description: '边界技能', powerMultiplier: -0.5, actionPointCost: -1, chargeCost: 2, cooldown: -1 },
    -1,
  ],
]

describe('RED-252 ordinary semantic previews', () => {
  beforeEach(() => { fixtureRoot = createFixture() })
  afterEach(() => { rmSync(fixtureRoot, { recursive: true, force: true }); fixtureRoot = '' })

  it('discovers every ordinary candidate and reports protected sources without blockers', () => {
    const migrationRun = migrationRunForFixture()
    expect(baseline.baseSha).toBe('082166c6b803b2e838bce5f0f6824c5bbc714dd6')
    expect(migrationRun.coverage).toEqual({ ordinaryCandidates: 33, ready: 33, alreadyMigrated: 0, skipped: 4, blocked: 0 })
    expect(migrationRun.reports.filter(report => report.status === 'skipped').map(report => report.id).sort()).toEqual([
      'skills/minato-rasengan',
      'skills/rafaam-curse-amplify',
      'skills/turalyon-expedition-order',
      'skills/turalyon-grand-crusade',
    ])
  })

  it('preserves frozen preview behavior for varied, missing, zero, fractional, and status inputs', () => {
    const migrationRun = migrationRunForFixture()
    for (const migration of migrationRun.migrations) {
      const source = baseline.entries[migration.id].previewCode as string
      const compiled = compileGameplayModuleGraph(migration.build(), SEMANTIC_PREVIEW_GAMEPLAY_REGISTRY)
      const legacyCompiled = compileGameplayModuleGraphV2(migration.build(), SEMANTIC_PREVIEW_GAMEPLAY_REGISTRY)
      for (const [pieceBefore, skillBefore, cooldown] of variedInputs) {
        const legacyPiece = freeze(clone(pieceBefore))
        const legacySkill = freeze(clone(skillBefore))
        const graphPiece = freeze(clone(pieceBefore))
        const graphSkill = freeze(clone(skillBefore))
        const beforePiece = clone(graphPiece)
        const beforeSkill = clone(graphSkill)
        const expected = execute(source, legacyPiece, legacySkill, cooldown)
        const actual = execute(compiled.code, graphPiece, graphSkill, cooldown)
        expect(execute(legacyCompiled.code, graphPiece, graphSkill, cooldown), migration.id + ' v2 compatibility').toEqual(expected)
        // V3 must not turn a missing captured attack into a damage array of NaN.
        const distanceValues = (expected as JsonRecord | undefined)?.expectedValues?.damageByDistance
        if (Array.isArray(distanceValues) && distanceValues.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value)) && graphPiece.attack === undefined) expect(actual).toBeUndefined()
        else expect(actual, migration.id).toEqual(expected)
        expect(graphPiece, `${migration.id} mutated piece input`).toEqual(beforePiece)
        expect(graphSkill, `${migration.id} mutated skill input`).toEqual(beforeSkill)
      }
    }
  })

  it('keeps the author graph closed to paths, callbacks, and source expressions', () => {
    const migrationRun = migrationRunForFixture()
    for (const migration of migrationRun.migrations) {
      const graph = buildSemanticPreviewGraph(migration.source)
      const serialized = JSON.stringify(graph)
      expect(serialized).not.toMatch(/invoke|callback|source|path|syntaxIR/i)
      for (const statement of graph.body) {
        if (statement.kind !== 'call') continue
        const getDescriptor = SEMANTIC_PREVIEW_GAMEPLAY_REGISTRY.get
        if (!getDescriptor) throw new Error('semantic preview registry has no descriptor lookup')
        expect(getDescriptor(statement.module, statement.version)).toBeDefined()
      }
    }
    expect(parseSemanticPreview("function calculatePreview(piece) { return { description: 'x', expectedValues: { damage: invoke(piece.attack) } }; }")).toMatchObject({ kind: 'skip' })
    expect(parseSemanticPreview("function calculatePreview(piece) { return { description: 'x', expectedValues: { damage: piece.stats.maxHp } }; }")).toMatchObject({ kind: 'skip' })
    expect(parseSemanticPreview("function calculatePreview(piece) { return { description: 'x', expectedValues: { damage: Math.round(piece.attack) } }; }")).toMatchObject({ kind: 'skip' })
  })

  it('does not replace an authored graph on rerun', () => {
    const firstRun = migrationRunForFixture()
    for (const [file, document] of firstRun.documents) writeFileSync(file, JSON.stringify(document, null, 2) + '\n', 'utf8')
    const rerun = migrationRunForFixture()
    expect(rerun.coverage).toEqual({ ordinaryCandidates: 0, ready: 0, alreadyMigrated: 33, skipped: 4, blocked: 0 })
    expect(rerun.reports.some(report => report.status === 'already-migrated')).toBe(true)
  })

  it('blocks a changed executable source before producing migration documents', () => {
    const id = remainingPreviewIds[0]
    const file = join(fixtureRoot, 'data', `${id}.json`)
    const document = JSON.parse(readFileSync(file, 'utf8')) as JsonRecord
    document.previewCode = String(document.previewCode).replace('选择一个正方向', '作者改写的预览')
    writeFileSync(file, JSON.stringify(document, null, 2) + '\n', 'utf8')
    const run = runSemanticPreviewMigrations(fixtureRoot, fixtureBaseline, [id])
    expect(run.coverage).toEqual({ ordinaryCandidates: 1, ready: 0, alreadyMigrated: 0, skipped: 0, blocked: 1 })
    expect(run.documents.size).toBe(0)
    expect(run.reports[0].reason).toMatch(/author executable differs from frozen baseline/)
  })

  it('compiles every persisted ordinary preview graph with the shared registry', () => {
    for (const id of remainingPreviewIds) {
      const document = JSON.parse(readFileSync(join('data', `${id}.json`), 'utf8')) as JsonRecord
      const graph = (document.gameplayModules as JsonRecord).entries as JsonRecord
      const previewEntry = graph.previewCode as JsonRecord
      expect(() => compileGameplayModuleGraph(previewEntry.graph, GAMEPLAY_MODULE_REGISTRY), id).not.toThrow()
    }
  })
})
