import { afterEach, beforeEach, expect, it } from 'vitest'
import { runBattleAction } from '@/lib/game/battle-runner'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

beforeEach(() => globalTriggerSystem.clearRules())
afterEach(() => globalTriggerSystem.clearRules())

it('passes the exact paid skill instance into a real action when IDs repeat', () => {
  const piece = makePiece({ instanceId: 'caster', skills: [
    { skillId: 'instance-probe', currentCooldown: 0, level: 1 },
    { skillId: 'instance-probe', currentCooldown: 7, level: 8 },
  ] })
  const state = makeState({ pieces: [piece, makePiece({ instanceId: 'opponent', ownerPlayerId: 'player-blue', x: 3 })] })
  state.skillsById['instance-probe'] = {
    id: 'instance-probe', name: 'Instance probe', description: '', icon: '', kind: 'active', type: 'normal',
    cooldownTurns: 1, maxCharges: 0, powerMultiplier: 1, actionPointCost: 0, range: 'self', requiresTarget: false,
    code: 'function executeSkill(){ const current=flow.skills.current().instance; flow.skills.setInstanceField(current,"level",3); return {success:true}; }',
  }
  const next = runBattleAction(state, { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'caster', skillId: 'instance-probe' }, { rootSeed: 252 }).state
  expect(next.pieces.find(item => item.instanceId === 'caster')?.skills.map(skill => skill.level)).toEqual([3, 8])
  expect(state.pieces[0].skills.map(skill => skill.level)).toEqual([1, 8])
})
