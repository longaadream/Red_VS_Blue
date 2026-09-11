import type { BattleState } from '../../game/turn'
import { addCardToHandWithTriggers, loadCardForBattle } from '../../game/skills'
import { adventureCards } from '../../game/adventure-card-state'
import type { RoguelikeSuppliesV1 } from '../contracts/roguelike-content-v1'
import { getBattleRootSeed } from '../../game/battle-trace'
import { RuleRuntime, deriveStreamSeed, createRuleExecutionContext, withRuleExecutionContext, withRuleRuntime } from '../../game/rule-runtime'
import { TriggerSystem } from '../../game/triggers'
import { createEffectChain, withEffectChain } from '../../game/effect-batch'
import { restorePieceRules, restorePlayerRules } from '../../game/turn'
import { captureSerializableRuleEffects, withoutRuntimeRuleEffects } from '../../game/battle-runner'

/** Called only on a session's uncommitted clone. World receipts include these cursors;
 * native battle actions retain their existing trace and random streams. */
export function withAdventureSupplyRuntime<T>(state: BattleState, operation: () => T): T {
  const run = adventureCards(state), rootSeed = getBattleRootSeed(state)
  if (!run || rootSeed === undefined) throw new Error('缺少冒险供牌种子或状态')
  const runtime = new RuleRuntime({ rootSeed: deriveStreamSeed(rootSeed, 'adventure-supplies'), ...run.supplyRuntime })
  const serializedEffects = captureSerializableRuleEffects(state)
  const chain = createEffectChain({ actionId: `supply-${run.supplyRuntime.tick}`, chainId: `supply-chain-${run.supplyRuntime.tick}`,
    turn: state.turn.turnNumber, rootSeed: runtime.rootSeed,
    createBatchId: ({ kind }) => runtime.nextInstanceId(`${kind}-batch`, `${kind}-batch`) })
  const result = withRuleExecutionContext(createRuleExecutionContext(new TriggerSystem()), () =>
    withRuleRuntime(runtime, () => withEffectChain(state, chain, () => {
      restorePieceRules(state)
      restorePlayerRules(state)
      const value = operation()
      chain.assertHealthy()
      return value
    })))
  Object.assign(state, withoutRuntimeRuleEffects(state, serializedEffects))
  run.supplyRuntime = { tick: run.supplyRuntime.tick + 1, cursors: runtime.snapshot().cursors }
  return result
}

export function grantAdventureCards(state: BattleState, playerId: string, cardId: string, count: number,
  lifetime: 'run' | 'encounter', sourceId: string): void {
  const run = adventureCards(state)
  if (!run?.players[playerId]) throw new Error('缺少冒险供牌记录')
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('供牌数量无效')
  if (!loadCardForBattle(state, cardId)) throw new Error(`缺少可用卡牌 ${cardId}`)
  for (let i = 0; i < count; i++) {
    const instanceId = `adventure-card-${++run.serial}`
    if (!addCardToHandWithTriggers(state, cardId, playerId, undefined, {
      instanceId, contentState: { adventure: { lifetime, sourceId } },
    })) throw new Error('供牌被当前规则阻止')
  }
}

export function supplyEncounter(state: BattleState, playerId: string, encounterId: string, config: RoguelikeSuppliesV1): void {
  const run = adventureCards(state)!, player = run.players[playerId]
  if (run.suppliedEncounters.includes(encounterId)) return
  run.suppliedEncounters.push(encounterId)
  player.passiveHits = {}
  for (const relicId of player.relicIds) {
    const relic = config.relics.find(relic => relic.id === relicId)
    if (!relic) throw new Error(`缺少遗物 ${relicId}`)
    for (const grant of relic.grants) grantAdventureCards(state, playerId, grant.cardId, grant.count, 'encounter', relicId)
  }
}

export function cleanupAdventureCards(state: BattleState, ownerId?: string): void {
  const run = adventureCards(state)
  for (const player of state.players) {
    if (ownerId && player.playerId !== ownerId) continue
    player.hand = (player.hand ?? []).filter(card => (card.contentState?.adventure as { lifetime?: unknown } | undefined)?.lifetime === 'run')
    player.discardPile = []
    if (run?.players[player.playerId]) {
      run.players[player.playerId].passiveHits = {}
      run.players[player.playerId].overflow = run.players[player.playerId].overflow.filter(card => card.contentState?.adventure?.lifetime === 'run')
    }
  }
}

export function offerAdventureRewards(state: BattleState, playerId: string, encounterId: string, config: RoguelikeSuppliesV1, allowRelic=true): void {
  const run = adventureCards(state)!
  const ledger=run.players[playerId]
  const eligible=allowRelic&&(config.rewardRelicLimit===undefined||(ledger.earnedRelics??0)<config.rewardRelicLimit)
  const reward = { encounterId, relicIds: eligible?config.rewardRelicIds.filter(id => !ledger.relicIds.includes(id)):[], cardIds: [...config.rewardCardIds] }
  if (run.rewards) run.rewards[playerId] = reward
  else run.reward = reward
}

export function chooseAdventureSupply(state: BattleState, playerId: string, operation: string, choice: string, config: RoguelikeSuppliesV1): void {
  const run = adventureCards(state)!, ledger = run.players[playerId], player = state.players.find(p => p.playerId === playerId)!
  if (ledger.overflow.length) {
    if (operation !== 'discard') throw new Error('先处理溢出的手牌')
    const incoming = ledger.overflow[0]
    if (choice === incoming.instanceId) ledger.overflow.shift()
    else {
      const index = player.hand.findIndex(card => card.instanceId === choice)
      if (index < 0) throw new Error('请选择当前手牌或新获得的卡牌')
      const [discarded] = player.hand.splice(index, 1)
      player.discardPile ??= []; player.discardPile.push(discarded.cardId)
      ledger.overflow.shift()
      if (!addCardToHandWithTriggers(state, incoming.cardId, playerId, undefined, incoming)) throw new Error('卡牌加入被阻止')
    }
    return
  }
  const reward = run.rewards ? run.rewards[playerId] : run.reward
  if (!reward) throw new Error('当前没有待领取的奖励')
  if (operation === 'relic' && reward.relicIds.includes(choice)) {
    if(config.rewardRelicLimit!==undefined&&(ledger.earnedRelics??0)>=config.rewardRelicLimit)throw new Error('本次冒险的遗物奖励已领取')
    ledger.earnedRelics=(ledger.earnedRelics??0)+1
    ledger.relicIds.push(choice); reward.relicIds = []
  } else if (operation === 'cards' && reward.cardIds.includes(choice)) {
    grantAdventureCards(state, playerId, choice, config.rewardCopies, 'run', reward.encounterId)
    reward.cardIds = []
  } else if (operation === 'skip-relic' && reward.relicIds.length) reward.relicIds = []
  else if (operation === 'skip-cards' && reward.cardIds.length) reward.cardIds = []
  else throw new Error('奖励选项无效或已经领取')
  if (!reward.relicIds.length && !reward.cardIds.length) {
    if (run.rewards) delete run.rewards[playerId]
    else delete run.reward
  }
}
