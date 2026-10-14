import { beforeAll, describe, expect, it } from 'vitest'

import { loadMaps } from '@/config/maps'
import { createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import { getPieceById } from '@/lib/game/piece-repository'
import { executeSkillFunction } from '@/lib/game/skills'
import { getSkillById } from '@/lib/game/skill-repository'

beforeAll(async () => {
  await loadMaps()
})

async function createBattle(rootSeed?: number) {
  const mortis = getPieceById('mortis')
  const guldan = getPieceById('guldan')
  if (!mortis || !guldan) throw new Error('Expected static Mortis and Guldan templates')

  const battle = await createInitialBattleForPlayers(
    ['player-red', 'player-blue'],
    [mortis, guldan],
    undefined,
    'large-hole-arena',
    {
      firstPlayerId: 'player-red',
      ...(rootSeed === undefined ? {} : { rootSeed }),
    },
  )
  if (!battle) throw new Error('Expected an initialized battle')
  return battle
}

describe('author Cluster battle setup', () => {
  it('adopts complete ability groups without duplicating their rule roots or adopting player rules', async () => {
    const battle = await createBattle(252)
    const mortis = battle.pieces.find(piece => piece.templateId === 'mortis')
    const guldan = battle.pieces.find(piece => piece.templateId === 'guldan')
    if (!mortis || !guldan) throw new Error('Expected selected pieces on the board')

    expect(mortis.abilityGroups?.map(group => group.id)).toEqual([
      'skills:mortis-night-construct',
      'skills:mortis-shovel-charge',
    ])
    expect(mortis.abilityGroups?.find(group => group.id === 'skills:mortis-night-construct')).toMatchObject({
      skills: ['mortis-night-construct'],
      rules: ['rule-mortis-damage-counter'],
    })
    expect(mortis.rules.map(rule => rule.id)).toEqual(['rule-mortis-damage-counter'])
    expect(mortis.abilityGroupOwnership?.rules['rule-mortis-damage-counter']).toHaveLength(1)

    expect(guldan.abilityGroups?.map(group => group.id)).toEqual([
      'skills:fel-blessing',
      'skills:shadow-bolt',
      'skills:soul-fracture',
    ])
    expect(guldan.abilityGroups?.flatMap(group => group.rules)).not.toContain('rule-soul-fracture-player')
    expect(guldan.rules).toEqual([])
    expect(battle.players.find(player => player.playerId === guldan.ownerPlayerId)?.rules)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'rule-soul-fracture-player' })]))
  })

  it('keeps bootstrap IDs deterministic in a separate ID namespace', async () => {
    const first = await createBattle(252)
    const second = await createBattle(252)
    const groupIds = (battle: typeof first) => battle.pieces
      .filter(piece => piece.templateId === 'mortis')
      .flatMap(piece => piece.abilityGroups ?? [])
      .map(group => group.instanceId)

    expect(groupIds(first)).toEqual(groupIds(second))
    expect(groupIds(first).every(id => id.startsWith('cluster-000000fc-'))).toBe(true)
  })

  it('uses the deterministic piece-local fallback when no RuleRuntime is supplied', async () => {
    const battle = await createBattle(undefined)
    const mortis = battle.pieces.find(piece => piece.templateId === 'mortis')
    if (!mortis) throw new Error('Expected Mortis on the board')

    expect(mortis.abilityGroups?.map(group => group.instanceId)).toEqual([
      'player-red-1:ability-group:skills:mortis-night-construct',
      'player-red-1:ability-group:skills:mortis-shovel-charge',
    ])
  })

  it('installs Velen delayed effects on the owner when prophecy is created in a formal battle', async () => {
    const velen = getPieceById('velen')
    const mortis = getPieceById('mortis')
    if (!velen || !mortis) throw new Error('Expected static Velen and Mortis templates')

    const battle = await createInitialBattleForPlayers(
      ['player-red', 'player-blue'],
      [velen, mortis],
      undefined,
      'large-hole-arena',
      { firstPlayerId: 'player-red', rootSeed: 252 },
    )
    if (!battle) throw new Error('Expected an initialized battle')

    const velenInstance = battle.pieces.find(piece => piece.templateId === 'velen')
    const owner = battle.players.find(player => player.playerId === 'player-red')
    const definition = getSkillById('velen-holy-prophecy')
    if (!velenInstance || !owner || !definition) throw new Error('Expected initialized Velen skill state')

    owner.hand = [{ instanceId: 'formal-prophecy-card', cardId: 'holy-heal', ownerPlayerId: owner.playerId }]
    const result = executeSkillFunction(definition, {
      piece: velenInstance,
      target: null,
      targetPosition: null,
      targets: [],
      selectedOption: 'formal-prophecy-card',
      battle,
      skill: {
        id: definition.id,
        name: definition.name,
        type: definition.type,
        powerMultiplier: definition.powerMultiplier,
      },
    }, battle)

    expect(result).toMatchObject({ success: true })
    expect(owner.rules?.map(rule => rule.id)).toEqual(['rule-velen-delayed-effects'])
    expect(owner.hand[0].contentState?.velenHolyProphecy).toMatchObject({ sourcePieceId: velenInstance.instanceId })
  })
})
