import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { createContext, Script } from 'node:vm'
import { join, resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { preparePublicSkillAction, previewBattleAction } from '@/lib/game/skill-preview'
import { isCanonicalPureTargetValidationRule } from '@/lib/game/public-rule-source'
import { prepareAction, type TargetRef } from '@/lib/game/targeting'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

vi.mock('@/lib/game/skills', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/game/skills')>()
  const customStatusTags: Record<string, unknown> = {
    'red250-unknown-status': { id: 'unknown', type: 'skill-rule', rule: 'rule-red250-unknown' },
    'red250-effectful-status': {
      id: 'effectful', type: 'skill-rule', rule: 'rule-spiritual-pressure', effect: 'forbidden',
    },
  }
  return {
    ...actual,
    loadSkillById: (skillId: string, throwOnFailure?: boolean) => {
      const statusTag = customStatusTags[skillId]
      if (statusTag) {
        const base = actual.loadSkillById('ulquiorra-black-cero', throwOnFailure)
        return base ? { ...base, id: skillId, statusTag } : null
      }
      return actual.loadSkillById(skillId, throwOnFailure)
    },
  }
})

function blackCeroState(options: {
  sourceAttack?: number
  targetAttack?: number
  targetX?: number
  targetY?: number
  transformed?: boolean
} = {}) {
  const source = asPieceInstance(makePiece({
    instanceId: 'red250-ulquiorra',
    templateId: 'dark-ulquiorra',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 0,
    y: 0,
    attack: options.sourceAttack ?? 4,
    skills: [{ skillId: 'ulquiorra-black-cero', currentCooldown: 0, usesRemaining: -1 }],
    statusTags: options.transformed === false ? [] : [{
      id: 'red250-resurreccion',
      type: 'resurreccion',
      name: '归刃',
      visible: true,
      currentDuration: -1,
      currentUses: -1,
      intensity: 1,
      stacks: 1,
    }],
  }))
  const target = asPieceInstance(makePiece({
    instanceId: 'red250-target',
    templateId: 'test-enemy',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: options.targetX ?? 1,
    y: options.targetY ?? 0,
    attack: options.targetAttack ?? 2,
    currentHp: 30,
    maxHp: 30,
  }))
  const state = makeState({ pieces: [source, target] })
  state.pieces = [source, target]
  state.skillsById = {
    'ulquiorra-black-cero': JSON.parse(
      readFileSync('data/skills/ulquiorra-black-cero.json', 'utf8'),
    ),
  }
  return state
}

function blackCeroAction(state: ReturnType<typeof blackCeroState>, target: TargetRef = {
  type: 'piece', pieceId: 'red250-target',
}) {
  const draft = {
    type: 'useBasicSkill' as const,
    playerId: 'player-red',
    pieceId: 'red250-ulquiorra',
    skillId: 'ulquiorra-black-cero',
  }
  const prepared = prepareAction(state, draft)
  if (prepared.kind !== 'needTarget') throw new Error(`expected black cero target prompt, got ${prepared.kind}`)
  expect(prepared.candidates).toContainEqual(target)
  return {
    ...draft,
    ...(target.type === 'piece' ? { targetPieceId: target.pieceId } : { targetX: target.x, targetY: target.y }),
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  }
}

describe('RED-250 black cero public preview', () => {
  it('matches the real double attack settlement without mutating the source state', () => {
    const state = blackCeroState()
    const action = blackCeroAction(state)
    const before = JSON.stringify(state)
    const settled = runBattleAction(structuredClone(state), action, { rootSeed: 250 }).state
    const preview = previewBattleAction(state, action, 'player-red')

    expect(preview.status).toBe('ready')
    if (preview.status !== 'ready') return
    expect(preview.snapshot.pieces.find(piece => piece.instanceId === 'red250-target')?.currentHp)
      .toBe(settled.pieces.find(piece => piece.instanceId === 'red250-target')?.currentHp)
    expect(preview.snapshot.pieces.find(piece => piece.instanceId === 'red250-target')?.currentHp).toBe(22)
    expect(preview.snapshot.players.find(player => player.playerId === 'player-red')?.actionPoints)
      .toBe(settled.players.find(player => player.playerId === 'player-red')?.actionPoints)
    expect(preview.events.some(event => event.kind === 'damage')).toBe(true)
    expect(preparePublicSkillAction(state, action, 'player-red').status).toBe('ready')
    expect(JSON.stringify(state)).toBe(before)
  })

  it('keeps the canonical browser engine preview available', () => {
    const context = createContext({
      require: createRequire(resolve('package.json')),
      process,
      console: { error: () => undefined, log: () => undefined, warn: () => undefined },
      TextEncoder,
      TextDecoder,
      window: {},
    })
    new Script(readFileSync('data/pages/js/game-engine.js', 'utf8')).runInContext(context)
    const browserPreview = (context.GameEngine as {
      previewBattleAction: typeof previewBattleAction
    }).previewBattleAction
    const state = blackCeroState()
    const action = blackCeroAction(state)
    const result = browserPreview(state, action, 'player-red')

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.snapshot.pieces.find(piece => piece.instanceId === 'red250-target')?.currentHp).toBe(22)
  })

  it.each([
    ['untransformed', { transformed: false }],
    ['equal attack', { targetAttack: 4 }],
    ['higher attack', { targetAttack: 5 }],
    ['out of range', { targetX: 3 }],
  ])('rejects %s targets before preview execution', (_label, options) => {
    const state = blackCeroState(options)
    const draft = {
      type: 'useBasicSkill' as const,
      playerId: 'player-red',
      pieceId: 'red250-ulquiorra',
      skillId: 'ulquiorra-black-cero',
    }
    const prepared = prepareAction(state, draft)
    if ('transformed' in options && options.transformed === false) {
      expect(prepared.kind).toBe('invalid')
    } else {
      expect(prepared.kind).toBe('needTarget')
      if (prepared.kind !== 'needTarget') return
      expect(prepared.candidates).not.toContainEqual({ type: 'piece', pieceId: 'red250-target' })
    }
    expect(previewBattleAction(state, {
      ...draft,
      targetPieceId: 'red250-target',
      selectionId: prepared.kind === 'needTarget' ? prepared.selectionId : 'invalid-selection',
      stateRevision: prepared.kind === 'needTarget' ? prepared.stateRevision : 0,
    }, 'player-red').status).toBe('unavailable')
  })

  it.each([
    ['unknown', 'red250-unknown-status'],
    ['effectful', 'red250-effectful-status'],
  ])('fails closed for a %s statusTag rule source', (_label, skillId) => {
    const state = blackCeroState()
    const source = state.pieces[0]
    source.skills = [{ skillId, currentCooldown: 0, usesRemaining: -1 }]
    state.skillsById = {
      [skillId]: {
        ...state.skillsById['ulquiorra-black-cero'],
        id: skillId,
      },
    }
    const result = previewBattleAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: source.instanceId,
      skillId,
      targetPieceId: 'red250-target',
      selectionId: 'forged-selection',
      stateRevision: 0,
    }, 'player-red')
    expect(result.status).toBe('unavailable')
    if (skillId === 'red250-effectful-status') {
      const draft = {
        type: 'useBasicSkill' as const,
        playerId: 'player-red',
        pieceId: source.instanceId,
        skillId,
      }
      const prepared = prepareAction(state, draft)
      if (prepared.kind !== 'needTarget') throw new Error(`expected status-tag target prompt, got ${prepared.kind}`)
      const continuation = preparePublicSkillAction(state, {
        ...draft,
        targetPieceId: 'red250-target',
        selectionId: prepared.selectionId,
        stateRevision: prepared.stateRevision,
        skillChoices: [],
      }, 'player-red')
      expect(continuation.status).toBe('unavailable')
    }
  })

  it('proves only the canonical pure target rule and rejects a mixed execution source', () => {
    expect(isCanonicalPureTargetValidationRule('rule-spiritual-pressure')).toBe(true)
    expect(isCanonicalPureTargetValidationRule('rule-red250-unknown')).toBe(false)
    expect(isCanonicalPureTargetValidationRule('rule-ulquiorra-resurreccion')).toBe(false)

    const profileRoot = mkdtempSync(join(tmpdir(), 'rvb-red250-pure-rule-'))
    const rulesRoot = join(profileRoot, 'data', 'rules')
    mkdirSync(rulesRoot, { recursive: true })
    const mixedRule = {
      ...JSON.parse(readFileSync('data/rules/rule-spiritual-pressure.json', 'utf8')),
      trigger: { type: 'afterSkillUsed' },
      skillCode: 'return { success: true }',
    }
    writeFileSync(join(rulesRoot, 'rule-spiritual-pressure.json'), JSON.stringify(mixedRule))
    const previousProfileRoot = process.env.RVB_PROFILE_ROOT
    process.env.RVB_PROFILE_ROOT = profileRoot
    try {
      expect(isCanonicalPureTargetValidationRule('rule-spiritual-pressure')).toBe(false)
    } finally {
      if (previousProfileRoot === undefined) delete process.env.RVB_PROFILE_ROOT
      else process.env.RVB_PROFILE_ROOT = previousProfileRoot
      rmSync(profileRoot, { recursive: true, force: true })
    }
  })
})
