import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runBattleAction } from '@/lib/game/battle-runner'
import { clearRuleCache, clearSkillDefinitionCache } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

type BlizzardMode = 'alive' | 'graveyard' | 'removed' | 'changed-owner'
type TileEffectRecord = { tileType: string; ownerPlayerId?: string }

function blizzardTiles(state: ReturnType<typeof makeState>): TileEffectRecord[] | undefined {
  const raw = state.extensions?.tileEffects
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new TypeError('tileEffects must be an array')
  // This fixture intentionally keeps the old direct property access semantics:
  // malformed entries fail the test instead of being silently filtered out.
  return (raw as TileEffectRecord[]).filter(tile => tile.tileType === 'blizzard')
}

const previousProfileRoot = process.env.RVB_PROFILE_ROOT
const profileRoot = mkdtempSync(join(tmpdir(), 'rvb-blizzard-player-'))
for (const [group, id] of [
  ['skills', 'blizzard'],
  ['skills', 'blizzard-damage'],
  ['skills', 'freeze-prevent'],
  ['rules', 'rule-blizzard-active'],
  ['rules', 'rule-freeze-prevent-move'],
  ['rules', 'rule-freeze-prevent-skill'],
] as const) {
  const directory = join(profileRoot, 'data', group)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, `${id}.json`), readFileSync(`data/${group}/${id}.json`))
}

function castBlizzard() {
  const caster = asPieceInstance(makePiece({
    instanceId: 'jaina',
    templateId: 'red-blizzard',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 0,
    y: 0,
    attack: 4,
    skills: [{ skillId: 'blizzard', currentCooldown: 0, usesRemaining: 3 }],
  }))
  const enemy = asPieceInstance(makePiece({
    instanceId: 'enemy',
    templateId: 'blue-target',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 2,
    y: 0,
    currentHp: 30,
    maxHp: 30,
    defense: 0,
  }))
  const state = makeState({ pieces: [caster, enemy], width: 8, height: 8, currentPlayerId: 'player-red' })
  state.skillsById = {
    blizzard: JSON.parse(readFileSync('data/skills/blizzard.json', 'utf8')),
    'blizzard-damage': JSON.parse(readFileSync('data/skills/blizzard-damage.json', 'utf8')),
  }
  state.players[0].chargePoints = 4

  const action = { type: 'useChargeSkill', playerId: 'player-red', pieceId: caster.instanceId, skillId: 'blizzard' } as const
  const prepared = prepareAction(state, action)
  if (prepared.kind !== 'needTarget') throw new Error('Blizzard target prompt missing')
  const result = runBattleAction(state, {
    ...action,
    targetX: 2,
    targetY: 0,
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  }, { rootSeed: 252 })
  return { state: result.state, caster, enemy }
}

function settle(mode: BlizzardMode) {
  const result = castBlizzard()
  const { state, caster } = result
  if (mode === 'changed-owner') caster.ownerPlayerId = 'player-blue'
  if (mode === 'graveyard' || mode === 'removed') {
    state.pieces = state.pieces.filter(piece => piece.instanceId !== caster.instanceId)
    if (mode === 'graveyard') state.graveyard = [{ ...caster, currentHp: 0 }]
  }
  state.turn.currentPlayerId = 'player-blue'
  const next = runBattleAction(state, {
    type: 'endTurn',
    playerId: 'player-blue',
    clientActionId: `blizzard-source-${mode}`,
  }, { rootSeed: 252 }).state
  return { ...result, state: next }
}

beforeEach(() => {
  process.env.RVB_PROFILE_ROOT = profileRoot
  globalTriggerSystem.clearRules()
})

afterEach(() => {
  globalTriggerSystem.clearRules()
  clearRuleCache()
  clearSkillDefinitionCache()
})

afterAll(() => {
  if (previousProfileRoot === undefined) delete process.env.RVB_PROFILE_ROOT
  else process.env.RVB_PROFILE_ROOT = previousProfileRoot
  rmSync(profileRoot, { recursive: true, force: true })
})

describe('Blizzard author graph captures its creating player', () => {
  it('stores the creating player on the status and every tile record', () => {
    const { state } = castBlizzard()
    expect(state.players[0].statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'blizzard', ownerPlayerId: 'player-red' }),
    ]))
    const tiles = blizzardTiles(state) ?? []
    expect(tiles).toHaveLength(49)
    expect(tiles.every(tile => tile.ownerPlayerId === 'player-red')).toBe(true)
  })

  it.each(['alive', 'graveyard', 'removed', 'changed-owner'] as const)(
    'settles from the captured player when the caster is %s',
    mode => {
      const { state } = settle(mode)
      const enemy = state.pieces.find(piece => piece.instanceId === 'enemy')
      expect(enemy?.currentHp).toBe(24)
      expect(enemy?.statusTags).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'freeze', currentDuration: 1 }),
      ]))
      expect(state.players[0].statusTags).toEqual([])
      expect(blizzardTiles(state)).toEqual([])

      const damage = state.actions?.filter(action => action.type === 'damage').at(-1)
      expect(damage?.payload).toMatchObject({
        sourceId: 'player-red',
        damageSource: { kind: 'player', sourceId: 'player-red', playerId: 'player-red' },
      })
    },
  )
})
