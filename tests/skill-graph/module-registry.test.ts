import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { createEffectChain, createHealQueueWriter } from '../../lib/game/effect-batch'
import type { PieceInstance } from '../../lib/game/piece'
import type {
  GameplayLiteral,
  GameplayModuleDescriptor,
  GameplayNativeLoweringResult,
  GameplayPort,
  GameplayModuleSurface,
} from '../../lib/skill-graph/module-types'
import { GAMEPLAY_MODULE_GRAPH_VERSION } from '../../lib/skill-graph/module-types'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import {
  GAMEPLAY_MODULE_REGISTRY,
  GAMEPLAY_MODULE_VERSION,
  getGameplayModule,
  getGameplayModuleCatalog,
  gameplayModuleDescriptors,
} from '../../lib/skill-graph/module-registry'

function descriptor(id: string): GameplayModuleDescriptor {
  const value = getGameplayModule(id)
  if (!value) throw new Error(`missing fixture module ${id}`)
  return value
}

function lower(
  id: string,
  surface: GameplayModuleSurface,
  inputs: Record<string, string> = {},
  parameters: Record<string, GameplayLiteral> = {},
): GameplayNativeLoweringResult {
  const entry = descriptor(id)
  return entry.lower({
    surface,
    callId: 'test-call',
    moduleId: entry.id,
    moduleVersion: entry.version,
    inputs,
    parameters,
    outputPorts: entry.outputs,
    emitLiteral: value => JSON.stringify(value),
  })
}

function source(result: GameplayNativeLoweringResult): string {
  return typeof result === 'string'
    ? result
    : 'expression' in result
      ? result.expression
      : `${result.statements};${result.result ?? ''}`
}

function port(entry: GameplayModuleDescriptor, name: string): GameplayPort {
  const value = entry.inputs.find(item => item.name === name) ?? entry.outputs.find(item => item.name === name)
  if (!value) throw new Error(`${entry.id} has no port ${name}`)
  return value
}

describe('gameplay semantic module registry', () => {
  it('contains unique versioned descriptors with closed metadata', () => {
    const ids = gameplayModuleDescriptors.map(entry => entry.id)
    expect(ids.length).toBeGreaterThan(25)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of gameplayModuleDescriptors) {
      expect(entry.version).toBe(GAMEPLAY_MODULE_VERSION)
      expect(entry.id).toMatch(/^[a-z][a-z0-9.-]+$/)
      expect(entry.allowedSurfaces.length).toBeGreaterThan(0)
      expect(entry.effects).toBeDefined()
      expect(typeof entry.lower).toBe('function')
      expect(entry.inputs.every(item => typeof item.name === 'string' && item.type !== 'any')).toBe(true)
      expect(entry.outputs.every(item => typeof item.name === 'string' && item.type !== 'any')).toBe(true)
    }
  })

  it('supports direct, get, resolve, and version-checked lookup', () => {
    const direct = GAMEPLAY_MODULE_REGISTRY['ref.holder']
    expect(direct.id).toBe('ref.holder')
    expect(GAMEPLAY_MODULE_REGISTRY.get?.('ref.holder')?.id).toBe('ref.holder')
    expect(GAMEPLAY_MODULE_REGISTRY.resolve?.('ref.holder', GAMEPLAY_MODULE_VERSION)?.id).toBe('ref.holder')
    expect(GAMEPLAY_MODULE_REGISTRY.get?.('ref.holder', '999')).toBeUndefined()
    expect(getGameplayModule('unknown.module')).toBeUndefined()
  })

  it('publishes JSON-safe editor metadata without trusted lowering functions', () => {
    const catalog = getGameplayModuleCatalog()
    expect(catalog.length).toBe(gameplayModuleDescriptors.length)
    expect(JSON.stringify(catalog)).not.toContain('lower')
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog)
    const mutable = catalog.find(item => item.id === 'ref.holder') as { label: string } | undefined
    expect(mutable).toBeDefined()
    if (mutable) mutable.label = 'changed in editor snapshot'
    expect(descriptor('ref.holder').label).toBe('持有者')
  })

  it('keeps preview to pure arithmetic, comparisons, logic and text', () => {
    for (const entry of gameplayModuleDescriptors) {
      if (entry.allowedSurfaces.includes('preview')) {
        expect(entry.effects.pure).toBe(true)
        expect(entry.effects.previewSafe).toBe(true)
        expect(entry.effects.writes ?? []).toHaveLength(0)
        expect(entry.effects.pending).not.toBe(true)
      }
    }
    expect(descriptor('effect.damage').allowedSurfaces).not.toContain('preview')
    expect(descriptor('choice.target-cell').allowedSurfaces).not.toContain('preview')
  })

  it('lowers opaque refs and named queries through the flow authority facade', () => {
    expect(source(lower('ref.holder', 'skill'))).toBe('flow.refs.holder()')
    expect(source(lower('ref.event-player', 'rule'))).toBe('flow.refs.eventPlayer()')
    expect(source(lower('query.piece', 'skill', { pieceId: 'pieceId' }))).toContain('flow.query.hasPiece(pieceId) ? flow.query.piece(pieceId).instanceId : null')
    expect(source(lower('query.player', 'skill', { playerId: 'ownerId' }))).toContain('flow.query.hasPlayer(ownerId) ? flow.query.player(ownerId).playerId : null')
    expect(source(lower('query.has-piece', 'skill', { pieceId: 'pieceId' }))).toBe('flow.query.hasPiece(pieceId)')
    expect(source(lower('query.has-player', 'skill', { playerId: 'ownerId' }))).toBe('flow.query.hasPlayer(ownerId)')
    expect(descriptor('query.has-piece').inspectReferences).toEqual(['pieceId'])
    expect(descriptor('query.has-player').inspectReferences).toEqual(['playerId'])
    expect(source(lower('query.pieces', 'skill', { originId: 'origin', ownerId: 'owner' }, { relation: 'enemy', range: 3 }))).toContain('flow.query.pieces({')
    expect(source(lower('query.pieces', 'skill', { originId: 'origin' }, { relation: 'all' }))).toContain('relation: undefined')
    expect(source(lower('attribute.read', 'skill', { piece: 'pieceId' }, { attribute: 'attack' }))).toContain('["attack"]')
    expect(source(lower('attribute.text', 'skill', { piece: 'pieceId' }, { attribute: 'name' }))).toContain('["name"]')
    expect(source(lower('resource.read', 'skill', { player: 'playerId' }, { resource: 'chargePoints' }))).toContain('["chargePoints"]')
  })

  it('lowers pure math and comparison modules without runtime or mutable state access', () => {
    expect(source(lower('math.add', 'preview', { left: 'leftValue', right: 'rightValue' }))).toBe('(leftValue + rightValue)')
    expect(source(lower('compare.greater-than', 'preview', { left: 'leftValue', right: 'rightValue' }))).toBe('(leftValue > rightValue)')
    expect(source(lower('logic.not', 'preview', { value: 'flag' }))).toBe('!(flag)')
    expect(source(lower('text.concat', 'preview', { left: 'name', right: 'suffix' }))).toBe('(name + suffix)')
    expect(source(lower('text.from-number', 'preview', { value: 'amount' }))).toBe('String(amount)')
    expect(source(lower('value.number-or-zero', 'preview', { value: 'amount' }))).toBe('Math.max(0, amount ?? 0)')
  })

  it('keeps target selection in the existing static analyzer shape', () => {
    const piece = source(lower('choice.target-piece', 'skill', {}, { range: 4, filter: 'ally' }))
    const cell = source(lower('choice.target-cell', 'skill', {}, { range: 2, filter: 'all' }))
    const pending = source(lower('choice.target-cell', 'pending', {}, { range: 2, filter: 'all' }))
    expect(piece).toContain('type: "piece"')
    expect(piece).toContain('selectTarget({')
    expect(piece).toContain('range: 4')
    expect(piece).toContain('filter: "ally"')
    expect(cell).toContain('type: "grid"')
    expect(cell).toContain('selectTarget({')
    expect(pending).toContain('ctx.flow.choice.target')
  })

  it('routes effects through authoritative damage, heal, position, resource and hand helpers', () => {
    expect(source(lower('effect.damage', 'skill', { source: 'sourceId', target: 'targetId', amount: 'damage' }, { damageType: 'normal', skillId: 'demo-skill' }))).toContain('flow.effects.damage(sourceId, targetId, damage, "physical", "demo-skill")')
    expect(descriptor('effect.damage').parameters?.find(item => item.name === 'damageType')?.enum).toEqual(['normal', 'true', 'toxin'])
    expect(source(lower('effect.heal', 'card', { source: 'sourceId', target: 'targetId', amount: 'heal' }))).toContain('flow.effects.heal(sourceId, targetId, heal, context.skill?.id')
    expect(source(lower('effect.teleport', 'skill', { piece: 'pieceId', destination: 'cell' }, { kind: 'teleport' }))).toContain('flow.effects.move([{pieceId: pieceId, x: (cell).x, y: (cell).y}], "teleport")')
    expect(source(lower('resource.adjust', 'card', { player: 'playerId', amount: 'delta' }, { resource: 'actionPoints' }))).toContain('flow.resources.add(playerId, "actionPoints", delta)')
    expect(source(lower('card.hand-add', 'card', { player: 'playerId' }, { cardId: 'demo-card' }))).toContain('flow.cards.add(playerId, "demo-card")')
  })

  it('uses the existing rule heal queue and event fact readers', () => {
    const heal = source(lower('effect.queue-heal', 'rule', { healer: 'healerId', target: 'targetId', amount: 'amount' }, { skillId: 'rule-reap' }))
    expect(heal).toContain('context.healQueue.push({healer: flow.query.piece(healerId), target: flow.query.piece(targetId), heal: amount, skillId: "rule-reap"})')
    expect(heal).not.toContain('currentHp')
    expect(source(lower('event.read', 'rule'))).toBe('flow.event.read()')
    expect(source(lower('event.actual-damage', 'rule'))).toContain('["actualDamage"]')
  })

  it('constructs statuses and rules from fixed fields and authority calls', () => {
    const status = descriptor('status.apply-piece')
    expect(status.parameters?.map(item => item.name)).toEqual(expect.arrayContaining(['statusId', 'statusType', 'duration', 'relatedRules']))
    const code = source(lower('status.apply-piece', 'skill', { target: 'targetId' }, {
      statusId: 'freeze-id', statusType: 'freeze', duration: 1, relatedRules: ['rule-freeze'],
    }))
    expect(code).toContain('flow.status.add(targetId, {id: "freeze-id"')
    expect(code).toContain('relatedRules: ["rule-freeze"]')
    expect(code).not.toContain('maxStacks: undefined')
    expect(code).not.toContain('G.')
    expect(source(lower('status.remove-piece', 'skill', { target: 'targetId' }, { statusId: 'freeze-id' }))).toContain('flow.status.remove(targetId, "freeze-id", "piece")')
    expect(source(lower('rule.apply-piece', 'rule', { target: 'targetId' }, { ruleId: 'rule-freeze' }))).toContain('flow.rules.add(targetId, "rule-freeze", "piece")')
  })

  it('exposes typed result constructors instead of arbitrary object literals', () => {
    const message = descriptor('result.message')
    expect(message.outputs.map(item => item.name)).toEqual(['success', 'message'])
    expect(source(lower('result.message', 'skill', { message: 'text' }, { success: true }))).toBe('{success: true, message: text}')
    expect(source(lower('result.text', 'skill', { text: 'text' }))).toBe('text')
    expect(source(lower('result.structured', 'skill', { success: 'ok', message: 'text', value: 'damageResult' }))).toBe('{success: ok, message: text, value: damageResult}')
    expect(source(lower('result.value', 'skill', { value: 'damageResult' }))).toBe('{success: true, value: damageResult}')
    expect(descriptor('result.value').inputs[0].type).toBe('record')
    expect(message.parameters?.some(item => item.name === 'source' || item.name === 'path')).toBe(false)
  })

  it('resolves the concrete registry through the semantic compiler', () => {
    const compiled = compileGameplayModuleGraph({
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }],
      body: [
        {
          kind: 'call', id: 'message', module: 'result.message', version: GAMEPLAY_MODULE_VERSION,
          inputs: { message: { kind: 'literal', value: 'ok' } }, parameters: { success: true },
        },
        {
          kind: 'return', id: 'done', values: {
            success: { kind: 'output', node: 'message', port: 'success' },
            message: { kind: 'output', node: 'message', port: 'message' },
          },
        },
      ],
    }, GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.code).toContain('{success: true, message: "ok"}')
    expect(compiled.dependencies).toEqual([{ id: 'result.message', version: GAMEPLAY_MODULE_VERSION, kind: 'native' }])
  })

  it('keeps the authoritative effect result available to downstream typed ports', () => {
    const compiled = compileGameplayModuleGraph({
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }, { name: 'value', type: 'record' }],
      body: [
        { kind: 'call', id: 'source-ref', module: 'ref.holder', version: GAMEPLAY_MODULE_VERSION },
        { kind: 'call', id: 'source', module: 'query.piece', version: GAMEPLAY_MODULE_VERSION, inputs: { pieceId: { kind: 'output', node: 'source-ref', port: 'piece' } } },
        { kind: 'call', id: 'target-ref', module: 'ref.target', version: GAMEPLAY_MODULE_VERSION },
        { kind: 'call', id: 'target', module: 'query.piece', version: GAMEPLAY_MODULE_VERSION, inputs: { pieceId: { kind: 'output', node: 'target-ref', port: 'piece' } } },
        {
          kind: 'call', id: 'damage', module: 'effect.damage', version: GAMEPLAY_MODULE_VERSION,
          inputs: {
            source: { kind: 'output', node: 'source', port: 'piece' },
            target: { kind: 'output', node: 'target', port: 'piece' },
            amount: { kind: 'literal', value: 5 },
          }, parameters: { damageType: 'normal', skillId: 'typed-result-test' },
        },
        {
          kind: 'call', id: 'structured', module: 'result.structured', version: GAMEPLAY_MODULE_VERSION,
          inputs: {
            success: { kind: 'output', node: 'damage', port: 'success' },
            message: { kind: 'literal', value: 'damage complete' },
            value: { kind: 'output', node: 'damage', port: 'result' },
          },
        },
        {
          kind: 'return', id: 'done', values: {
            success: { kind: 'output', node: 'structured', port: 'success' },
            message: { kind: 'output', node: 'structured', port: 'message' },
            value: { kind: 'output', node: 'structured', port: 'value' },
          },
        },
      ],
    }, GAMEPLAY_MODULE_REGISTRY)
    const result = runInNewContext(`${compiled.code}\nexecuteSkill({})`, {
      flow: {
        refs: { holder: () => 'source-id', target: () => 'target-id' },
        query: { hasPiece: () => true, piece: (id: string) => ({ instanceId: id }) },
        effects: { damage: () => ({ success: true, damage: 7, batchId: 'damage-1' }) },
      },
    }) as { success: boolean; message: string; value: Record<string, unknown> }
    expect(result).toEqual({
      success: true,
      message: 'damage complete',
      value: { success: true, damage: 7, batchId: 'damage-1' },
    })
  })

  it('resolves rule heal IDs to Piece objects before using the real heal queue writer', () => {
    const compiled = compileGameplayModuleGraph({
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'rule',
      outputs: [{ name: 'success', type: 'boolean' }],
      body: [
        { kind: 'call', id: 'healer-ref', module: 'ref.holder', version: GAMEPLAY_MODULE_VERSION },
        { kind: 'call', id: 'healer', module: 'query.piece', version: GAMEPLAY_MODULE_VERSION, inputs: { pieceId: { kind: 'output', node: 'healer-ref', port: 'piece' } } },
        { kind: 'call', id: 'target-ref', module: 'ref.target', version: GAMEPLAY_MODULE_VERSION },
        { kind: 'call', id: 'target', module: 'query.piece', version: GAMEPLAY_MODULE_VERSION, inputs: { pieceId: { kind: 'output', node: 'target-ref', port: 'piece' } } },
        {
          kind: 'call', id: 'queued-heal', module: 'effect.queue-heal', version: GAMEPLAY_MODULE_VERSION,
          inputs: {
            healer: { kind: 'output', node: 'healer', port: 'piece' },
            target: { kind: 'output', node: 'target', port: 'piece' },
            amount: { kind: 'literal', value: 3 },
          }, parameters: { skillId: 'rule-queue-test' },
        },
        { kind: 'return', id: 'done', value: { kind: 'literal', value: true } },
      ],
    }, GAMEPLAY_MODULE_REGISTRY)

    const healer = { instanceId: 'healer-id' } as unknown as PieceInstance
    const target = { instanceId: 'target-id' } as unknown as PieceInstance
    const chain = createEffectChain({ actionId: 'module-queue-test', chainId: 'module-queue-test', turn: 1, rootSeed: 1, detached: true })
    const context = { ruleId: 'rule-queue-test', healQueue: createHealQueueWriter(chain) }
    const flow = {
      refs: { holder: () => healer.instanceId, target: () => target.instanceId },
      query: {
        hasPiece: (id: unknown) => id === healer.instanceId || id === target.instanceId,
        piece: (id: string) => id === healer.instanceId ? healer : target,
      },
    }
    const execute = new Function('context', 'flow', compiled.code) as (ruleContext: typeof context, runtime: typeof flow) => unknown

    expect(execute(context, flow)).toBe(true)
    const enqueue = chain.records.find(record => record.type === 'enqueue')
    expect(enqueue?.type).toBe('enqueue')
    if (enqueue?.type !== 'enqueue' || enqueue.request.kind !== 'heal') throw new Error('expected heal enqueue record')
    expect(enqueue.request.healer).toBe(healer)
    expect(enqueue.request.targets).toEqual([target])
    expect(enqueue.request.baseHeal).toBe(3)
    expect(enqueue.request.skillId).toBe('rule-queue-test')
  })

  it('marks nullable context/entity ports explicitly', () => {
    expect(port(descriptor('ref.holder'), 'piece')).toMatchObject({ nullable: true })
    expect(port(descriptor('ref.player'), 'player')).toMatchObject({ nullable: true })
    expect(port(descriptor('query.pieces'), 'originId')).toMatchObject({ optional: true, nullable: true })
    expect(port(descriptor('event.player'), 'value').type).toBe('player')
    expect(port(descriptor('event.actual-damage'), 'value')).toMatchObject({ nullable: true })
    expect(port(descriptor('value.number-or-zero'), 'value')).toMatchObject({ nullable: true })
  })
})
