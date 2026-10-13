/* eslint-disable @typescript-eslint/no-explicit-any -- frozen migration data is intentionally data-shaped. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  buildConstantPreviewGraph,
  buildConstantResultGraph,
  discoverSemanticConstantMigrations,
  parseConstantReturn,
} from '@/scripts/migrate-semantic-constants'
import {
  assertGameplayModuleDocument,
  compileGameplayModuleGraph,
} from '@/lib/skill-graph/module-document'
import { buildSemanticPreviewGraph } from '@/scripts/migrate-semantic-previews'
import { GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-registry'

type JsonRecord = Record<string, any>
type Fixture = { entries: Record<string, JsonRecord> }

const root = process.cwd()
const fixture = JSON.parse(
  readFileSync(join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8'),
) as Fixture

const RESULT_IDS = [
  'skills/akaza-fighting-spirit',
  'skills/blood-echo',
  'skills/colt-big-stride',
  'skills/grimmjow-destruction-instinct',
  'skills/grimmjow-hunting-instinct',
  'skills/grimmjow-resurreccion',
  'skills/hashirama-edo-regen',
  'skills/muzan-flesh-regeneration',
  'skills/muzan-parasitism',
  'skills/naruto-vanguard',
  'skills/obito-grudge',
  'skills/rafaam-curse-ward',
  'skills/shelly-bandage',
  'skills/shishio-combustion-passive',
  'skills/soul-fracture',
  'skills/ulquiorra-high-speed-regeneration',
  'skills/ulquiorra-resurreccion',
] as const

const PREVIEW_IDS = [
  'skills/arthas-lich-covenant',
  'skills/biotic-grenade',
  'skills/elune-blessing',
  'skills/hidan-blood-oath',
  'skills/kiljaedan-soul-drain',
  'skills/naruto-sage-mode',
  'skills/naruto-shadow-clone',
  'skills/obito-space-time',
  'skills/sasuke-amaterasu',
  'skills/sasuke-indra-arrow',
  'skills/shadow-bolt',
  'skills/shield-of-light',
  'skills/sleep-dart',
  'skills/velen-fate-shelter',
  'skills/velen-holy-prophecy',
  'skills/venom-symbiote-drag',
  'skills/watcher-ultimate',
] as const

const TYPED_PREVIEW_IDS = [
  'skills/arthas-icebound-fortitude',
  'skills/blackwidow-lethal-toxin',
  'skills/divine-blessing',
  'skills/edgar-pogo-jump',
  'skills/hardy-block',
  'skills/hashirama-edo-sage-buddha',
  'skills/holy-light-descend',
  'skills/ichigo-bankai-tensa-zangetsu',
  'skills/illidan-metamorphosis',
  'skills/itachi-amaterasu',
  'skills/itachi-tsukuyomi',
  'skills/light-extraction',
  'skills/muru-lament',
  'skills/nano-boost',
  'skills/obito-ally-teleport',
  'skills/sasuke-kagutsuchi',
  'skills/sasuke-susanoo',
  'skills/shadow-step',
  'skills/tirion-holy-recall',
  'skills/velen-thousand-futures-ultimate',
  'skills/venom-host-transfer',
] as const

function runSkill(source: string, context: Record<string, unknown> = {}): unknown {
  const factory = new Function(`${source}; return executeSkill;`) as () => (value: unknown) => unknown
  return factory()(context)
}

function runPreview(source: string): unknown {
  const factory = new Function(`${source}; return calculatePreview;`) as () => (...args: unknown[]) => unknown
  return factory()({}, {}, undefined)
}

describe('RED-252 semantic constant migration', () => {
  it('preserves a direct rule return and its blocking flag without accepting script statements', () => {
    const source = 'return { success: true, blocked: true };'
    expect(parseConstantReturn(source)).toMatchObject({ kind: 'constant', functionName: '<rule-body>', value: { success: true, blocked: true } })
    const graph = buildConstantResultGraph({ success: true, blocked: true }, 'rule')
    expect(new Function(compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code)()).toEqual(new Function(source)())
    expect(parseConstantReturn('battle.pieces=[]; return {success:true};').kind).toBe('skip')
  })
  it('accepts only a single JSON-literal return and explains dynamic skips', () => {
    expect(parseConstantReturn('function executeSkill() { return { success: false, message: "固定失败" }; }')).toEqual({
      kind: 'constant',
      functionName: 'executeSkill',
      value: { success: false, message: '固定失败' },
    })
    expect(parseConstantReturn('function executeSkill() { const message = "动态"; return { success: true, message }; }')).toEqual({
      kind: 'skip',
      reason: 'function body has more than one statement',
    })
  })

  it('uses the public result module and preserves omitted message fields', () => {
    const withMessage = buildConstantResultGraph({ success: false, message: '固定失败' }, 'triggerSkill')
    const withoutMessage = buildConstantResultGraph({ success: true }, 'triggerSkill')
    const withMessageCode = compileGameplayModuleGraph(withMessage, GAMEPLAY_MODULE_REGISTRY).code
    const withoutMessageCode = compileGameplayModuleGraph(withoutMessage, GAMEPLAY_MODULE_REGISTRY).code

    expect(withMessage.body[0]).toMatchObject({ module: 'result.message', parameters: { success: false } })
    expect(withMessageCode).toContain('function executeSkill')
    expect(runSkill(withMessageCode)).toEqual({ success: false, message: '固定失败' })
    expect(runSkill(withoutMessageCode)).toEqual({ success: true })
  })

  it('matches every migrated fixed result against the frozen legacy source', () => {
    for (const id of RESULT_IDS) {
      const entry = fixture.entries[id]
      const parsed = parseConstantReturn(entry.code)
      expect(parsed.kind, id).toBe('constant')
      if (parsed.kind !== 'constant') continue
      const graph = buildConstantResultGraph(parsed.value, 'triggerSkill')
      const generated = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
      expect(runSkill(generated), id).toEqual(runSkill(entry.code))

      const document = JSON.parse(readFileSync(join(root, 'data', `${id}.json`), 'utf8')) as JsonRecord
      assertGameplayModuleDocument(document)
      expect(document.gameplayModules.entries.code.graph).toEqual(graph)
    }
  })

  it('matches every migrated fixed preview against the frozen legacy source', () => {
    for (const id of PREVIEW_IDS) {
      const entry = fixture.entries[id]
      const parsed = parseConstantReturn(entry.previewCode)
      expect(parsed.kind, id).toBe('constant')
      if (parsed.kind !== 'constant') continue
      const graph = buildConstantPreviewGraph(parsed.value)
      const generated = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
      expect(runPreview(generated), id).toEqual(runPreview(entry.previewCode))

      const document = JSON.parse(readFileSync(join(root, 'data', `${id}.json`), 'utf8')) as JsonRecord
      assertGameplayModuleDocument(document)
      expect(runPreview(document.previewCode), id).toEqual(runPreview(entry.previewCode))
      expect(document.gameplayModules.entries.previewCode.graph, id).toEqual(id === 'skills/elune-blessing' ? buildSemanticPreviewGraph(entry.previewCode) : graph)
    }
  })

  it('represents unsupported expectedValues with closed record schemas', () => {
    const parsed = parseConstantReturn(fixture.entries['skills/edgar-pogo-jump'].previewCode)
    expect(parsed.kind).toBe('constant')
    if (parsed.kind !== 'constant') return
    const graph = buildConstantPreviewGraph(parsed.value)
    const expectedValuesSchema = graph.schemas?.find(schema => schema.fields.some(field => field.name === 'area'))
    const resultSchema = graph.schemas?.find(schema => schema.fields.some(field => field.name === 'expectedValues'))
    expect(expectedValuesSchema).toBeDefined()
    expect(resultSchema?.fields.find(field => field.name === 'expectedValues')?.type).toEqual({
      kind: 'record',
      schema: `${expectedValuesSchema?.id}@1`,
    })
    expect(graph.body.filter(statement => statement.kind === 'record.create')).toHaveLength(2)
    expect(graph.body.some(statement => statement.kind === 'call' && statement.module === 'preview.result')).toBe(false)

    const generated = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
    expect(runPreview(generated)).toEqual(runPreview(fixture.entries['skills/edgar-pogo-jump'].previewCode))
  })

  it('matches every typed fixed preview against the frozen legacy source', () => {
    for (const id of TYPED_PREVIEW_IDS) {
      const entry = fixture.entries[id]
      const parsed = parseConstantReturn(entry.previewCode)
      expect(parsed.kind, id).toBe('constant')
      if (parsed.kind !== 'constant') continue
      const graph = buildConstantPreviewGraph(parsed.value)
      expect(graph.schemas?.length, id).toBeGreaterThanOrEqual(2)
      const generated = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
      expect(runPreview(generated), id).toEqual(runPreview(entry.previewCode))

      const document = JSON.parse(readFileSync(join(root, 'data', `${id}.json`), 'utf8')) as JsonRecord
      assertGameplayModuleDocument(document)
      expect(document.gameplayModules.entries.previewCode.graph, id).toEqual(graph)
    }
  })

  it('finds the fixed preview candidate without broadening the AST rule', () => {
    const preview = fixture.entries['skills/fel-blessing'].previewCode as string
    const parsed = parseConstantReturn(preview)
    expect(parsed.kind).toBe('constant')
    if (parsed.kind !== 'constant') return
    const graph = buildConstantPreviewGraph(parsed.value)
    expect(graph.surface).toBe('preview')
    expect(graph.outputs?.map(output => output.name)).toEqual(['result'])
    expect(graph.body[0]).toMatchObject({ kind: 'call', module: 'preview.result' })
  })

  it('records multi-statement previews as skipped instead of executing old source', () => {
    const parsed = parseConstantReturn(fixture.entries['skills/light-of-the-light'].previewCode as string)
    expect(parsed).toEqual({
      kind: 'skip',
      reason: 'function body has more than one statement',
    })
    const discovery = discoverSemanticConstantMigrations(root, fixture as unknown as JsonRecord)
    expect(discovery.sourceReports).toContainEqual(expect.objectContaining({
      id: 'skills/light-of-the-light',
      field: 'previewCode',
      status: 'skipped',
      reason: 'function body has more than one statement',
    }))
  })
})
