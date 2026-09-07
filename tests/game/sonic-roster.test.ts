import type { TriggerRule } from '@/lib/game/triggers'
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyBattleAction, BattleRuleError } from '@/lib/game/turn'
import { buildInitialPiecesForPlayers } from '@/lib/game/battle-setup'
import { dealDamage, executeSkillFunction, loadRuleById } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { makePiece, makeState } from '../helpers/minimal-state'

describe('Sonic roster mechanics', () => {
  const attachRule = <T extends { rules?: TriggerRule[] }>(piece: T, ruleId: string) => {
    piece.rules = [...(piece.rules || []), loadRuleById(ruleId)!]
    return piece
  }

  it('does not render momentum outside the existing status-tag UI', () => {
    const battlePage = readFileSync(resolve(process.cwd(), 'data/pages/battle.html'), 'utf8')
    const statsTemplate = battlePage.match(/const statsHtml = `([\s\S]*?)`\s*\/\/ Skills/)

    expect(statsTemplate).not.toBeNull()
    expect(statsTemplate?.[1]).not.toContain('momentum')
    expect(battlePage).not.toContain('pieceContextResources')
    expect(battlePage).not.toContain('pieceDisplayResources')
    expect(battlePage).not.toContain('pieceHasMomentumSkillForDisplay')
    expect(battlePage).not.toContain('pieceMomentumValue')
  })

  it('only exposes skill keywords that have a glossary explanation', () => {
    const glossary = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skill-keywords.json'), 'utf8'))
    const knownKeywords = new Set(glossary.map((entry: { name: string }) => entry.name))
    const skillDirectory = resolve(process.cwd(), 'data/skills')

    for (const file of readdirSync(skillDirectory).filter(file => file.endsWith('.json') && file !== 'manifest.json')) {
      const skill = JSON.parse(readFileSync(resolve(skillDirectory, file), 'utf8'))
      for (const keyword of skill.keywords || []) expect(knownKeywords).toContain(keyword)
    }

    const doubleTailFlight = JSON.parse(readFileSync(resolve(skillDirectory, 'tails-twin-flight.json'), 'utf8'))
    expect(doubleTailFlight.effectTags).toEqual(['搬运'])
  })

  it('uses the requested Sonic and Shadow skill descriptions and Super Form costs', () => {
    const expected = {
      'sonic-spin-dash': '获得动能。选择1个正方向5格内的空格并向其冲刺，可穿过无法行走地格，对路径敌方棋子造成等同于本棋子攻击力150%的物理伤害。动能3：冲刺最大距离+2。动能5：命中敌方棋子沉默1回合。',
      'shadow-ride-sweep': '获得动能。选择1个正方向上7格内的1个空格并向其冲刺，对路径上敌方棋子造成等同于本棋子攻击力100%的物理伤害。动能5：弹射物。冲刺后选择1个垂直于冲刺方向的方向，对路径上每格往该方向4格范围内的所有敌方棋子造成5点伤害，可穿透棋子。动能7：路径伤害+2。',
      'sonic-super-form': '你获得2临时行动点。本回合本棋子使用技能不消耗动能，回合结束后保留。',
    }
    for (const [skillId, description] of Object.entries(expected)) {
      const definition = JSON.parse(readFileSync(resolve(process.cwd(), `data/skills/${skillId}.json`), 'utf8'))
      expect(definition.description).toBe(description)
    }
    const superForm = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/sonic-super-form.json'), 'utf8'))
    expect(superForm).toMatchObject({ actionPointCost: 0, chargeCost: 3, cooldownTurns: 3 })
  })

  it('lists Sonic\'s once-per-turn free normal movement passive', () => {
    const sonic = JSON.parse(readFileSync(resolve(process.cwd(), 'data/pieces/sonic.json'), 'utf8'))
    const passive = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/sonic-free-move-passive.json'), 'utf8'))

    expect(sonic.skills).toContainEqual(expect.objectContaining({ skillId: passive.id }))
    expect(passive).toMatchObject({ kind: 'passive', relatedRules: ['rule-sonic-free-move'] })
    expect(passive.description).toContain('你的回合开始时')
  })

  it('uses the requested Chaos Spear range, damage, and movement theft', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/shadow-chaos-spear.json'), 'utf8'))
    const shadow = makePiece({
      instanceId: 'shadow', templateId: 'shadow', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 10, moveRange: 5,
    })
    const target = makePiece({
      instanceId: 'target', ownerPlayerId: 'player-blue', x: 4, y: 0, currentHp: 20, maxHp: 20, moveRange: 5,
    })
    const beyondRange = makePiece({
      instanceId: 'beyond', ownerPlayerId: 'player-blue', x: 5, y: 0,
    })
    const state = makeState({ pieces: [shadow, target, beyondRange], width: 8, height: 4 })
    state.skillsById[definition.id] = definition
    shadow.skills = [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }]

    const prepared = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: shadow.instanceId, skillId: definition.id,
    })
    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    expect(prepared.candidates).toContainEqual({ type: 'piece', pieceId: target.instanceId })
    expect(prepared.candidates).not.toContainEqual({ type: 'piece', pieceId: beyondRange.instanceId })

    const result = executeSkillFunction(definition, {
      piece: shadow, target, targetPosition: null, targets: [{ info: target, pos: null }], skill: definition, battle: state,
    }, state)

    expect(definition.description).toBe('对4格内1个敌方棋子造成等同于本棋子攻击力50%的物理伤害，并偷取其2点移动力至你的下一个回合开始时。')
    expect(result.success).toBe(true)
    expect(target.currentHp).toBe(15)
    expect(target.moveRange).toBe(3)
    expect(shadow.moveRange).toBe(7)
    expect(shadow.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'chaos-spear-theft', targetId: target.instanceId, intensity: 2 }),
    ]))
  })

  it('executes Sonic Homing Attack after Super Form without a dynamic-code compile error', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/sonic-homing-attack.json'), 'utf8'))
    const sonic = makePiece({
      instanceId: 'sonic', templateId: 'sonic', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 4,
      statusTags: [
        { type: 'momentum-core', stacks: 3, skillIds: [definition.id] },
        { type: 'preserve-momentum', stacks: 1 },
      ],
    })
    sonic.momentum = 3
    const enemy = makePiece({
      instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 3, y: 0, currentHp: 12, maxHp: 12,
    })
    const state = makeState({ pieces: [sonic, enemy], width: 6, height: 4 })

    const result = executeSkillFunction(definition, {
      piece: sonic, target: enemy, targetPosition: null, targets: [{ info: enemy, pos: null }], skill: definition, battle: state,
    }, state)

    expect(result).toMatchObject({ success: true, message: '追踪攻击造成5点伤害' })
    expect(sonic).toMatchObject({ x: 4, y: 0 })
    expect(enemy.currentHp).toBe(7)
  })

  it('documents the complete momentum acquisition and consumption contract', () => {
    const glossary = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skill-keywords.json'), 'utf8'))
    const momentum = glossary.find((entry: { name: string }) => entry.name === '动能')
    expect(momentum).toMatchObject({ id: 'momentum', category: 'resource', highlight: true })
    expect(momentum.shortDescription).toContain('按移动格数累积动能')
    for (const rule of ['只有拥有至少一个动能技能', '普通移动', '获得动能', '使其他角色获得动能', '传送不获得动能', '没有上限', '重置为0']) {
      expect(momentum.longDescription).toContain(rule)
    }
  })

  it('declares an authoritative four-direction target step for Shadow ride sweep', () => {
    const shadow = makePiece({
      instanceId: 'shadow',
      templateId: 'shadow',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
      skills: [{ skillId: 'shadow-ride-sweep', currentCooldown: 0 }],
    })
    const state = makeState({ pieces: [shadow], width: 10, height: 10 })
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/shadow-ride-sweep.json'), 'utf8'))
    state.skillsById['shadow-ride-sweep'] = definition
    state.players[0].actionPoints = 2

    const prepared = prepareAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'shadow',
      skillId: 'shadow-ride-sweep',
    })

    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    expect(prepared.targetType).toBe('cell')
    expect(prepared.range).toBe(7)
    expect(prepared.candidates).toContainEqual({ type: 'cell', x: 7, y: 1 })
    expect(prepared.candidates).toContainEqual({ type: 'cell', x: 1, y: 7 })
    expect(prepared.candidates).not.toContainEqual({ type: 'cell', x: 7, y: 7 })
    expect(prepared.candidates).not.toContainEqual({ type: 'cell', x: 1, y: 1 })
  })

  it('records a board-side selection only after Shadow reaches five momentum', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/shadow-ride-sweep.json'), 'utf8'))
    const executeAtMomentum = (momentum: number) => {
      const shadow = makePiece({
        instanceId: 'shadow', templateId: 'shadow', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 5,
      })
      shadow.momentum = momentum
      const enemy = makePiece({
        instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 1, currentHp: 20, maxHp: 20,
      })
      const state = makeState({ pieces: [shadow, enemy], width: 10, height: 10 })
      const result = executeSkillFunction(definition, {
        piece: shadow,
        target: null,
        targetPosition: { x: 4, y: 1 },
        targets: [{ info: null, pos: { x: 4, y: 1 } }],
        skill: definition,
        battle: state,
      }, state)
      return { result: result, state }
    }

    const belowThreshold = executeAtMomentum(4)
    expect(belowThreshold.result.success).toBe(true)
    expect(belowThreshold.state.pieces.find(piece => piece.instanceId === 'enemy')?.currentHp).toBe(15)

    const atThreshold = executeAtMomentum(5)
    expect(atThreshold.result.success).toBe(true)
    expect(atThreshold.result.needsOptionSelection).toBeUndefined()
    expect((atThreshold.state.pieces[0]).statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'shadow-ride-sweep-side',
        left: { x: 4, y: 0 },
        right: { x: 4, y: 2 },
      }),
    ]))
  })

  it('applies existing silence and immobilize effects with Shadow chaos control', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/shadow-chaos-control.json'), 'utf8'))
    const shadow = makePiece({ instanceId: 'shadow', templateId: 'shadow', ownerPlayerId: 'player-red', x: 1, y: 1 })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 4, y: 2 })
    const state = makeState({ pieces: [shadow, enemy], width: 10, height: 10 })

    const result = executeSkillFunction(definition, {
      piece: shadow, target: null, targetPosition: { x: 2, y: 1 }, targets: [{ info: null, pos: { x: 2, y: 1 } }],
      skill: definition, battle: state,
    }, state)

    expect(result.success).toBe(true)
    expect(enemy.statusTags.find((tag) => tag.type === 'silenced')?.relatedRules).toContain('rule-silenced-block')
    expect(enemy.statusTags.find((tag) => tag.type === 'chidori-immobile')?.relatedRules).toContain('rule-chidori-immobile')
    expect(enemy.rules.map((rule) => rule.id)).toEqual(expect.arrayContaining(['rule-silenced-block', 'rule-chidori-immobile']))
  })

  it('only exposes empty floor and cover cells for Shadow chaos control', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/shadow-chaos-control.json'), 'utf8'))
    const shadow = makePiece({
      instanceId: 'shadow', templateId: 'shadow', ownerPlayerId: 'player-red', x: 1, y: 1,
      skills: [{ skillId: definition.id, currentCooldown: 0 }],
    })
    const occupied = makePiece({ instanceId: 'occupied', ownerPlayerId: 'player-blue', x: 2, y: 1 })
    const state = makeState({ pieces: [shadow, occupied], width: 7, height: 5 })
    state.skillsById[definition.id] = definition
    state.players[0].actionPoints = 2
    state.players[0].chargePoints = 2
    const cover = state.map.tiles.find(tile => tile.x === 1 && tile.y === 2)!
    cover.props = { ...cover.props, type: 'cover', walkable: true, bulletPassable: false }
    const wall = state.map.tiles.find(tile => tile.x === 2 && tile.y === 2)!
    wall.props = { ...wall.props, type: 'wall', walkable: false, bulletPassable: false }

    const prepared = prepareAction(state, {
      type: 'useChargeSkill', playerId: 'player-red', pieceId: 'shadow', skillId: definition.id,
    })

    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    expect(prepared.candidates).toContainEqual({ type: 'cell', x: 1, y: 2 })
    expect(prepared.candidates).not.toContainEqual({ type: 'cell', x: 1, y: 1 })
    expect(prepared.candidates).not.toContainEqual({ type: 'cell', x: 2, y: 1 })
    expect(prepared.candidates).not.toContainEqual({ type: 'cell', x: 2, y: 2 })
  })

  it('keeps Double Tail Flight’s basic landing selector within its declared range', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/tails-twin-flight.json'), 'utf8'))
    const tails = makePiece({
      instanceId: 'tails', templateId: 'tails', ownerPlayerId: 'player-red', x: 1, y: 1,
      skills: [{ skillId: definition.id, currentCooldown: 0 }],
    })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 2, y: 1 })
    const state = makeState({ pieces: [tails, ally], width: 8, height: 8 })
    state.skillsById[definition.id] = definition
    state.players[0].actionPoints = 2

    const first = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'tails', skillId: definition.id,
    })
    expect(first.kind).toBe('needTarget')
    if (first.kind !== 'needTarget') return
    expect(first.candidates).toContainEqual({ type: 'piece', pieceId: 'ally' })
    expect(first.candidates).toContainEqual({ type: 'piece', pieceId: 'tails' })
    const second = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'tails', skillId: definition.id,
      targetPieceId: 'ally', selectionId: first.selectionId, stateRevision: first.stateRevision,
    })
    expect(second.kind).toBe('needTarget')
    if (second.kind !== 'needTarget') return
    expect(second.candidates).toContainEqual({ type: 'cell', x: 4, y: 4 })
    const third = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'tails', skillId: definition.id,
      targetPieceId: 'ally', extraTargets: [{ x: 4, y: 4 }],
      selectionId: second.selectionId, stateRevision: second.stateRevision,
    })
    expect(third.kind).toBe('needTarget')
    if (third.kind !== 'needTarget') return
    expect(third.candidates).toContainEqual({ type: 'cell', x: 4, y: 3 })
    expect(third.candidates).toContainEqual({ type: 'cell', x: 5, y: 4 })
    expect(third.candidates).not.toContainEqual({ type: 'cell', x: 4, y: 4 })
    expect(third.candidates).not.toContainEqual({ type: 'cell', x: 6, y: 4 })
    expect(third.candidates.every(candidate => candidate.type === 'cell'
      && Math.abs(candidate.x - 4) + Math.abs(candidate.y - 4) === 1)).toBe(true)
  })

  it('rejects a forged Double Tail Flight command that selects Tails as the carried ally', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/tails-twin-flight.json'), 'utf8'))
    const tails = makePiece({ instanceId: 'tails', templateId: 'tails', ownerPlayerId: 'player-red', x: 1, y: 1 })
    const state = makeState({ pieces: [tails], width: 8, height: 8 })

    const result = executeSkillFunction(definition, {
      piece: tails, target: tails, targets: [{ info: tails, pos: null }], skill: definition, battle: state,
    } as unknown as import('@/lib/game/skills').SkillExecutionContext, state)

    expect(result).toMatchObject({ success: false, message: '双尾飞行必须选择另一名友军' })
  })

  it('reserves the selected Double Tail Flight landing cells and applies its status effects', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/tails-twin-flight.json'), 'utf8'))
    const tails = makePiece({
      instanceId: 'tails', templateId: 'tails', ownerPlayerId: 'player-red', x: 1, y: 1,
      skills: [{ skillId: definition.id, currentCooldown: 0 }],
    })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 2, y: 1 })
    const state = makeState({ pieces: [tails, ally], width: 8, height: 8 })
    state.skillsById[definition.id] = definition
    state.players[0].actionPoints = 2

    const first = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'tails', skillId: definition.id,
    })
    if (first.kind !== 'needTarget') throw new Error('双尾飞行未开始权威目标选择')
    const resolved = applyBattleAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'tails', skillId: definition.id,
      targetPieceId: 'ally', extraTargets: [{ x: 4, y: 4 }, { x: 4, y: 5 }],
      selectionId: first.selectionId, stateRevision: first.stateRevision,
    })

    expect(resolved.extensions!.scheduledTransfers).toBeUndefined()
    expect(resolved.extensions!.tileEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tails-flight-reservation', x: 4, y: 4 }),
      expect.objectContaining({ type: 'tails-flight-reservation', x: 4, y: 5 }),
    ]))
    for (const piece of [resolved.pieces.find(piece => piece.instanceId === 'tails'), resolved.pieces.find(piece => piece.instanceId === 'ally')]) {
      expect(piece?.statusTags.map((tag) => tag.type)).toEqual(expect.arrayContaining(['immune', 'inoperable']))
      expect(piece?.statusTags).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'immune', remainingDuration: 2 }),
        expect.objectContaining({ type: 'inoperable', remainingDuration: 2 }),
      ]))
    }
    expect(resolved.pieces.find(piece => piece.instanceId === 'tails')?.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tails-flight-reservation', turns: 2 }),
    ]))
  })

  it('resolves Double Tail Flight when its two-turn effects expire', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/tails-twin-flight.json'), 'utf8'))
    const tails = makePiece({
      instanceId: 'tails', templateId: 'tails', ownerPlayerId: 'player-red', x: 1, y: 1,
      skills: [{ skillId: definition.id, currentCooldown: 0 }],
    })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 2, y: 1 })
    const state = makeState({ pieces: [tails, ally], width: 8, height: 8 })
    state.skillsById[definition.id] = definition
    state.players[0].actionPoints = 2
    const first = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'tails', skillId: definition.id,
    })
    if (first.kind !== 'needTarget') throw new Error('双尾飞行未开始权威目标选择')
    const reserved = applyBattleAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'tails', skillId: definition.id,
      targetPieceId: 'ally', extraTargets: [{ x: 4, y: 4 }, { x: 4, y: 5 }],
      selectionId: first.selectionId, stateRevision: first.stateRevision,
    })
    const castingTurnEnd = applyBattleAction({
      ...reserved, turn: { ...reserved.turn, currentPlayerId: 'player-red', phase: 'action' },
    }, { type: 'endTurn', playerId: 'player-red' })
    expect(castingTurnEnd.pieces.find(piece => piece.instanceId === 'tails')).toMatchObject({ x: 1, y: 1 })
    expect(castingTurnEnd.pieces.find(piece => piece.instanceId === 'tails')?.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tails-flight-reservation', currentDuration: 2 }),
      expect.objectContaining({ type: 'immune', remainingDuration: 2 }),
      expect.objectContaining({ type: 'inoperable', remainingDuration: 2 }),
    ]))
    const firstOwnTurnEnd = applyBattleAction({
      ...castingTurnEnd,
      turn: { ...castingTurnEnd.turn, currentPlayerId: 'player-red', phase: 'action', turnNumber: castingTurnEnd.turn.turnNumber + 2 },
    }, { type: 'endTurn', playerId: 'player-red' })
    expect(firstOwnTurnEnd.pieces.find(piece => piece.instanceId === 'tails')).toMatchObject({ x: 1, y: 1 })
    const expiryTurnEnd = applyBattleAction({
      ...firstOwnTurnEnd,
      turn: { ...firstOwnTurnEnd.turn, currentPlayerId: 'player-red', phase: 'action', turnNumber: firstOwnTurnEnd.turn.turnNumber + 2 },
    }, { type: 'endTurn', playerId: 'player-red' })
    expect(expiryTurnEnd.pieces.find(piece => piece.instanceId === 'tails')).toMatchObject({ x: 4, y: 4 })
    expect(expiryTurnEnd.pieces.find(piece => piece.instanceId === 'ally')).toMatchObject({ x: 4, y: 5 })
    for (const moved of ['tails', 'ally']) {
      expect(expiryTurnEnd.pieces.find(piece => piece.instanceId === moved)?.statusTags.some((tag) =>
        ['tails-flight-reservation', 'immune', 'inoperable'].includes(tag.type))).toBe(false)
    }
  })

  it('lets Mechanical Support remove any selected target effect after healing', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/tails-mechanical-support.json'), 'utf8'))
    const tails = makePiece({
      instanceId: 'tails', templateId: 'tails', ownerPlayerId: 'player-red',
      skills: [{ skillId: definition.id, currentCooldown: 0 }],
    })
    const ally = makePiece({
      instanceId: 'ally', ownerPlayerId: 'player-red', currentHp: 80, maxHp: 100,
      statusTags: [
        { id: 'ally-silenced', type: 'silenced', name: '沉默' },
        { id: 'ally-shield', type: 'shield', name: '护盾' },
      ],
    })
    const state = makeState({ pieces: [tails, ally] })
    state.skillsById[definition.id] = definition
    const first = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'tails', skillId: definition.id,
    })
    if (first.kind !== 'needTarget') throw new Error('机械支援未开始目标选择')
    const selecting = applyBattleAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'tails', skillId: definition.id,
      targetPieceId: 'ally', selectionId: first.selectionId, stateRevision: first.stateRevision,
    })
    const pending = selecting.pendingOptionSelection
    if (!pending) throw new Error('机械支援未请求效果选择')
    expect(pending.options.map((option) => option.label)).toEqual(['沉默（1）', '护盾（2）', '不移除效果'])
    const resolved = applyBattleAction(selecting, {
      type: 'pendingOptionSelect', playerId: 'player-red', selectedOption: '1',
      selectionId: pending.selectionId, stateRevision: pending.stateRevision,
    })
    const result = resolved.pieces.find(piece => piece.instanceId === 'ally')!
    expect(result.currentHp).toBe(85)
    expect(result.statusTags.map((tag) => tag.type)).toEqual(['silenced'])
  })

  it('lets Mechanical Support keep the target effects when its removal choice is cancelled', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/tails-mechanical-support.json'), 'utf8'))
    const tails = makePiece({
      instanceId: 'tails', templateId: 'tails', ownerPlayerId: 'player-red',
      skills: [{ skillId: definition.id, currentCooldown: 0 }],
    })
    const ally = makePiece({
      instanceId: 'ally', ownerPlayerId: 'player-red', currentHp: 80, maxHp: 100,
      statusTags: [
        { id: 'ally-silenced', type: 'silenced', name: '沉默' },
        { id: 'ally-shield', type: 'shield', name: '护盾' },
      ],
    })
    const state = makeState({ pieces: [tails, ally] })
    state.skillsById[definition.id] = definition
    const first = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'tails', skillId: definition.id,
    })
    if (first.kind !== 'needTarget') throw new Error('机械支援未开始目标选择')
    const selecting = applyBattleAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'tails', skillId: definition.id,
      targetPieceId: 'ally', selectionId: first.selectionId, stateRevision: first.stateRevision,
    })
    const pending = selecting.pendingOptionSelection
    if (!pending) throw new Error('机械支援未请求效果选择')

    const resolved = applyBattleAction(selecting, {
      type: 'cancelPendingSelection', playerId: 'player-red',
      selectionId: pending.selectionId, stateRevision: pending.stateRevision,
    })
    const result = resolved.pieces.find(piece => piece.instanceId === 'ally')!

    expect(pending).toMatchObject({ canCancel: true, cancelValue: 'none' })
    expect(result.currentHp).toBe(85)
    expect(result.statusTags.map((tag) => tag.type)).toEqual(['silenced', 'shield'])
  })

  it('creates the selected permanent armor card through Tails’s charge skill', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/tails-armor-assembly.json'), 'utf8'))
    for (const moduleDetail of ['恢复模块：持有者的回合结束时，恢复3点生命', '攻击模块：攻击力+3', '高速模块：持有者每回合获得1次免费普通移动', '硬化模块：防御力+2', '可对本棋子或1个友方棋子使用', '护甲可叠加，持续本局游戏']) {
      expect(definition.description).toContain(moduleDetail)
    }
    const tails = makePiece({
      instanceId: 'tails', templateId: 'tails', ownerPlayerId: 'player-red',
      skills: [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }],
    })
    const state = makeState({ pieces: [tails] })
    state.skillsById[definition.id] = definition
    state.players[0].chargePoints = 2

    const selecting = applyBattleAction(state, {
      type: 'useChargeSkill', playerId: 'player-red', pieceId: 'tails', skillId: definition.id,
    })
    const pending = selecting.pendingOptionSelection
    if (!pending) throw new Error('护甲组装未请求模块选择')

    expect(pending.options.map((option) => option.value)).toEqual(['heal', 'attack', 'speed', 'defense'])
    expect(pending).toMatchObject({ selectionMode: 'multi', minSelections: 2, maxSelections: 2 })
    const resolved = applyBattleAction(selecting, {
      type: 'pendingOptionSelect', playerId: 'player-red', selectedOption: ['heal', 'attack'],
      selectionId: pending.selectionId, stateRevision: pending.stateRevision,
    })

    expect(resolved.players[0].hand).toEqual(expect.arrayContaining([
      expect.objectContaining({ cardId: 'armor-attack-heal', actionPointCost: 2 }),
    ]))
    expect(resolved.customCards!['armor-attack-heal']).toMatchObject({ type: 'active', actionPointCost: 2 })
  })

  it.each([
    ['left', 4, 1, 9, 0],
    ['right', 6, 9, 1, 10],
  ])('fires ride sweep up to four cells along the %s perpendicular ray', (side, selectionY, targetY, oppositeY, beyondY) => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/shadow-ride-sweep.json'), 'utf8'))
    const shadow = makePiece({
      instanceId: 'shadow', templateId: 'shadow', ownerPlayerId: 'player-red', x: 1, y: 5, attack: 9,
    })
    shadow.momentum = 5
    shadow.facing = 'down'
    const pathEnemy = makePiece({
      instanceId: 'path-enemy', ownerPlayerId: 'player-blue', x: 3, y: 5, currentHp: 20, maxHp: 20,
    })
    const sideEnemy = makePiece({
      instanceId: 'side-enemy', ownerPlayerId: 'player-blue', x: 2, y: targetY, currentHp: 20, maxHp: 20,
    })
    const oppositeEnemy = makePiece({
      instanceId: 'opposite-enemy', ownerPlayerId: 'player-blue', x: 2, y: oppositeY, currentHp: 20, maxHp: 20,
    })
    const beyondEnemy = makePiece({
      instanceId: 'beyond-enemy', ownerPlayerId: 'player-blue', x: 2, y: beyondY, currentHp: 20, maxHp: 20,
    })
    const state = makeState({ pieces: [shadow, pathEnemy, sideEnemy, oppositeEnemy, beyondEnemy], width: 7, height: 11 })
    shadow.statusTags = [{ type: 'momentum-core', stacks: 5, skillIds: [definition.id] }]
    attachRule(shadow, 'rule-momentum-consume')
    shadow.skills = [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }]
    state.skillsById[definition.id] = definition
    state.players[0].actionPoints = 10

    const prepared = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'shadow', skillId: definition.id,
    })
    if (prepared.kind !== 'needTarget') throw new Error('骑射横扫未请求冲刺终点')
    const selectingSide = applyBattleAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'shadow', skillId: definition.id,
      targetX: 4, targetY: 5, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision,
    })
    const pending = selectingSide.pendingTargetSelection
    if (!pending) throw new Error('骑射横扫未请求侧射地格')
    const result = applyBattleAction(selectingSide, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetX: 4, targetY: selectionY,
      selectionId: pending.selectionId, stateRevision: pending.stateRevision,
    })

    expect(result.actions?.some((action) => String(action.payload?.message || '').includes(`垂直射击${side === 'left' ? '左侧' : '右侧'}命中`))).toBe(true)
    expect(result.pieces.find(piece => piece.instanceId === 'side-enemy')?.currentHp).toBe(15)
    expect(result.pieces.find(piece => piece.instanceId === 'opposite-enemy')?.currentHp).toBe(20)
    expect(result.pieces.find(piece => piece.instanceId === 'beyond-enemy')?.currentHp).toBe(20)
    expect(result.pieces.find(piece => piece.instanceId === 'path-enemy')?.currentHp).toBe(11)
  })

  it('extends Sonic spin dash target selection to seven cells at three momentum and stops at the selected cell', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/sonic-spin-dash.json'), 'utf8'))
    const sonic = makePiece({
      instanceId: 'sonic', templateId: 'sonic', ownerPlayerId: 'player-red', x: 2, y: 2,
      skills: [{ skillId: definition.id, currentCooldown: 0 }],
    })
    const state = makeState({ pieces: [sonic], width: 10, height: 10 })
    state.skillsById[definition.id] = definition
    state.players[0].actionPoints = 2

    const prepared = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'sonic', skillId: definition.id,
    })
    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    expect(prepared.candidates).toContainEqual({ type: 'cell', x: 2, y: 7 })
    expect(prepared.candidates).toContainEqual({ type: 'cell', x: 7, y: 2 })
    expect(prepared.candidates).not.toContainEqual({ type: 'cell', x: 9, y: 2 })
    expect(prepared.candidates).not.toContainEqual({ type: 'cell', x: 3, y: 3 })

    sonic.statusTags = [{ type: 'momentum-core', stacks: 3, skillIds: [definition.id] }]
    ;((sonic) as { momentum?: number }).momentum = 3
    const extended = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'sonic', skillId: definition.id,
    })
    expect(extended.kind).toBe('needTarget')
    if (extended.kind !== 'needTarget') return
    expect(extended.range).toBe(7)
    expect(extended.candidates).toContainEqual({ type: 'cell', x: 2, y: 9 })
    expect(extended.candidates).toContainEqual({ type: 'cell', x: 9, y: 2 })

    const direct = executeSkillFunction(definition, {
      piece: sonic, target: null, targetPosition: { x: 9, y: 2 },
      targets: [{ info: null, pos: { x: 9, y: 2 } }], skill: definition, battle: state,
    }, state)
    expect(direct).toMatchObject({ success: true })
    expect(sonic).toMatchObject({ x: 9, y: 2 })
  })

  it('replaces consumed Sonic momentum with the distance gained from spin dash', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/sonic-spin-dash.json'), 'utf8'))
    const sonic = makePiece({
      instanceId: 'sonic', templateId: 'sonic', ownerPlayerId: 'player-red', x: 0, y: 0,
      skills: [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }],
    })
    sonic.momentum = 4
    sonic.statusTags = [{ type: 'momentum-core', stacks: 4, skillIds: [definition.id] }]
    attachRule(sonic, 'rule-momentum-consume')
    const state = makeState({ pieces: [sonic], width: 9, height: 4 })
    state.skillsById[definition.id] = definition
    state.players[0].actionPoints = 2

    const prepared = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: sonic.instanceId, skillId: definition.id,
    })
    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    const resolved = applyBattleAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: sonic.instanceId, skillId: definition.id,
      targetX: 3, targetY: 0, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision,
    })
    const nextSonic = resolved.pieces.find((piece) => piece.instanceId === sonic.instanceId)

    expect(nextSonic).toMatchObject({ x: 3, y: 0, momentum: 3 })
    expect(nextSonic!.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'momentum-core', stacks: 3 }),
    ]))
  })

  it('presents exactly the two perpendicular endpoint cells instead of an option popup', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/shadow-ride-sweep.json'), 'utf8'))
    const shadow = makePiece({
      instanceId: 'shadow', templateId: 'shadow', ownerPlayerId: 'player-red', x: 1, y: 5, attack: 5,
      skills: [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }],
    })
    shadow.momentum = 5
    shadow.statusTags = [{ type: 'momentum-core', stacks: 5, skillIds: [definition.id] }]
    attachRule(shadow, 'rule-momentum-consume')
    const sideEnemy = makePiece({
      instanceId: 'side-enemy', ownerPlayerId: 'player-blue', x: 2, y: 1, currentHp: 20, maxHp: 20,
    })
    const state = makeState({ pieces: [shadow, sideEnemy], width: 7, height: 11 })
    state.skillsById[definition.id] = definition
    state.players[0].actionPoints = 10

    const prepared = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'shadow', skillId: definition.id,
    })
    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return

    const targetPending = applyBattleAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'shadow', skillId: definition.id,
      targetX: 4, targetY: 5,
      selectionId: prepared.selectionId, stateRevision: prepared.stateRevision,
    })
    expect(targetPending.pendingOptionSelection).toBeUndefined()
    const pending = targetPending.pendingTargetSelection
    if (!pending) throw new Error('Ride sweep did not suspend for its perpendicular direction')
    expect(pending.title).toContain('选择冲刺方向左侧或右侧地格')
    expect(pending.candidates).toEqual([
      { type: 'cell', x: 4, y: 4 },
      { type: 'cell', x: 4, y: 6 },
    ])

    const resolved = applyBattleAction(targetPending, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetX: 4, targetY: 4,
      selectionId: pending.selectionId, stateRevision: pending.stateRevision,
    })

    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.pieces.find(piece => piece.instanceId === 'side-enemy')?.currentHp).toBe(15)
    expect(((resolved.pieces.find(piece => piece.instanceId === 'shadow')) as { momentum?: number } | undefined)?.momentum).toBe(3)
  })

  it('pierces pieces but stops the perpendicular ray at cover and walls', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/shadow-ride-sweep.json'), 'utf8'))
    const shadow = makePiece({ instanceId: 'shadow', templateId: 'shadow', ownerPlayerId: 'player-red', x: 1, y: 5, attack: 5 })
    shadow.momentum = 5
    const first = makePiece({ instanceId: 'first', ownerPlayerId: 'player-blue', x: 2, y: 4, currentHp: 20, maxHp: 20 })
    const second = makePiece({ instanceId: 'second', ownerPlayerId: 'player-blue', x: 2, y: 3, currentHp: 20, maxHp: 20 })
    const blocked = makePiece({ instanceId: 'blocked', ownerPlayerId: 'player-blue', x: 2, y: 1, currentHp: 20, maxHp: 20 })
    const state = makeState({ pieces: [shadow, first, second, blocked], width: 7, height: 8 })
    const cover = state.map.tiles.find(tile => tile.x === 2 && tile.y === 2)!
    cover.props = { ...cover.props, type: 'cover', walkable: true, bulletPassable: false }

    shadow.statusTags = [{ type: 'momentum-core', stacks: 5, skillIds: [definition.id] }]
    attachRule(shadow, 'rule-momentum-consume')
    shadow.skills = [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }]
    state.skillsById[definition.id] = definition
    state.players[0].actionPoints = 10
    const prepared = prepareAction(state, { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'shadow', skillId: definition.id })
    if (prepared.kind !== 'needTarget') throw new Error('骑射横扫未请求冲刺终点')
    const selectingSide = applyBattleAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'shadow', skillId: definition.id,
      targetX: 4, targetY: 5, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision,
    })
    const pending = selectingSide.pendingTargetSelection
    if (!pending) throw new Error('骑射横扫未请求侧射地格')
    const result = applyBattleAction(selectingSide, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetX: 4, targetY: 4,
      selectionId: pending.selectionId, stateRevision: pending.stateRevision,
    })

    expect(result.pieces.find(piece => piece.instanceId === 'first')?.currentHp).toBe(15)
    expect(result.pieces.find(piece => piece.instanceId === 'second')?.currentHp).toBe(15)
    expect(result.pieces.find(piece => piece.instanceId === 'blocked')?.currentHp).toBe(20)
  })

  it.each(['wall', 'trap'])('rejects a ride sweep whose path crosses a %s', (terrainType) => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/shadow-ride-sweep.json'), 'utf8'))
    const shadow = makePiece({ instanceId: 'shadow', templateId: 'shadow', ownerPlayerId: 'player-red', x: 1, y: 2, attack: 5 })
    const beyond = makePiece({ instanceId: 'beyond', ownerPlayerId: 'player-blue', x: 4, y: 2, currentHp: 20, maxHp: 20 })
    const state = makeState({ pieces: [shadow, beyond], width: 7, height: 5 })
    const blocker = state.map.tiles.find(tile => tile.x === 3 && tile.y === 2)!
    blocker.props = { ...blocker.props, type: terrainType as typeof blocker.props.type, walkable: false }

    const result = executeSkillFunction(definition, {
      piece: shadow, target: null, targetPosition: { x: 5, y: 2 }, targets: [{ info: null, pos: { x: 5, y: 2 } }],
      skill: definition, battle: state,
    }, state)

    expect(result).toMatchObject({ success: false, message: '冲刺路径被墙体、陷阱或不可通行地形阻挡' })
    expect(shadow).toMatchObject({ x: 1, y: 2 })
    expect(beyond.currentHp).toBe(20)
  })

  it('keeps generic dash candidates but rejects a target whose path crosses a blocker', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/shadow-ride-sweep.json'), 'utf8'))
    const shadow = makePiece({ instanceId: 'shadow', templateId: 'shadow', ownerPlayerId: 'player-red', x: 1, y: 2 })
    const occupied = makePiece({ instanceId: 'occupied', ownerPlayerId: 'player-blue', x: 2, y: 2 })
    const state = makeState({ pieces: [shadow, occupied], width: 7, height: 5 })
    state.skillsById[definition.id] = definition
    state.players[0].actionPoints = 10
    const blocker = state.map.tiles.find(tile => tile.x === 3 && tile.y === 2)!
    blocker.props = { ...blocker.props, type: 'wall', walkable: false }

    const prepared = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'shadow', skillId: definition.id,
    })

    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    expect(prepared.candidates).toContainEqual({ type: 'cell', x: 1, y: 1 })
    expect(prepared.candidates).not.toContainEqual({ type: 'cell', x: 2, y: 1 })
    expect(prepared.candidates).not.toContainEqual({ type: 'cell', x: 2, y: 2 })
    expect(prepared.candidates).not.toContainEqual({ type: 'cell', x: 3, y: 2 })
    expect(prepared.candidates).toContainEqual({ type: 'cell', x: 4, y: 2 })
    const result = executeSkillFunction(definition, {
      piece: shadow, target: null, targetPosition: { x: 4, y: 2 }, targets: [{ info: null, pos: { x: 4, y: 2 } }],
      skill: definition, battle: state,
    }, state)
    expect(result).toMatchObject({ success: false, message: '冲刺路径被墙体、陷阱或不可通行地形阻挡' })
    expect(shadow).toMatchObject({ x: 1, y: 2 })
  })

  it('rejects diagonal ride sweep targets even when invoked outside the selector', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/shadow-ride-sweep.json'), 'utf8'))
    const shadow = makePiece({ instanceId: 'shadow', templateId: 'shadow', ownerPlayerId: 'player-red', x: 1, y: 1 })
    const state = makeState({ pieces: [shadow], width: 5, height: 5 })

    const result = executeSkillFunction(definition, {
      piece: shadow, target: null, targetPosition: { x: 3, y: 3 }, targets: [{ info: null, pos: { x: 3, y: 3 } }],
      skill: definition, battle: state,
    }, state)

    expect(result).toMatchObject({ success: false, message: '请选择7格内上下左右方向' })
  })

  it.each([
    ['sonic', 'sonic-spin-dash'],
    ['shadow', 'shadow-ride-sweep'],
    ['tails', 'tails-mechanical-support'],
  ])('grants momentum to %s after a normal move through the real skill repository', (templateId, skillId) => {
    const piece = makePiece({ instanceId: templateId, templateId, x: 0, y: 0, skills: [{ skillId }] })
    piece.statusTags = [{ type: 'momentum-core', stacks: 0 }]
    attachRule(piece, 'rule-momentum-gain')
    const state = makeState({ pieces: [piece] })

    const next = applyBattleAction(state, { type: 'move', playerId: 'player-red', pieceId: templateId, toX: 2, toY: 0 })
    expect(((next.pieces[0]) as { momentum?: number }).momentum).toBe(2)
  })

  it.each(['sonic', 'shadow', 'tails'])('hydrates %s’s template-declared momentum rules before a normal move', (templateId) => {
    const template = JSON.parse(readFileSync(resolve(process.cwd(), `data/pieces/${templateId}.json`), 'utf8'))
    const state = makeState({ width: 8, height: 8 })
    state.pieces = buildInitialPiecesForPlayers(
      state.map,
      ['player-red', 'player-blue'],
      [template, template],
      [
        { playerId: 'player-red', pieces: [template], faction: 'red' },
        { playerId: 'player-blue', pieces: [template], faction: 'blue' },
      ],
      () => 0,
    )
    const piece = state.pieces.find((item) => item.ownerPlayerId === 'player-red')
    piece!.x = 0
    piece!.y = 0
    state.pieces.find((piece) => piece.ownerPlayerId === 'player-blue')!.x = 7
    state.pieces.find((piece) => piece.ownerPlayerId === 'player-blue')!.y = 7

    const next = applyBattleAction(state, {
      type: 'move', playerId: 'player-red', pieceId: piece!.instanceId, toX: 2, toY: 0,
    })
    const movedPiece = next.pieces.find((item) => item.instanceId === piece!.instanceId)

    expect((movedPiece! as { momentum?: number }).momentum).toBe(2)
    expect(movedPiece!.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'momentum-core', stacks: 2 }),
    ]))
    expect(movedPiece!.rules.map((rule) => rule.id)).toEqual(expect.arrayContaining([
      'rule-momentum-gain', 'rule-momentum-consume',
    ]))
  })

  it('grants temporary action points and keeps the displayed momentum in sync through Sonic Super Form', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/sonic-super-form.json'), 'utf8'))
    const spinDash = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/sonic-spin-dash.json'), 'utf8'))
    const sonic = makePiece({
      instanceId: 'sonic', templateId: 'sonic', ownerPlayerId: 'player-red',
      skills: [
        { skillId: definition.id, currentCooldown: 0, usesRemaining: -1 },
        { skillId: spinDash.id, currentCooldown: 0, usesRemaining: -1 },
      ],
    })
    sonic.momentum = 4
    sonic.statusTags = [{ type: 'momentum-core', stacks: 4, skillIds: ['sonic-spin-dash', 'sonic-homing-attack'] }]
    attachRule(sonic, 'rule-momentum-consume')
    const state = makeState({ pieces: [sonic] })
    state.skillsById[definition.id] = definition
    state.skillsById[spinDash.id] = spinDash
    state.players[0].actionPoints = 0
    state.players[0].chargePoints = 3

    const next = applyBattleAction(state, {
      type: 'useChargeSkill', playerId: 'player-red', pieceId: sonic.instanceId, skillId: definition.id,
    })
    const nextSonic = next.pieces.find((piece) => piece.instanceId === sonic.instanceId)

    expect(next.players[0]).toMatchObject({ actionPoints: 2, chargePoints: 0 })
    expect((nextSonic! as { momentum?: number }).momentum).toBe(4)
    expect(nextSonic!.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'preserve-momentum' }),
    ]))

    const dashed = executeSkillFunction(spinDash, {
      piece: nextSonic!, target: null, targetPosition: { x: 1, y: 0 },
      targets: [{ info: null, pos: { x: 1, y: 0 } }], skill: spinDash, battle: next,
    }, next)
    const core = nextSonic!.statusTags.find((tag) => tag.type === 'momentum-core')

    expect(dashed.success).toBe(true)
    expect((nextSonic! as { momentum?: number }).momentum).toBe(5)
    expect(core?.stacks).toBe(5)
  })

  it('does not grant momentum to a piece without a momentum skill', () => {
    const piece = makePiece({ instanceId: 'ordinary', x: 0, y: 0, skills: [] })
    const state = makeState({ pieces: [piece] })
    const next = applyBattleAction(state, { type: 'move', playerId: 'player-red', pieceId: 'ordinary', toX: 2, toY: 0 })
    expect(((next.pieces[0]) as { momentum?: number }).momentum).toBeUndefined()
  })

  it('lets Sonic make exactly one free normal move each turn', () => {
    const sonic = makePiece({ instanceId: 'sonic', templateId: 'sonic', x: 0, y: 0, actionPoints: 1 })
    attachRule(sonic, 'rule-sonic-free-move')
    const state = makeState({ pieces: [sonic], phase: 'start' })
    state.players[0].actionPoints = 0

    const afterBeginTurn = applyBattleAction(state, { type: 'beginPhase' })
    expect(afterBeginTurn.pieces[0].statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'deployment-first-move-free',
        grantedTurnNumber: 1,
        currentUses: 1,
      }),
    ]))
    const afterFreeMove = applyBattleAction(afterBeginTurn, { type: 'move', playerId: 'player-red', pieceId: 'sonic', toX: 1, toY: 0 })
    expect(afterFreeMove.players[0].actionPoints).toBe(0)
    afterFreeMove.players[0].actionPoints = 1
    expect(applyBattleAction(afterFreeMove, { type: 'move', playerId: 'player-red', pieceId: 'sonic', toX: 2, toY: 0 }).players[0].actionPoints).toBe(0)
  })

  it('grants a Mechanical Support target the existing one-use free-move status at eight momentum', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/tails-mechanical-support.json'), 'utf8'))
    const tails = makePiece({
      instanceId: 'tails', templateId: 'tails', ownerPlayerId: 'player-red', x: 0, y: 0,
      skills: [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }],
    })
    tails.momentum = 8
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 1, y: 0, statusTags: [] })
    const state = makeState({ pieces: [tails, ally] })
    state.skillsById[definition.id] = definition
    state.players[0].actionPoints = 1
    const prepared = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'tails', skillId: definition.id,
    })
    if (prepared.kind !== 'needTarget') throw new Error('机械支援未开始目标选择')

    const supported = applyBattleAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'tails', skillId: definition.id,
      targetPieceId: ally.instanceId, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision,
    })
    expect(supported.pieces.find(piece => piece.instanceId === ally.instanceId)?.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'deployment-first-move-free',
        grantedTurnNumber: supported.turn.turnNumber,
        currentUses: 1,
      }),
    ]))
    const afterFreeMove = applyBattleAction(supported, {
      type: 'move', playerId: 'player-red', pieceId: ally.instanceId, toX: 2, toY: 0,
    })
    expect(afterFreeMove.players[0].actionPoints).toBe(0)
    expect(afterFreeMove.pieces.find(piece => piece.instanceId === ally.instanceId)?.statusTags)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'deployment-first-move-free' })]))
    expect(() => applyBattleAction(afterFreeMove, {
      type: 'move', playerId: 'player-red', pieceId: ally.instanceId, toX: 3, toY: 0,
    })).toThrow(BattleRuleError)
  })

  it('prevents ordinary movement into a Double Tail Flight reserved landing tile', () => {
    const piece = makePiece({ instanceId: 'p1', x: 0, y: 0 })
    const state = makeState({ pieces: [piece] })
    state.extensions = { tileEffects: [{ type: 'tails-flight-reservation', x: 1, y: 0 }] }
    attachRule(state.players[0], 'rule-tails-flight-reservation-block')

    const next = applyBattleAction(state, { type: 'move', playerId: 'player-red', pieceId: 'p1', toX: 1, toY: 0 })
    expect(next.pieces[0]).toMatchObject({ x: 0, y: 0 })
  })

  it('makes a Double Tail Flight immune target take no damage', () => {
    const attacker = makePiece({ instanceId: 'attacker', ownerPlayerId: 'player-red', x: 0, y: 0 })
    const target = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 10, statusTags: [{ type: 'immune' }] })
    const state = makeState({ pieces: [attacker, target] })
    attachRule(target, 'rule-tails-flight-immune')

    expect(dealDamage(attacker as unknown as import('@/lib/game/piece').PieceInstance, target as unknown as import('@/lib/game/piece').PieceInstance, 5, 'physical', state).damage).toBe(0)
    expect(target.currentHp).toBe(10)
  })

  it('applies every recovery module at the end of its owner turn', () => {
    const piece = makePiece({ instanceId: 'armored', currentHp: 5, maxHp: 20, statusTags: [{ type: 'periodic-heal' }, { type: 'periodic-heal' }] })
    const state = makeState({ pieces: [piece] })
    attachRule(piece, 'rule-tails-armor-recovery')
    const next = applyBattleAction(state, { type: 'endTurn', playerId: 'player-red' })
    expect(next.pieces[0].currentHp).toBe(11)
  })
})
