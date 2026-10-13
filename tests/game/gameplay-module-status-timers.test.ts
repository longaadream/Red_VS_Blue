/* eslint-disable @typescript-eslint/no-explicit-any -- frozen host differential fixtures. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { clearRuleCache, loadRuleById } from '@/lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'
import { STATUS_TIMER_GRAPHS, migrateStatusTimers } from '@/scripts/migrate-semantic-status-timers'

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, any>
const IDS = [
  'rule-arthas-slow-restore',
  'rule-itachi-tsukuyomi',
  'rule-kenshin-tenken-boost',
  'rule-damage-buff',
  'rule-muzan-damage-reduction',
  'rule-max-phase-recast-expire',
  'rule-hidan-undying-tick',
  'rule-watcher-form',
  'rule-obito-grudge-reset',
  'rule-shadow-chaos-spear-restore',
] as const

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function graphNodes(value: unknown): any[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(graphNodes)
  const node = value as Record<string, unknown>
  return [node, ...Object.values(node).flatMap(graphNodes)]
}

function documentFor(id: string, semantic: boolean): Record<string, unknown> {
  const frozen = fixture[`rules/${id}`]
  return semantic ? applyGameplayModuleGraph(frozen, STATUS_TIMER_GRAPHS[id], 'skillCode') : frozen
}

function scenario(id: string, selectedOption?: string): { state: any; context: any } {
  const holder: any = makePiece({ instanceId: 'holder', templateId: id, ownerPlayerId: 'player-red', currentHp: 10, moveRange: 5, attack: 10 })
  holder.name = '测试棋子'
  const target: any = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', currentHp: 10, moveRange: 3 })
  const state: any = makeState({ pieces: [holder, target], currentPlayerId: 'player-red', turnNumber: 2 })
  const context: any = { type: fixture[`rules/${id}`].trigger.type, rulePiece: holder, playerId: 'player-red', sourcePiece: holder, piece: holder, damage: 5.5 }

  switch (id) {
    case 'rule-arthas-slow-restore':
      holder.statusTags = [{ id: 'slow', type: 'arthas-slow', stacks: 2, intensity: 1 }]
      break
    case 'rule-itachi-tsukuyomi':
      holder.statusTags = [{ id: 'tsukuyomi', type: 'itachi-tsukuyomi', stacks: 1, currentUses: 1 }]
      holder.skills = [{ skillId: 'fireball', currentCooldown: 2, usesRemaining: -1 }]
      context.skillId = 'fireball'
      break
    case 'rule-kenshin-tenken-boost':
      holder.statusTags = [{ id: 'tenken-charge-holder', type: 'damage-multiplier', remainingUses: 1, currentUses: 1, intensity: 1.5, stacks: 1 }]
      break
    case 'rule-damage-buff':
      holder.statusTags = [{ id: 'damage-buff', type: 'damage-buff', intensity: 2, stacks: 1 }]
      break
    case 'rule-muzan-damage-reduction':
      holder.statusTags = [{ id: 'reduction', type: 'muzan-damage-reduction', currentDuration: 1, remainingDuration: 1, stacks: 1 }]
      context.piece = holder
      break
    case 'rule-max-phase-recast-expire':
      holder.statusTags = [{ id: 'recast', type: 'max-phase-recast', turnNumber: 2, currentDuration: 1, remainingDuration: 1 }]
      holder.skills = [{ skillId: 'max-phase-shifter', currentCooldown: 1, usesRemaining: -1 }]
      break
    case 'rule-hidan-undying-tick':
      holder.statusTags = [{ id: 'dying', type: 'hidan-dying', remainingTurns: 2, currentDuration: -1, stacks: 1 }]
      context.sourcePiece = undefined
      break
    case 'rule-watcher-form':
      context.sourcePiece = undefined
      if (selectedOption !== undefined) context.selectedOption = selectedOption
      break
    case 'rule-obito-grudge-reset':
      holder.statusTags = [{ id: 'grudge', type: 'obito-grudge', intensity: 3, stacks: 1 }]
      context.sourcePiece = undefined
      break
    case 'rule-shadow-chaos-spear-restore':
      holder.statusTags = [{ id: 'theft', type: 'chaos-spear-theft', targetId: 'target', intensity: 2, stacks: 1 }]
      context.sourcePiece = undefined
      break
  }
  return { state, context }
}

function run(
  root: string,
  id: string,
  semantic: boolean,
  selectedOption?: string,
  missingStatus = false,
  configure?: (state: any, context: any) => void,
): any {
  writeFileSync(join(root, 'data/rules', `${id}.json`), JSON.stringify(documentFor(id, semantic)))
  clearRuleCache()
  const rule = loadRuleById(id, true, true)!
  const { state, context } = scenario(id, selectedOption)
  state.pieces[0].rules = [rule]
  if (missingStatus) {
    const piece = state.pieces[0]
    piece.statusTags = []
  }
  configure?.(state, context)
  const result = rule.effect(state, context)
  const plain = copy(state)
  return { state: plain, result, damage: context.damage }
}

describe('semantic status timer rules', () => {
  it('covers the exact frozen rule IDs with author graphs only', () => {
    expect(Object.keys(STATUS_TIMER_GRAPHS).sort()).toEqual([...IDS].sort())
    for (const id of IDS) {
      for (const node of graphNodes(STATUS_TIMER_GRAPHS[id])) {
        expect(['source', 'invoke', 'function', 'lambda']).not.toContain(node.kind)
      }
    }
  })

  for (const id of IDS) {
    it(`${id} preserves active and missing-status host behavior`, () => {
      const root = mkdtempSync(join(tmpdir(), 'rvb-status-timers-'))
      const oldRoot = process.env.RVB_PROFILE_ROOT
      mkdirSync(join(root, 'data/rules'), { recursive: true })
      try {
        process.env.RVB_PROFILE_ROOT = root
        const options = id === 'rule-watcher-form' ? ['calm', undefined] : [undefined]
        for (const selectedOption of options) {
          expect(run(root, id, true, selectedOption), `${id}:active:${selectedOption}`).toEqual(run(root, id, false, selectedOption))
          expect(run(root, id, true, selectedOption, true), `${id}:missing:${selectedOption}`).toEqual(run(root, id, false, selectedOption, true))
        }
      } finally {
        clearRuleCache()
        if (oldRoot === undefined) delete process.env.RVB_PROFILE_ROOT
        else process.env.RVB_PROFILE_ROOT = oldRoot
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('preflights the whole migration batch before writing', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-status-timer-migration-'))
    mkdirSync(join(root, 'data/rules'), { recursive: true })
    mkdirSync(join(root, 'tests/game/fixtures'), { recursive: true })
    try {
      writeFileSync(join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), JSON.stringify({ entries: fixture }))
      for (const id of IDS) writeFileSync(join(root, 'data/rules', `${id}.json`), JSON.stringify(fixture[`rules/${id}`]))
      expect(migrateStatusTimers(root, false).sort()).toEqual([...IDS].sort())
      for (const id of IDS) expect(JSON.parse(readFileSync(join(root, 'data/rules', `${id}.json`), 'utf8')).gameplayModules).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves legacy fallback, first-match, fractional-hp, and wrong-turn behavior', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-status-timer-edges-'))
    const oldRoot = process.env.RVB_PROFILE_ROOT
    mkdirSync(join(root, 'data/rules'), { recursive: true })
    try {
      process.env.RVB_PROFILE_ROOT = root
      const cases: Array<{ id: typeof IDS[number]; configure: (state: any, context: any) => void }> = [
        {
          id: 'rule-arthas-slow-restore',
          configure: state => { state.pieces[0].statusTags[0].intensity = 0 },
        },
        {
          id: 'rule-shadow-chaos-spear-restore',
          configure: state => {
            state.pieces[0].statusTags = [
              { id: 'first-theft', type: 'chaos-spear-theft', targetId: 'target', intensity: 0, stacks: 1 },
              { id: 'second-theft', type: 'chaos-spear-theft', targetId: 'target', intensity: 4, stacks: 1 },
            ]
          },
        },
        {
          id: 'rule-arthas-slow-restore',
          configure: state => { state.pieces[0].currentHp = 0.5 },
        },
      ]
      for (const { id, configure } of cases) {
        expect(run(root, id, true, undefined, false, configure), `${id}:edge`).toEqual(run(root, id, false, undefined, false, configure))
      }

      const wrongTurnIds: Array<typeof IDS[number]> = [
        'rule-arthas-slow-restore',
        'rule-max-phase-recast-expire',
        'rule-hidan-undying-tick',
        'rule-watcher-form',
        'rule-obito-grudge-reset',
        'rule-shadow-chaos-spear-restore',
      ]
      for (const id of wrongTurnIds) {
        const wrongTurn = (state: ReturnType<typeof makeState>) => { state.turn.currentPlayerId = 'player-blue' }
        expect(run(root, id, true, undefined, false, wrongTurn), `${id}:wrong-turn`).toEqual(run(root, id, false, undefined, false, wrongTurn))
      }
    } finally {
      clearRuleCache()
      if (oldRoot === undefined) delete process.env.RVB_PROFILE_ROOT
      else process.env.RVB_PROFILE_ROOT = oldRoot
      rmSync(root, { recursive: true, force: true })
    }
  })
})

