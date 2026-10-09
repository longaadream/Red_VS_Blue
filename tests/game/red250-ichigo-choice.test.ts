/* eslint-disable @typescript-eslint/no-explicit-any -- exercises the public preview and authority reducer together. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { toPublicBattleState } from '@/lib/game/deployment'
import { preparePublicSkillAction } from '@/lib/game/skill-preview'
import { loadRuleById } from '@/lib/game/skills'
import {
  skillChoiceMatchesPrompt,
  skillChoicePromptKey,
  type SkillChoiceInput,
} from '@/lib/game/skill-choice-sequence'
import { SuspendableActionRuntime } from '@/lib/game/suspendable-action-transaction'
import type { BattleAction } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

function json(path: string): any {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'))
}

describe('RED-250 Ichigo black Getsuga public choice sequence', () => {
  it('keeps same-consumer occurrences distinct while ignoring unrelated consumers', () => {
    const runtime = new SuspendableActionRuntime([])
    const source = {
      consumerKind: 'rule' as const,
      consumerId: 'same-consumer',
      sourceId: 'red250-source',
      eventType: 'afterSkillUsed',
    }
    const first = runtime.enterConsumer(source)
    const unrelated = runtime.enterConsumer({
      consumerKind: 'rule',
      consumerId: 'hidden-consumer',
      sourceId: 'red250-hidden',
      eventType: 'afterSkillUsed',
    })
    const second = runtime.enterConsumer(source)
    expect(first).toMatchObject({ consumerOrdinal: 0, consumerOccurrence: 0 })
    expect(unrelated).toMatchObject({ consumerOrdinal: 1, consumerOccurrence: 0 })
    expect(second).toMatchObject({ consumerOrdinal: 2, consumerOccurrence: 1 })

    const pending = (interaction: typeof first) => ({
      source: { type: 'rule', id: 'same-consumer', pieceId: 'red250-source' },
      transaction: { answers: [], currentInteraction: interaction },
    })
    expect(skillChoicePromptKey('target', pending(first)))
      .not.toBe(skillChoicePromptKey('target', pending(second)))
  })

  it('uses global ordinal for legacy interaction keys without consumerOccurrence', () => {
    const state = makeState() as any
    const pending = {
      playerId: 'player-red',
      source: { type: 'rule', id: 'legacy-consumer', pieceId: 'red250-source' } as const,
      targetType: 'cell',
      candidates: [{ type: 'cell', x: 1, y: 1 }],
      transaction: {
        protocolVersion: 1,
        answers: [],
        currentInteraction: {
          consumerKind: 'rule',
          consumerId: 'legacy-consumer',
          sourceId: 'red250-source',
          eventType: 'afterSkillUsed',
          consumerOrdinal: 2,
        },
      },
    }
    state.pendingTargetSelection = pending
    const choice: SkillChoiceInput = {
      kind: 'target',
      source: pending.source,
      promptKey: skillChoicePromptKey('target', pending),
      targetX: 1,
      targetY: 1,
    }

    const differentLegacyPending = {
      ...pending,
      transaction: {
        ...pending.transaction,
        currentInteraction: {
          ...pending.transaction.currentInteraction,
          consumerOrdinal: 3,
        },
      },
    }
    expect(skillChoicePromptKey('target', pending))
      .not.toBe(skillChoicePromptKey('target', differentLegacyPending))
    expect(skillChoiceMatchesPrompt(choice, state, 'player-red')).toBe(true)
  })

  it('rejects a public key from a different occurrence of the same consumer', () => {
    const state = makeState() as any
    const pending = {
      playerId: 'player-red',
      source: { type: 'rule', id: 'same-consumer', pieceId: 'red250-source' } as const,
      targetType: 'cell',
      candidates: [{ type: 'cell', x: 1, y: 1 }],
      transaction: {
        protocolVersion: 1,
        answers: [],
        currentInteraction: {
          consumerKind: 'rule',
          consumerId: 'same-consumer',
          sourceId: 'red250-source',
          eventType: 'afterSkillUsed',
          consumerOrdinal: 1,
          consumerOccurrence: 1,
        },
      },
    }
    state.pendingTargetSelection = pending
    const publicPending = {
      ...pending,
      transaction: {
        ...pending.transaction,
        currentInteraction: {
          ...pending.transaction.currentInteraction,
          consumerOrdinal: 0,
          consumerOccurrence: 0,
        },
      },
    }
    const choice: SkillChoiceInput = {
      kind: 'target',
      source: pending.source,
      promptKey: skillChoicePromptKey('target', publicPending),
      targetX: 1,
      targetY: 1,
    }
    const { consumerOccurrence, ...legacyInteraction } = pending.transaction.currentInteraction
    expect(consumerOccurrence).toBe(1)
    const legacyPending = {
      ...pending,
      transaction: {
        ...pending.transaction,
        currentInteraction: legacyInteraction,
      },
    }
    const legacyChoice = {
      ...choice,
      promptKey: skillChoicePromptKey('target', legacyPending),
    }

    expect(skillChoiceMatchesPrompt(choice, state, 'player-red')).toBe(false)
    expect(skillChoiceMatchesPrompt(legacyChoice, state, 'player-red')).toBe(false)
  })

  it('rejects a stable public key when authority candidates change', () => {
    const state = makeState() as any
    const publicPending = {
      playerId: 'player-red',
      source: { type: 'rule', id: 'candidate-consumer', pieceId: 'red250-source' } as const,
      targetType: 'cell',
      candidates: [{ type: 'cell', x: 1, y: 1 }],
      transaction: {
        answers: [],
        currentInteraction: {
          consumerKind: 'rule', consumerId: 'candidate-consumer', sourceId: 'red250-source',
          eventType: 'afterSkillUsed', consumerOrdinal: 0, consumerOccurrence: 0,
        },
      },
    }
    const authorityPending = {
      ...publicPending,
      candidates: [{ type: 'cell', x: 2, y: 2 }],
    }
    state.pendingTargetSelection = authorityPending
    const choice: SkillChoiceInput = {
      kind: 'target',
      source: publicPending.source,
      promptKey: skillChoicePromptKey('target', publicPending),
      targetX: 1,
      targetY: 1,
    }

    expect(skillChoiceMatchesPrompt(choice, state, 'player-red')).toBe(false)
  })

  it('replays direction and landing choices through authority as one damage and payment', () => {
    const skill = json('data/skills/ichigo-black-getsuga-tensho.json')
    const ichigo = makePiece({
      instanceId: 'red250-ichigo',
      templateId: 'blue-ichigo',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
      attack: 6,
      skills: [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }],
    }) as any
    ichigo.rules = [loadRuleById('rule-ichigo-black-getsuga-teleport', true)]
    const enemy = makePiece({
      instanceId: 'red250-getsuga-target',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 3,
      y: 1,
      currentHp: 30,
      maxHp: 30,
    }) as any
    // This rule is intentionally attached to the opponent: it is hidden from
    // the public preview but still consumes an authority trigger occurrence.
    enemy.rules = [loadRuleById('rule-ichigo-black-getsuga-teleport', true)]
    const authorityState = makeState({
      pieces: [enemy, ichigo],
      currentPlayerId: 'player-red',
      width: 6,
      height: 4,
    }) as any
    authorityState.skillsById[skill.id] = skill
    authorityState.players[0].actionPoints = 6

    const publicState = toPublicBattleState(authorityState, 'player-red')
    const root = {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: ichigo.instanceId,
      skillId: skill.id,
    } as BattleAction
    const rootPreparation = preparePublicSkillAction(publicState, root, 'player-red')
    expect(rootPreparation).toMatchObject({
      status: 'needs-input',
      preparation: { kind: 'needTarget', continuation: false },
    })
    if (rootPreparation.status !== 'needs-input' || !rootPreparation.preparation) return

    const direction = {
      ...root,
      targetX: 5,
      targetY: 1,
      selectionId: rootPreparation.preparation.selectionId,
      stateRevision: rootPreparation.preparation.stateRevision,
    } as BattleAction
    const landingPreparation = preparePublicSkillAction(publicState, direction, 'player-red')
    expect(landingPreparation).toMatchObject({
      status: 'needs-input',
      preparation: {
        kind: 'needTarget',
        continuation: true,
        source: { type: 'rule', id: 'rule-ichigo-black-getsuga-teleport', pieceId: ichigo.instanceId },
      },
    })
    if (landingPreparation.status !== 'needs-input' || !landingPreparation.preparation?.promptKey) return

    const skillChoices = [{
      kind: 'target' as const,
      source: landingPreparation.preparation.source,
      promptKey: landingPreparation.preparation.promptKey,
      targetX: 3,
      targetY: 0,
    }]
    const completedPreview = preparePublicSkillAction(publicState, {
      ...direction,
      skillChoices,
    } as BattleAction, 'player-red')
    expect(completedPreview.status).toBe('ready')

    const completed = runBattleAction(authorityState, {
      ...direction,
      skillChoices,
    } as BattleAction & { skillChoices: unknown[] }, { rootSeed: 250 }).state as any

    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.pendingOptionSelection).toBeUndefined()
    expect(completed.players[0].actionPoints).toBe(4)
    expect(completed.pieces.find((piece: any) => piece.instanceId === ichigo.instanceId))
      .toMatchObject({ x: 3, y: 0 })
    expect(completed.pieces.find((piece: any) => piece.instanceId === enemy.instanceId)?.currentHp).toBe(18)
    expect(completed.actions.filter((entry: any) => entry.type === 'damage'
      && entry.payload?.skillId === skill.id)).toHaveLength(1)
  })
})
