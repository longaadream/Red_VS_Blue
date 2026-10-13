import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import type { PieceSkill } from '../../lib/game/piece'
import type { GameplayRecordSchema, GameplayValueType } from '../../lib/skill-graph/module-types'
import { makePiece, makeState } from '../helpers/minimal-state'

function runtime() {
  return createFlowRuntime(makeState(), { playerId: 'player-red' }, 'skill', {})
}

describe('execution local values', () => {
  it('keeps nullable false and zero values while reporting real read/write success', () => {
    const flow = runtime()
    const flag = flow.execution.declare('boolean', [], false)
    const count = flow.execution.declare('number', [], 0)

    expect(flag.success).toBe(true)
    expect(flow.execution.read(flag.handle, 'boolean', [])).toEqual({ value: false, success: true })
    expect(flow.execution.read(count.handle, 'number', [])).toEqual({ value: 0, success: true })
    expect(flow.execution.write(flag.handle, 'boolean', [], true)).toEqual({ success: true })
    expect(flow.execution.read(flag.handle, 'boolean', [])).toEqual({ value: true, success: true })
  })

  it('rejects a handle from another execution without changing the owner value', () => {
    const owner = runtime()
    const foreign = runtime()
    const local = owner.execution.declare('number', [], 4)

    expect(() => foreign.execution.read(local.handle, 'number', [])).toThrow(/当前执行/)
    expect(owner.execution.read(local.handle, 'number', [])).toEqual({ value: 4, success: true })
  })

  it('rejects wrong types before writing and preserves the old value', () => {
    const flow = runtime()
    const local = flow.execution.declare('number', [], 4)

    expect(() => flow.execution.write(local.handle, 'number', [], false)).toThrow()
    expect(flow.execution.read(local.handle, 'number', [])).toEqual({ value: 4, success: true })
  })

  it('does not create a local handle when the initial value is invalid', () => {
    const flow = runtime()

    expect(() => flow.execution.declare('number', [], 'bad')).toThrow()
    expect(() => flow.execution.declare('record', [], undefined)).toThrow()
  })

  it('keeps an omitted initial value uninitialized until a write succeeds', () => {
    const flow = runtime()
    const local = flow.execution.declare('boolean', [])

    expect(() => flow.execution.read(local.handle, 'boolean', [])).toThrow(/尚未赋值/)
    expect(flow.execution.write(local.handle, 'boolean', [], false)).toEqual({ success: true })
    expect(flow.execution.read(local.handle, 'boolean', [])).toEqual({ value: false, success: true })
  })

  it('matches equivalent value types regardless of object key order', () => {
    const flow = runtime()
    const declaredType: GameplayValueType = { kind: 'list', element: 'number' }
    const equivalentType = { element: 'number', kind: 'list' } as GameplayValueType
    const local = flow.execution.declare(declaredType, [], [0])

    expect(flow.execution.read(local.handle, equivalentType, [])).toEqual({ value: [0], success: true })
  })

  it('preserves registered execution handles inside local values', () => {
    const flow = runtime()
    const counter = flow.execution.counter(1)
    const local = flow.execution.declare('record', [], { counter })
    const read = flow.execution.read(local.handle, 'record', [])
    const nested = (read.value as { counter: object }).counter

    expect(nested).toBe(counter)
    expect(flow.execution.readCounter(nested)).toBe(1)
  })

  it('keeps status instance identity through local declare/read before field access and removal', () => {
    const piece = makePiece({ instanceId: 'status-piece', statusTags: [{ id: 'status-1', type: 'marked', name: '标记' }] })
    const battle = makeState({ pieces: [piece] })
    const flow = createFlowRuntime(battle, { playerId: 'player-red', piece }, 'skill', {})
    const handle = flow.status.instances(piece.instanceId).statuses[0]
    const local = flow.execution.declare('status', [], handle)
    const read = flow.execution.read(local.handle, 'status', [])

    expect(read.value).toBe(handle)
    expect(flow.status.fields(read.value as object)).toMatchObject({ id: 'status-1', type: 'marked' })
    expect(flow.status.removeInstance(read.value as object)).toBe(true)
    expect(piece.statusTags).toHaveLength(0)
  })

  it('keeps skill instance identity through local record read before cooldown mutation', () => {
    const skill: PieceSkill = { skillId: 'skill-1', currentCooldown: 0 }
    const piece = makePiece({ instanceId: 'skill-piece', skills: [skill] })
    const battle = makeState({ pieces: [piece] })
    const flow = createFlowRuntime(battle, { playerId: 'player-red', piece }, 'skill', {})
    const handle = flow.skills.instances(piece.instanceId).instances[0]
    const local = flow.execution.declare('record', [], handle)
    const read = flow.execution.read(local.handle, 'record', [])

    expect(read.value).toBe(handle)
    expect(flow.skills.field(read.value as object, 'currentCooldown')).toEqual({ value: 0, defined: true })
    expect(flow.skills.setInstanceCooldown(read.value as object, 3)).toBe(true)
    expect(piece.skills[0].currentCooldown).toBe(3)
  })

  it('keeps captured source identity through local record read', () => {
    const piece = makePiece({ instanceId: 'captured-piece' })
    const battle = makeState({ pieces: [piece] })
    const flow = createFlowRuntime(battle, { playerId: 'player-red', piece }, 'skill', {})
    const handle = flow.effects.captureSource(piece.instanceId)
    const local = flow.execution.declare('record', [], handle)
    const read = flow.execution.read(local.handle, 'record', [])

    expect(read.value).toBe(handle)
    expect(flow.effects.capturedIdentifier(read.value as object)).toBe(piece.instanceId)
  })

  it('uses the closed author record schema and rejects forged handles', () => {
    const flow = runtime()
    const schema: GameplayRecordSchema = {
      id: 'execution-local-test', version: '1', fields: [
        { name: 'enabled', type: 'boolean' },
        { name: 'values', type: { kind: 'list', element: 'number' } },
      ],
    }
    const type: GameplayValueType = { kind: 'record', schema: schema.id }
    const local = flow.execution.declare(type, [schema], { enabled: false, values: [0] })

    expect(flow.execution.read(local.handle, type, [schema])).toEqual({ value: { enabled: false, values: [0] }, success: true })
    expect(() => flow.execution.read(Object.freeze(Object.create(null)), type, [schema])).toThrow(/当前执行/)
    expect(() => flow.execution.write(local.handle, type, [schema], { enabled: false, values: ['bad'] })).toThrow()
    expect(flow.execution.read(local.handle, type, [schema])).toEqual({ value: { enabled: false, values: [0] }, success: true })
  })

  it('rejects unsafe JSON leaves before generic and typed validation can observe them', () => {
    const flow = runtime()
    for (const value of [NaN, Infinity, undefined, () => true, BigInt(1)]) {
      expect(() => flow.execution.declare('record', [], { value })).toThrow()
    }

    let cellReads = 0
    const cell = Object.defineProperties({}, {
      x: { enumerable: true, get: () => { cellReads += 1; return 1 } },
      y: { enumerable: true, value: 2 },
    })
    expect(() => flow.execution.declare('cell', [], cell)).toThrow()
    expect(cellReads).toBe(0)

    let recordReads = 0
    const schema: GameplayRecordSchema = { id: 'getter-record', version: '1', fields: [{ name: 'value', type: 'boolean' }] }
    const typedRecord = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => { recordReads += 1; return true },
    })
    expect(() => flow.execution.declare({ kind: 'record', schema: schema.id }, [schema], typedRecord)).toThrow()
    expect(recordReads).toBe(0)

    const local = flow.execution.declare('record', [], { value: false })
    expect(() => flow.execution.write(local.handle, 'record', [], { value: NaN })).toThrow()
    expect(flow.execution.read(local.handle, 'record', [])).toEqual({ value: { value: false }, success: true })
  })
})
