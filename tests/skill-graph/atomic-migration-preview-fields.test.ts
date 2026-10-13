import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { atomicPreviewFieldRecipe, migratePreviewFieldModules } from '../../lib/skill-graph/atomic-migration-preview-fields'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { PREVIEW_FIELD_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-preview-fields'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayLiteral,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayPort,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const version = '1'

function registryWith(...descriptors: GameplayModuleDescriptor[]): GameplayModuleRegistry {
  const byKey = new Map(descriptors.map(descriptor => [descriptor.id + '@' + descriptor.version, descriptor]))
  return {
    get: (id, requestedVersion) => byKey.get(id + '@' + (requestedVersion ?? version))
      ?? GAMEPLAY_MODULE_REGISTRY.get(id, requestedVersion),
  }
}

function input(name: string): GameplayValue {
  return { kind: 'input', name }
}

function output(node: string, port = 'value'): GameplayValue {
  return { kind: 'output', node, port }
}

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayLiteral>> = {},
  callVersion = version,
): GameplayModuleGraph['body'][number] {
  return { kind: 'call', id, module, version: callVersion, inputs, parameters }
}

function graph(
  surface: GameplayModuleGraph['surface'],
  body: GameplayModuleGraph['body'],
  outputs: GameplayModuleGraph['outputs'] = [{ name: 'value', type: 'number' }],
  inputs: GameplayModuleGraph['inputs'] = surface === 'preview'
    ? [{ name: 'piece', type: 'piece' }, { name: 'skillDef', type: 'content' }]
    : [],
): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface,
    inputs,
    outputs,
    body,
  }
}

function executePreview(code: string, piece: unknown, skillDef: unknown): unknown {
  const calculate = runInNewContext('(' + code + ')') as (piece: unknown, skillDef: unknown, currentCooldown: number) => unknown
  return calculate(piece, skillDef, 0)
}

function executeActive(code: string, battle: unknown): unknown {
  const execute = runInNewContext('(' + code + ')', { battle }) as (context: unknown) => unknown
  return execute({})
}

function compileAlias(
  surface: GameplayModuleGraph['surface'],
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayLiteral>> = {},
  outputType: GameplayPort['type'] = 'number',
): { original: GameplayModuleGraph; migrated: GameplayModuleGraph; registry: GameplayModuleRegistry } {
  const original = graph(surface, [
    call('read', module, inputs, parameters),
    { kind: 'return', id: 'done', value: output('read') },
  ], [{ name: 'value', type: outputType }])
  return {
    original,
    migrated: migratePreviewFieldModules(original),
    registry: registryWith(...PREVIEW_FIELD_GAMEPLAY_MODULES),
  }
}

function compileAndExecute(
  original: GameplayModuleGraph,
  migrated: GameplayModuleGraph,
  registry: GameplayModuleRegistry,
  host: unknown,
  surface: GameplayModuleGraph['surface'],
): { original: unknown; migrated: unknown } {
  const oldCode = compileGameplayModuleGraph(original, GAMEPLAY_MODULE_REGISTRY).code
  const newCode = compileGameplayModuleGraph(migrated, registry).code
  return surface === 'preview'
    ? { original: executePreview(oldCode, (host as { piece?: unknown }).piece, (host as { skillDef?: unknown }).skillDef), migrated: executePreview(newCode, (host as { piece?: unknown }).piece, (host as { skillDef?: unknown }).skillDef) }
    : { original: executeActive(oldCode, host), migrated: executeActive(newCode, host) }
}

describe('preview field and turn alias migration', () => {
  it('keeps generic conversion primitives atomic and closed', () => {
    const toNumber = PREVIEW_FIELD_GAMEPLAY_MODULES.find(module => module.id === 'value.to-number')
    const toBoolean = PREVIEW_FIELD_GAMEPLAY_MODULES.find(module => module.id === 'value.to-boolean')
    expect(toNumber?.parameters).toBeUndefined()
    expect(toBoolean?.inputs[0]).toMatchObject({ type: 'record', optional: true, nullable: true })
    expect(toBoolean?.inputValueTypeBindings).toMatchObject({ value: { parameter: 'valueType' } })
    // The compiler validates the closed type grammar, including records and tuples.
    expect(toBoolean?.parameters?.[0]).toMatchObject({ name: 'valueType', default: 'number' })
    expect(PREVIEW_FIELD_GAMEPLAY_MODULES.some(module => module.id === 'value.falsy-coalesce')).toBe(false)
  })

  it('uses the supplied preview objects for direct piece and skill fields', () => {
    const pieceAlias = compileAlias('preview', 'preview.piece-number', { piece: input('piece') }, { attribute: 'attack' })
    const skillAlias = compileAlias('preview', 'preview.skill-number', { skill: input('skillDef') }, { attribute: 'powerMultiplier' })
    const piece = { attack: 7, instanceId: 'preview-only' }
    const skillDef = { powerMultiplier: 2, id: 'skill-preview-only' }
    expect(compileAndExecute(pieceAlias.original, pieceAlias.migrated, pieceAlias.registry, { piece, skillDef }, 'preview')).toEqual({ original: 7, migrated: 7 })
    expect(compileAndExecute(skillAlias.original, skillAlias.migrated, skillAlias.registry, { piece, skillDef }, 'preview')).toEqual({ original: 2, migrated: 2 })
  })

  it('preserves direct missing fields and Number/NaN compatibility', () => {
    const direct = compileAlias('preview', 'preview.piece-number', { piece: input('piece') }, { attribute: 'attack' })
    const number = compileAlias('preview', 'preview.piece-number-nan', { piece: input('piece') }, { attribute: 'attack' })
    const values: unknown[] = [undefined, null, 0, '7', 'bad', Number.NaN]
    for (const value of values) {
      const directResult = compileAndExecute(direct.original, direct.migrated, direct.registry, { piece: { attack: value }, skillDef: {} }, 'preview')
      const numberResult = compileAndExecute(number.original, number.migrated, number.registry, { piece: { attack: value }, skillDef: {} }, 'preview')
      expect(numberResult.migrated).toEqual(numberResult.original)
      if (typeof value === 'number' && Number.isNaN(value)) {
        expect(directResult.migrated).toBeNaN()
      } else {
        expect(directResult.migrated).toEqual(directResult.original)
      }
    }
  })

  it('preserves falsy zero fallback, including raw truthy scalar values', () => {
    const alias = compileAlias('preview', 'preview.piece-number-or-zero', { piece: input('piece') }, { attribute: 'attack' })
    for (const value of [undefined, null, 0, Number.NaN, '', '7', 4]) {
      const result = compileAndExecute(alias.original, alias.migrated, alias.registry, { piece: { attack: value }, skillDef: {} }, 'preview')
      expect(result.migrated).toEqual(result.original)
    }
  })

  it('keeps maxHp direct/stats/fallback ordering and skill text reads', () => {
    const maxHp = compileAlias('preview', 'preview.piece-max-hp', { piece: input('piece') }, { fallback: 18 })
    const cases = [
      { maxHp: 20, stats: { maxHp: 30 } },
      { maxHp: 0, stats: { maxHp: 30 } },
      { maxHp: Number.NaN, stats: { maxHp: 30 } },
      { maxHp: undefined, stats: { maxHp: 0 } },
      { maxHp: null, stats: { maxHp: '31' } },
      { stats: undefined },
    ]
    for (const piece of cases) {
      const result = compileAndExecute(maxHp.original, maxHp.migrated, maxHp.registry, { piece, skillDef: {} }, 'preview')
      expect(result.migrated).toEqual(result.original)
    }
    const text = compileAlias('preview', 'preview.skill-text', { skill: input('skillDef') }, { attribute: 'description' }, 'string')
    for (const description of ['text', '', undefined, null]) {
      const result = compileAndExecute(text.original, text.migrated, text.registry, { piece: {}, skillDef: { description } }, 'preview')
      expect(result.migrated).toEqual(result.original)
    }
  })

  it('uses a first matching status tag and preserves status fallback values', () => {
    const alias = compileAlias('preview', 'preview.piece-status-number', { piece: input('piece') }, { statusType: 'tracked', attribute: 'intensity' })
    const cases = [
      { statusTags: [{ type: 'other', intensity: 1 }, { type: 'tracked', intensity: 0 }, { type: 'tracked', intensity: 7 }] },
      { statusTags: [{ type: 'tracked', intensity: Number.NaN }] },
      { statusTags: [{ type: 'tracked', intensity: '7' }] },
      { statusTags: [] },
      { statusTags: null },
      {},
    ]
    for (const piece of cases) {
      const result = compileAndExecute(alias.original, alias.migrated, alias.registry, { piece, skillDef: {} }, 'preview')
      expect(result.migrated).toEqual(result.original)
    }
  })

  it('preserves raw turn conversion and falsy-zero turn fallback', () => {
    const number = compileAlias('skill', 'event.battle-turn-number')
    const zero = compileAlias('skill', 'followup.turn-number-or-zero')
    for (const turn of [
      { turnNumber: 5 },
      { turnNumber: 0 },
      { turnNumber: null },
      { turnNumber: '6' },
      { turnNumber: 'bad' },
      { turnNumber: Number.NaN },
      {},
      null,
      undefined,
    ]) {
      const battle = { turn }
      const numberResult = compileAndExecute(number.original, number.migrated, number.registry, battle, 'skill')
      const zeroResult = compileAndExecute(zero.original, zero.migrated, zero.registry, battle, 'skill')
      expect(numberResult.migrated).toEqual(numberResult.original)
      expect(zeroResult.migrated).toEqual(zeroResult.original)
    }
  })

  it('keeps aliases out of the migrated graph and rejects open preview field access', () => {
    const alias = compileAlias('preview', 'preview.piece-number-nan', { piece: input('piece') }, { attribute: 'attack' })
    const zero = compileAlias('preview', 'preview.piece-number-or-zero', { piece: input('piece') }, { attribute: 'attack' })
    const modules: string[] = []
    const visit = (body: readonly GameplayModuleGraph['body'][number][]): void => {
      for (const statement of body) {
        if (statement.kind === 'call') modules.push(statement.module)
        if (statement.kind === 'if') { visit(statement.then); if (statement.else) visit(statement.else) }
        if (statement.kind === 'collection') visit(statement.body)
      }
    }
    visit(alias.migrated.body)
    visit(zero.migrated.body)
    expect(modules).not.toContain('preview.piece-number-nan')
    expect(modules).not.toContain('value.falsy-coalesce')
    expect(modules).toContain('preview.piece-field')
    expect(modules).toContain('value.to-number')
    expect(modules).toContain('value.to-boolean')
    expect(modules).toContain('logic.select')

    const openField = graph('preview', [
      call('read', 'preview.piece-field', { piece: input('piece') }, { field: 'open' }),
      { kind: 'return', id: 'done', value: output('read') },
    ])
    expect(() => compileGameplayModuleGraph(openField, registryWith(...PREVIEW_FIELD_GAMEPLAY_MODULES))).toThrow(/field|parameter/)
  })

  it('leaves malformed compatibility calls unchanged for diagnostics', () => {
    const source = graph('preview', [
      call('read', 'preview.piece-number', { piece: input('piece') }, { attribute: 'not-closed' }),
      { kind: 'return', id: 'done', value: output('read') },
    ])
    expect(migratePreviewFieldModules(source)).toEqual(source)
    expect(atomicPreviewFieldRecipe(source.body[0] as Extract<GameplayModuleGraph['body'][number], { kind: 'call' }>, () => 'fresh')).toBeUndefined()
  })
})
