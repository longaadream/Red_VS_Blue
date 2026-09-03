import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyBattleAction, BattleRuleError } from '@/lib/game/turn'
import { dealDamage, executeSkillFunction, loadRuleById } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { makePiece, makeState } from '../helpers/minimal-state'

describe('Sonic roster mechanics', () => {
  const attachRule = (piece: any, ruleId: string) => {
    piece.rules = [...(piece.rules || []), loadRuleById(ruleId)]
    return piece
  }

  it('does not render momentum as a base stat in the complete piece panel', () => {
    const battlePage = readFileSync(resolve(process.cwd(), 'data/pages/battle.html'), 'utf8')
    const statsTemplate = battlePage.match(/const statsHtml = `([\s\S]*?)`\s*\/\/ Skills/)

    expect(statsTemplate).not.toBeNull()
    expect(statsTemplate?.[1]).not.toContain('pieceMomentumValue')
    expect(battlePage).toContain("momentumDisplay.textContent = showsMomentum ? '动能 '")
  })

  it('documents the complete momentum acquisition and consumption contract', () => {
    const glossary = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skill-keywords.json'), 'utf8'))
    const momentum = glossary.find((entry: any) => entry.name === '动能')
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
      skills: [{ skillId: 'shadow-ride-sweep', currentCooldown: 0 } as any] as any,
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
      }) as any
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
      } as any, state)
      return { result: result as any, state }
    }

    const belowThreshold = executeAtMomentum(4)
    expect(belowThreshold.result.success).toBe(true)
    expect(belowThreshold.state.pieces.find(piece => piece.instanceId === 'enemy')?.currentHp).toBe(15)

    const atThreshold = executeAtMomentum(5)
    expect(atThreshold.result.success).toBe(true)
    expect(atThreshold.result.needsOptionSelection).toBeUndefined()
    expect((atThreshold.state.pieces[0] as any).statusTags).toEqual(expect.arrayContaining([
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
    } as any, state) as any

    expect(result.success).toBe(true)
    expect(enemy.statusTags.find((tag: any) => tag.type === 'silenced')?.relatedRules).toContain('rule-silenced-block')
    expect(enemy.statusTags.find((tag: any) => tag.type === 'chidori-immobile')?.relatedRules).toContain('rule-chidori-immobile')
    expect(enemy.rules.map((rule: any) => rule.id)).toEqual(expect.arrayContaining(['rule-silenced-block', 'rule-chidori-immobile']))
  })

  it('only exposes empty floor and cover cells for Shadow chaos control', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/shadow-chaos-control.json'), 'utf8'))
    const shadow = makePiece({
      instanceId: 'shadow', templateId: 'shadow', ownerPlayerId: 'player-red', x: 1, y: 1,
      skills: [{ skillId: definition.id, currentCooldown: 0 } as any] as any,
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
      skills: [{ skillId: definition.id, currentCooldown: 0 } as any] as any,
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
    expect(third.candidates).toContainEqual({ type: 'cell', x: 4, y: 4 })
    expect(third.candidates).not.toContainEqual({ type: 'cell', x: 6, y: 4 })
  })

  it('rejects a forged Double Tail Flight command that selects Tails as the carried ally', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/tails-twin-flight.json'), 'utf8'))
    const tails = makePiece({ instanceId: 'tails', templateId: 'tails', ownerPlayerId: 'player-red', x: 1, y: 1 })
    const state = makeState({ pieces: [tails], width: 8, height: 8 })

    const result = executeSkillFunction(definition, {
      piece: tails, target: tails, targets: [{ info: tails, pos: null }], skill: definition, battle: state,
    } as any, state) as any

    expect(result).toMatchObject({ success: false, message: '双尾飞行必须选择另一名友军' })
  })

  it('reserves the selected Double Tail Flight landing cells and applies its status effects', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/tails-twin-flight.json'), 'utf8'))
    const tails = makePiece({
      instanceId: 'tails', templateId: 'tails', ownerPlayerId: 'player-red', x: 1, y: 1,
      skills: [{ skillId: definition.id, currentCooldown: 0 } as any] as any,
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
    } as any)

    expect(resolved.extensions.scheduledTransfers).toBeUndefined()
    expect(resolved.extensions.tileEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tails-flight-reservation', x: 4, y: 4 }),
      expect.objectContaining({ type: 'tails-flight-reservation', x: 4, y: 5 }),
    ]))
    for (const piece of [resolved.pieces.find(piece => piece.instanceId === 'tails'), resolved.pieces.find(piece => piece.instanceId === 'ally')]) {
      expect(piece?.statusTags.map((tag: any) => tag.type)).toEqual(expect.arrayContaining(['immune', 'inoperable']))
      expect(piece?.statusTags).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'immune', remainingDuration: 2 }),
        expect.objectContaining({ type: 'inoperable', remainingDuration: 2 }),
      ]))
    }
    expect(resolved.pieces.find(piece => piece.instanceId === 'tails')?.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tails-flight-reservation', turns: 2 }),
    ]))
  })

  it('resolves Double Tail Flight only at the second subsequent allied turn start', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/tails-twin-flight.json'), 'utf8'))
    const tails = makePiece({
      instanceId: 'tails', templateId: 'tails', ownerPlayerId: 'player-red', x: 1, y: 1,
      skills: [{ skillId: definition.id, currentCooldown: 0 } as any] as any,
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
    } as any)
    const firstAlliedStart = applyBattleAction({
      ...reserved, turn: { ...reserved.turn, currentPlayerId: 'player-red', phase: 'start', turnNumber: reserved.turn.turnNumber + 2 },
    }, { type: 'beginPhase' })
    expect(firstAlliedStart.pieces.find(piece => piece.instanceId === 'tails')).toMatchObject({ x: 1, y: 1 })
    expect(firstAlliedStart.pieces.find(piece => piece.instanceId === 'tails')?.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tails-flight-reservation', turns: 1 }),
    ]))
    const secondAlliedStart = applyBattleAction({
      ...firstAlliedStart, turn: { ...firstAlliedStart.turn, currentPlayerId: 'player-red', phase: 'start', turnNumber: firstAlliedStart.turn.turnNumber + 2 },
    }, { type: 'beginPhase' })
    expect(secondAlliedStart.pieces.find(piece => piece.instanceId === 'tails')).toMatchObject({ x: 4, y: 4 })
    expect(secondAlliedStart.pieces.find(piece => piece.instanceId === 'ally')).toMatchObject({ x: 4, y: 5 })
    expect(secondAlliedStart.pieces.find(piece => piece.instanceId === 'tails')?.statusTags.some((tag: any) => tag.type === 'tails-flight-reservation')).toBe(false)
  })

  it('lets Mechanical Support remove any selected target effect after healing', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/tails-mechanical-support.json'), 'utf8'))
    const tails = makePiece({
      instanceId: 'tails', templateId: 'tails', ownerPlayerId: 'player-red',
      skills: [{ skillId: definition.id, currentCooldown: 0 } as any] as any,
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
    expect(pending.options.map((option: any) => option.label)).toEqual(['沉默（1）', '护盾（2）'])
    const resolved = applyBattleAction(selecting, {
      type: 'pendingOptionSelect', playerId: 'player-red', selectedOption: '1',
      selectionId: pending.selectionId, stateRevision: pending.stateRevision,
    })
    const result = resolved.pieces.find(piece => piece.instanceId === 'ally')!
    expect(result.currentHp).toBe(85)
    expect(result.statusTags.map((tag: any) => tag.type)).toEqual(['silenced'])
  })

  it('creates the selected permanent armor card through Tails’s charge skill', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/tails-armor-assembly.json'), 'utf8'))
    const tails = makePiece({
      instanceId: 'tails', templateId: 'tails', ownerPlayerId: 'player-red',
      skills: [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 } as any] as any,
    })
    const state = makeState({ pieces: [tails] })
    state.skillsById[definition.id] = definition
    state.players[0].chargePoints = 2

    const selecting = applyBattleAction(state, {
      type: 'useChargeSkill', playerId: 'player-red', pieceId: 'tails', skillId: definition.id,
    })
    const pending = selecting.pendingOptionSelection
    if (!pending) throw new Error('护甲组装未请求模块选择')

    expect(pending.options.map((option: any) => option.value)).toEqual(['heal', 'attack', 'speed', 'defense'])
    expect(pending).toMatchObject({ selectionMode: 'multi', minSelections: 2, maxSelections: 2 })
    const resolved = applyBattleAction(selecting, {
      type: 'pendingOptionSelect', playerId: 'player-red', selectedOption: ['heal', 'attack'],
      selectionId: pending.selectionId, stateRevision: pending.stateRevision,
    })

    expect(resolved.players[0].hand).toEqual(expect.arrayContaining([
      expect.objectContaining({ cardId: 'armor-attack-heal', actionPointCost: 2 }),
    ]))
    expect(resolved.customCards['armor-attack-heal']).toMatchObject({ type: 'active', actionPointCost: 2 })
  })

  it.each([
    ['left', 4, 1, 9, 0],
    ['right', 6, 9, 1, 10],
  ])('fires ride sweep up to four cells along the %s perpendicular ray', (side, selectionY, targetY, oppositeY, beyondY) => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/shadow-ride-sweep.json'), 'utf8'))
    const shadow = makePiece({
      instanceId: 'shadow', templateId: 'shadow', ownerPlayerId: 'player-red', x: 1, y: 5, attack: 9,
    }) as any
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

    expect(result.actions?.some((action: any) => String(action.payload?.message || '').includes(`垂直射击${side === 'left' ? '左侧' : '右侧'}命中`))).toBe(true)
    expect(result.pieces.find(piece => piece.instanceId === 'side-enemy')?.currentHp).toBe(15)
    expect(result.pieces.find(piece => piece.instanceId === 'opposite-enemy')?.currentHp).toBe(20)
    expect(result.pieces.find(piece => piece.instanceId === 'beyond-enemy')?.currentHp).toBe(20)
    expect(result.pieces.find(piece => piece.instanceId === 'path-enemy')?.currentHp).toBe(11)
  })

  it('limits Sonic spin dash to the four cardinal directions in both selector and execution', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/sonic-spin-dash.json'), 'utf8'))
    const sonic = makePiece({
      instanceId: 'sonic', templateId: 'sonic', ownerPlayerId: 'player-red', x: 2, y: 2,
      skills: [{ skillId: definition.id, currentCooldown: 0 } as any] as any,
    })
    const state = makeState({ pieces: [sonic], width: 8, height: 8 })
    state.skillsById[definition.id] = definition
    state.players[0].actionPoints = 2

    const prepared = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'sonic', skillId: definition.id,
    })
    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    expect(prepared.candidates).toContainEqual({ type: 'cell', x: 2, y: 7 })
    expect(prepared.candidates).toContainEqual({ type: 'cell', x: 7, y: 2 })
    expect(prepared.candidates).not.toContainEqual({ type: 'cell', x: 3, y: 3 })

    const direct = executeSkillFunction(definition, {
      piece: sonic, target: null, targetPosition: { x: 4, y: 4 },
      targets: [{ info: null, pos: { x: 4, y: 4 } }], skill: definition, battle: state,
    } as any, state) as any
    expect(direct).toMatchObject({ success: false, message: '请选择5格内上下左右方向' })
    expect(sonic).toMatchObject({ x: 2, y: 2 })
  })

  it('presents exactly the two perpendicular endpoint cells instead of an option popup', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/shadow-ride-sweep.json'), 'utf8'))
    const shadow = makePiece({
      instanceId: 'shadow', templateId: 'shadow', ownerPlayerId: 'player-red', x: 1, y: 5, attack: 5,
      skills: [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 } as any] as any,
    }) as any
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
    expect((resolved.pieces.find(piece => piece.instanceId === 'shadow') as any)?.momentum).toBe(0)
  })

  it('pierces pieces but stops the perpendicular ray at cover and walls', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/shadow-ride-sweep.json'), 'utf8'))
    const shadow = makePiece({ instanceId: 'shadow', templateId: 'shadow', ownerPlayerId: 'player-red', x: 1, y: 5, attack: 5 }) as any
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
    blocker.props = { ...blocker.props, type: terrainType, walkable: false }

    const result = executeSkillFunction(definition, {
      piece: shadow, target: null, targetPosition: { x: 5, y: 2 }, targets: [{ info: null, pos: { x: 5, y: 2 } }],
      skill: definition, battle: state,
    } as any, state) as any

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
    } as any, state) as any
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
    } as any, state) as any

    expect(result).toMatchObject({ success: false, message: '请选择7格内上下左右方向' })
  })

  it.each([
    ['sonic', 'sonic-spin-dash'],
    ['shadow', 'shadow-ride-sweep'],
    ['tails', 'tails-mechanical-support'],
  ])('grants momentum to %s after a normal move through the real skill repository', (templateId, skillId) => {
    const piece = makePiece({ instanceId: templateId, templateId, x: 0, y: 0, skills: [{ skillId } as any] as any })
    piece.statusTags = [{ type: 'momentum-core', stacks: 0 }]
    attachRule(piece, 'rule-momentum-gain')
    const state = makeState({ pieces: [piece] })

    const next = applyBattleAction(state, { type: 'move', playerId: 'player-red', pieceId: templateId, toX: 2, toY: 0 })
    expect((next.pieces[0] as any).momentum).toBe(2)
  })

  it('does not grant momentum to a piece without a momentum skill', () => {
    const piece = makePiece({ instanceId: 'ordinary', x: 0, y: 0, skills: [] })
    const state = makeState({ pieces: [piece] })
    const next = applyBattleAction(state, { type: 'move', playerId: 'player-red', pieceId: 'ordinary', toX: 2, toY: 0 })
    expect((next.pieces[0] as any).momentum).toBeUndefined()
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

  it('grants a status-less Mechanical Support target one existing free move at eight momentum', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/tails-mechanical-support.json'), 'utf8'))
    const tails = makePiece({
      instanceId: 'tails', templateId: 'tails', ownerPlayerId: 'player-red', x: 0, y: 0,
      skills: [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 } as any] as any,
    }) as any
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
        grantedTurnNumber: 1,
        currentUses: 1,
      }),
    ]))
    expect(applyBattleAction(supported, {
      type: 'move', playerId: 'player-red', pieceId: ally.instanceId, toX: 2, toY: 0,
    }).players[0].actionPoints).toBe(0)
  })

  it('prevents ordinary movement into a Double Tail Flight reserved landing tile', () => {
    const piece = makePiece({ instanceId: 'p1', x: 0, y: 0 })
    const state = makeState({ pieces: [piece] })
    state.extensions = { tileEffects: [{ type: 'tails-flight-reservation', x: 1, y: 0 }] }
    attachRule(state.players[0] as any, 'rule-tails-flight-reservation-block')

    const next = applyBattleAction(state, { type: 'move', playerId: 'player-red', pieceId: 'p1', toX: 1, toY: 0 })
    expect(next.pieces[0]).toMatchObject({ x: 0, y: 0 })
  })

  it('makes a Double Tail Flight immune target take no damage', () => {
    const attacker = makePiece({ instanceId: 'attacker', ownerPlayerId: 'player-red', x: 0, y: 0 }) as any
    const target = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 10, statusTags: [{ type: 'immune' }] }) as any
    const state = makeState({ pieces: [attacker, target] })
    attachRule(target, 'rule-tails-flight-immune')

    expect(dealDamage(attacker, target, 5, 'physical', state).damage).toBe(0)
    expect(target.currentHp).toBe(10)
  })

  it('applies every recovery module at the end of its owner turn', () => {
    const piece = makePiece({ instanceId: 'armored', currentHp: 5, maxHp: 20, statusTags: [{ type: 'periodic-heal' }, { type: 'periodic-heal' }] }) as any
    const state = makeState({ pieces: [piece] })
    attachRule(piece, 'rule-tails-armor-recovery')
    const next = applyBattleAction(state, { type: 'endTurn', playerId: 'player-red' })
    expect(next.pieces[0].currentHp).toBe(11)
  })
})
