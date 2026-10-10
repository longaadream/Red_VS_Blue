import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayJsonValue,
  type GameplayModuleGraph,
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'

type Value = GameplayValue
type Statement = GameplayStatement

const value = (item: GameplayJsonValue): Value => ({ kind: 'literal', value: item })
const output = (node: string, port: string): Value => ({ kind: 'output', node, port })
const call = (
  id: string,
  module: string,
  inputs: Record<string, Value> = {},
  parameters: Record<string, GameplayJsonValue> = {},
): Statement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const ifThen = (id: string, condition: Value, then: readonly Statement[], otherwise?: readonly Statement[]): Statement => ({ kind: 'if', id, condition, then, ...(otherwise ? { else: otherwise } : {}) })
const result = (id: string, success: boolean, message: Value): Statement[] => {
  const resultId = `${id}-result`
  return [
    call(resultId, 'result.action', { success: value(success), message }),
    { kind: 'return', id: `${id}-return`, value: output(resultId, 'result') },
  ]
}
const fail = (id: string, message: GameplayJsonValue = ''): Statement[] => result(id, false, value(message))

/** Append a typed text concatenation chain while retaining the original order. */
const text = (body: Statement[], id: string, parts: readonly Value[]): Value => {
  let current: Value = value('')
  parts.forEach((part, index) => {
    const node = `${id}-${index}`
    body.push(call(node, 'text.concat', { left: current, right: part }))
    current = output(node, 'text')
  })
  return current
}

const graph = (body: readonly Statement[]): GameplayModuleGraph => ({
  version: GAMEPLAY_MODULE_GRAPH_VERSION,
  surface: 'rule',
  outputs: [{ name: 'result', type: 'record', nullable: true }],
  body,
})

const holderPrelude = (body: Statement[], id: string): Value => {
  body.push(call(`${id}-ref`, 'ref.holder'))
  body.push(call(`${id}-exists`, 'query.has-piece', { pieceId: output(`${id}-ref`, 'piece') }))
  body.push(call(`${id}-missing`, 'logic.not', { value: output(`${id}-exists`, 'exists') }))
  body.push(ifThen(`${id}-required`, output(`${id}-missing`, 'value'), fail(`${id}-missing-result`)))
  body.push(call(id, 'query.piece', { pieceId: output(`${id}-ref`, 'piece') }))
  return output(id, 'piece')
}

const requireSame = (body: Statement[], id: string, left: Value, right: Value): void => {
  body.push(call(`${id}-right`, 'query.piece', { pieceId: right }))
  body.push(call(`${id}-same`, 'compare.equal-piece', { left, right: output(`${id}-right`, 'piece') }))
  body.push(call(`${id}-different`, 'logic.not', { value: output(`${id}-same`, 'value') }))
  body.push(ifThen(`${id}-required`, output(`${id}-different`, 'value'), fail(`${id}-mismatch`)))
}

function buildArthasSlowRestore(): GameplayModuleGraph {
  const body: Statement[] = []
  const piece = holderPrelude(body, 'holder')
  body.push(
    call('hp', 'attribute.read', { piece }, { attribute: 'currentHp' }),
    call('alive', 'compare.greater-than', { left: output('hp', 'value'), right: value(0) }),
    call('dead', 'logic.not', { value: output('alive', 'value') }),
    ifThen('alive-required', output('dead', 'value'), fail('dead')),
    call('event-player', 'event.player'),
    call('owner', 'piece.owner', { piece }),
    call('same-player', 'compare.player-reference', { left: output('event-player', 'value'), right: output('owner', 'player') }),
    call('wrong-player', 'logic.not', { value: output('same-player', 'value') }),
    ifThen('owner-turn-required', output('wrong-player', 'value'), fail('wrong-player')),
    call('slow-id', 'status.find-id', { piece }, { statusType: 'arthas-slow' }),
    call('slow-present', 'value.present-string', { value: output('slow-id', 'id') }),
    call('slow-missing', 'logic.not', { value: output('slow-present', 'present') }),
    ifThen('slow-required', output('slow-missing', 'value'), [
      call('remove-missing-rule', 'rule.remove-piece', { target: piece }, { ruleId: 'rule-arthas-slow-restore' }),
      ...fail('slow-missing'),
    ]),
    call('stacks', 'status.read-number-truthy', { piece, statusId: output('slow-id', 'id'), fallback: value(1) }, { field: 'stacks' }),
    call('next-stacks', 'math.subtract', { left: output('stacks', 'value'), right: value(1) }),
    call('save-stacks', 'status.set-number', { piece, statusId: output('slow-id', 'id'), value: output('next-stacks', 'value') }, { field: 'stacks' }),
    call('has-stacks', 'compare.greater-than', { left: output('next-stacks', 'value'), right: value(0) }),
  )
  const remainingText: Statement[] = []
  const remainingName = text(remainingText, 'remaining-message', [value(''), output('name', 'text'), value('的减速还剩'), output('next-stacks-text', 'text'), value('回合')])
  body.push(call('name', 'attribute.text', { piece }, { attribute: 'name' }))
  body.push(call('next-stacks-text', 'text.from-number', { value: output('next-stacks', 'value') }))
  // Keep the status update before either success branch, as in the frozen rule.
  body.push(ifThen('still-slow', output('has-stacks', 'value'), [
    ...remainingText,
    ...result('still-slow-success', true, remainingName),
  ]))
  body.push(
    call('intensity', 'status.read-number-truthy', { piece, statusId: output('slow-id', 'id'), fallback: value(1) }, { field: 'intensity' }),
    call('move-range', 'attribute.read', { piece }, { attribute: 'moveRange' }),
    call('restored-range', 'math.add', { left: output('move-range', 'value'), right: output('intensity', 'value') }),
    call('save-range', 'attribute.set', { piece, value: output('restored-range', 'value') }, { attribute: 'moveRange' }),
    call('remove-slow', 'status.remove-record', { piece, value: output('slow-id', 'id') }, { selector: 'id' }),
    call('remove-rule', 'rule.remove-piece', { target: piece }, { ruleId: 'rule-arthas-slow-restore' }),
    call('restored-range-text', 'text.from-number', { value: output('restored-range', 'value') }),
  )
  const restoredText: Statement[] = []
  const restoredMessage = text(restoredText, 'restored-message', [value(''), output('name', 'text'), value('的减速解除，移动范围恢复至'), output('restored-range-text', 'text')])
  body.push(...restoredText, ...result('restored', true, restoredMessage))
  return graph(body)
}

function buildItachiTsukuyomi(): GameplayModuleGraph {
  const body: Statement[] = []
  const target = holderPrelude(body, 'target')
  body.push(call('source-ref', 'ref.source'))
  requireSame(body, 'source', target, output('source-ref', 'piece'))
  body.push(
    call('tag-id', 'status.find-id', { piece: target }, { statusType: 'itachi-tsukuyomi' }),
    call('tag-present', 'value.present-string', { value: output('tag-id', 'id') }),
    call('tag-missing', 'logic.not', { value: output('tag-present', 'present') }),
    ifThen('tag-required', output('tag-missing', 'value'), fail('tag-missing')),
    call('skill-id-raw', 'event.skill-id'),
    call('skill-id', 'value.string-or-empty', { value: output('skill-id-raw', 'value') }),
    call('cooldown', 'skill.adjust-cooldown', { piece: target, skillId: output('skill-id', 'text'), amount: value(1) }, { mode: 'add' }),
    call('cooldown-missing', 'logic.not', { value: output('cooldown', 'success') }),
    ifThen('skill-required', output('cooldown-missing', 'value'), fail('skill-missing')),
    call('remove-tag', 'status.remove-id', { piece: target, statusId: output('tag-id', 'id') }),
    call('name', 'attribute.text', { piece: target }, { attribute: 'name' }),
  )
  const message: Statement[] = []
  const messageText = text(message, 'message', [value(''), output('name', 'text'), value('受到月读影响，'), output('skill-id', 'text'), value('额外增加1回合冷却')])
  body.push(...message, ...result('success', true, messageText))
  return graph(body)
}

function buildKenshinTenkenBoost(): GameplayModuleGraph {
  const body: Statement[] = []
  const piece = holderPrelude(body, 'piece')
  body.push(call('source-ref', 'ref.source'))
  requireSame(body, 'source', piece, output('source-ref', 'piece'))
  body.push(
    call('identifier', 'piece.identifier', { piece }),
    call('tag-prefix', 'text.concat', { left: value('tenken-charge-'), right: output('identifier', 'id') }),
    call('tag-id', 'status.find-id-by-id', { piece, statusId: output('tag-prefix', 'text') }),
  )
  body.push(call('tag-present', 'value.present-string', { value: output('tag-id', 'id') }), call('tag-missing', 'logic.not', { value: output('tag-present', 'present') }), ifThen('tag-required', output('tag-missing', 'value'), fail('tag-missing')))
  body.push(
    call('uses', 'status.read-uses', { piece, statusId: output('tag-id', 'id'), fallback: value(0) }),
    call('has-uses', 'compare.greater-than', { left: output('uses', 'value'), right: value(0) }),
    call('no-uses', 'logic.not', { value: output('has-uses', 'value') }),
    ifThen('uses-required', output('no-uses', 'value'), fail('no-uses')),
    call('remove-tag', 'status.remove-id', { piece, statusId: output('tag-id', 'id') }),
    call('damage', 'event.read-number', { fallback: value(0) }, { field: 'damage' }),
    call('boosted', 'math.multiply', { left: output('damage', 'value'), right: value(1.5) }),
    call('rounded', 'math.floor', { value: output('boosted', 'value') }),
    call('write-damage', 'event.write-number', { value: output('rounded', 'value') }, { field: 'damage', inputPolicy: 'floor' }),
    call('name', 'attribute.text', { piece }, { attribute: 'name' }),
  )
  const message: Statement[] = []
  const messageText = text(message, 'message', [value(''), output('name', 'text'), value('飞天御剑流发动！本次攻击伤害提升50%')])
  body.push(...message, ...result('success', true, messageText))
  return graph(body)
}

function buildDamageBuff(): GameplayModuleGraph {
  const body: Statement[] = []
  const piece = holderPrelude(body, 'piece')
  body.push(call('source-ref', 'ref.source'))
  requireSame(body, 'source', piece, output('source-ref', 'piece'))
  body.push(
    call('buff-id', 'status.find-id-by-id', { piece }, { statusId: 'damage-buff' }),
    call('buff-present', 'value.present-string', { value: output('buff-id', 'id') }),
    call('buff-missing', 'logic.not', { value: output('buff-present', 'present') }),
    ifThen('buff-required', output('buff-missing', 'value'), [
      call('remove-missing-rule', 'rule.remove-piece', { target: piece }, { ruleId: 'rule-damage-buff' }),
      ...fail('buff-missing'),
    ]),
    call('damage', 'event.read-number', { fallback: value(0) }, { field: 'damage' }),
    call('positive', 'compare.greater-than', { left: output('damage', 'value'), right: value(0) }),
    call('not-positive', 'logic.not', { value: output('positive', 'value') }),
    ifThen('positive-required', output('not-positive', 'value'), fail('not-positive')),
    call('bonus', 'status.read-number-truthy', { piece, statusId: output('buff-id', 'id'), fallback: value(0) }, { field: 'intensity' }),
    call('next-damage', 'math.add', { left: output('damage', 'value'), right: output('bonus', 'value') }),
    call('write-damage', 'event.write-number', { value: output('next-damage', 'value') }, { field: 'damage', inputPolicy: 'host' }),
    call('remove-buff', 'status.remove-id', { piece, statusId: output('buff-id', 'id') }),
    call('remove-rule', 'rule.remove-piece', { target: piece }, { ruleId: 'rule-damage-buff' }),
    call('name', 'attribute.text', { piece }, { attribute: 'name' }),
    call('bonus-text', 'text.from-number', { value: output('bonus', 'value') }),
  )
  const message: Statement[] = []
  const messageText = text(message, 'message', [value(''), output('name', 'text'), value('的强化触发，伤害+'), output('bonus-text', 'text')])
  body.push(...message, ...result('success', true, messageText))
  return graph(body)
}

function buildMuzanDamageReduction(): GameplayModuleGraph {
  const body: Statement[] = []
  const defender = holderPrelude(body, 'defender')
  body.push(call('event-piece', 'ref.event-piece'))
  requireSame(body, 'event', defender, output('event-piece', 'piece'))
  body.push(
    call('status-id', 'status.find-id', { piece: defender }, { statusType: 'muzan-damage-reduction' }),
    call('status-present', 'value.present-string', { value: output('status-id', 'id') }),
    call('status-missing', 'logic.not', { value: output('status-present', 'present') }),
    ifThen('status-required', output('status-missing', 'value'), fail('status-missing')),
    call('current-duration', 'status.read-number', { piece: defender, statusId: output('status-id', 'id'), fallback: value(-1) }, { field: 'currentDuration' }),
    call('remaining-duration', 'status.read-duration', { piece: defender, statusId: output('status-id', 'id'), fallback: output('current-duration', 'value') }),
    call('active', 'compare.greater-than', { left: output('remaining-duration', 'value'), right: value(0) }),
    call('inactive', 'logic.not', { value: output('active', 'value') }),
    ifThen('active-required', output('inactive', 'value'), fail('inactive')),
    call('damage', 'event.read-number', { fallback: value(0) }, { field: 'damage' }),
    call('positive', 'compare.greater-than', { left: output('damage', 'value'), right: value(0) }),
    call('not-positive', 'logic.not', { value: output('positive', 'value') }),
    ifThen('positive-required', output('not-positive', 'value'), fail('not-positive')),
    call('halved', 'math.multiply', { left: output('damage', 'value'), right: value(0.5) }),
    call('rounded', 'math.floor', { value: output('halved', 'value') }),
    call('write-damage', 'event.write-number', { value: output('rounded', 'value') }, { field: 'damage', inputPolicy: 'floor' }),
    call('name', 'attribute.text', { piece: defender }, { attribute: 'name' }),
  )
  const message: Statement[] = []
  const messageText = text(message, 'message', [value(''), output('name', 'text'), value('的无惨之躯使伤害减少50%')])
  body.push(...message, ...result('success', true, messageText))
  return graph(body)
}

function buildMaxPhaseRecastExpire(): GameplayModuleGraph {
  const body: Statement[] = []
  const piece = holderPrelude(body, 'piece')
  body.push(
    call('hp', 'attribute.read', { piece }, { attribute: 'currentHp' }),
    call('alive', 'compare.greater-than', { left: output('hp', 'value'), right: value(0) }),
    call('event-player', 'event.player'),
    call('owner', 'piece.owner', { piece }),
    call('owner-turn', 'compare.player-reference', { left: output('event-player', 'value'), right: output('owner', 'player') }),
    call('valid', 'logic.and', { left: output('alive', 'value'), right: output('owner-turn', 'value') }),
    call('invalid', 'logic.not', { value: output('valid', 'value') }),
    ifThen('valid-required', output('invalid', 'value'), fail('invalid')),
    call('turn', 'turn.number'),
    call('status-id', 'status.find-id-by-number', { piece, value: output('turn', 'value') }, { statusType: 'max-phase-recast', field: 'turnNumber' }),
    call('status-present', 'value.present-string', { value: output('status-id', 'id') }),
    call('status-missing', 'logic.not', { value: output('status-present', 'present') }),
    ifThen('status-required', output('status-missing', 'value'), [
      call('remove-missing-rule', 'rule.remove-piece', { target: piece }, { ruleId: 'rule-max-phase-recast-expire' }),
      ...fail('status-missing'),
    ]),
    call('cooldown', 'skill.adjust-cooldown', { piece, skillId: value('max-phase-shifter'), amount: value(3) }, { mode: 'atLeast' }),
    call('remove-status', 'status.remove-id', { piece, statusId: output('status-id', 'id') }),
    call('name', 'attribute.text', { piece }, { attribute: 'name' }),
  )
  const message: Statement[] = []
  const messageText = text(message, 'message', [value(''), output('name', 'text'), value('本回合未再次释放相位偏移器，技能进入冷却')])
  body.push(...message, ...result('success', true, messageText))
  return graph(body)
}

function buildHidanUndyingTick(): GameplayModuleGraph {
  const body: Statement[] = []
  const hidan = holderPrelude(body, 'hidan')
  body.push(
    call('event-player', 'turn.current-player'),
    call('owner', 'piece.owner', { piece: hidan }),
    call('same-turn', 'compare.player-reference', { left: output('event-player', 'player'), right: output('owner', 'player') }),
    call('wrong-turn', 'logic.not', { value: output('same-turn', 'value') }),
    ifThen('owner-turn-required', output('wrong-turn', 'value'), fail('wrong-turn')),
    call('dying-id', 'status.find-id', { piece: hidan }, { statusType: 'hidan-dying' }),
    call('dying-present', 'value.present-string', { value: output('dying-id', 'id') }),
    call('dying-missing', 'logic.not', { value: output('dying-present', 'present') }),
    ifThen('dying-required', output('dying-missing', 'value'), [
      call('remove-missing-rule', 'rule.remove-piece', { target: hidan }, { ruleId: 'rule-hidan-undying-tick' }),
      ...fail('dying-missing'),
    ]),
    call('remaining', 'status.consume-counter', { piece: hidan, statusId: output('dying-id', 'id') }, { field: 'remainingTurns', fallback: 1 }),
    call('pending', 'compare.greater-than', { left: output('remaining', 'value'), right: value(0) }),
    call('name', 'attribute.text', { piece: hidan }, { attribute: 'name' }),
    call('remaining-text', 'text.from-number', { value: output('remaining', 'value') }),
  )
  const pendingMessage: Statement[] = []
  const pendingText = text(pendingMessage, 'pending-message', [value(''), output('name', 'text'), value('的濒死状态剩余'), output('remaining-text', 'text'), value('个己方回合')])
  body.push(ifThen('still-dying', output('pending', 'value'), [...pendingMessage, ...result('still-dying-success', true, pendingText)]))
  body.push(
    call('remove-dying', 'status.remove-id', { piece: hidan, statusId: value('hidan-dying') }),
    call('remove-rule', 'rule.remove-piece', { target: hidan }, { ruleId: 'rule-hidan-undying-tick' }),
    call('owner-player', 'piece.owner', { piece: hidan }),
    call('killer-player', 'content.enemy-player', { player: output('owner-player', 'player') }),
    call('fatal', 'effect.damage-with-killer', { source: hidan, target: hidan, amount: value(999), killerPlayer: output('killer-player', 'enemy') }, { damageType: 'true', skillId: 'undying-expire', inputPolicy: 'host' }),
  )
  const finalMessage: Statement[] = []
  const finalText = text(finalMessage, 'final-message', [value(''), output('name', 'text'), value('的濒死状态结束，最终陨落')])
  body.push(...finalMessage, ...result('final', true, finalText))
  return graph(body)
}

function buildWatcherForm(): GameplayModuleGraph {
  const body: Statement[] = []
  const piece = holderPrelude(body, 'piece')
  body.push(
    call('hp', 'attribute.read', { piece }, { attribute: 'currentHp' }),
    call('alive', 'compare.greater-than', { left: output('hp', 'value'), right: value(0) }),
    call('dead', 'logic.not', { value: output('alive', 'value') }),
    ifThen('alive-required', output('dead', 'value'), fail('dead')),
    call('event-player', 'turn.current-player'),
    call('owner', 'piece.owner', { piece }),
    call('same-player', 'compare.player-reference', { left: output('event-player', 'player'), right: output('owner', 'player') }),
    call('wrong-player', 'logic.not', { value: output('same-player', 'value') }),
    ifThen('owner-turn-required', output('wrong-player', 'value'), fail('wrong-player')),
    call('name', 'attribute.text', { piece }, { attribute: 'name' }),
  )
  const choiceTitle = text(body, 'choice-title', [output('name', 'text'), value(' 红蓝形态：选择加入手牌的卡')])
  body.push(
    call('choice', 'choice.required-option-pair', { player: output('owner', 'player'), title: choiceTitle }, { firstLabel: '平静（护盾2点，进入平静姿态）', firstValue: 'calm', secondLabel: '暴怒（造成1倍伤害，进入暴怒姿态）', secondValue: 'rage' }),
    call('unresolved', 'choice.is-unresolved', { choice: output('choice', 'choice') }),
  )
  body.push(ifThen('waiting', output('unresolved', 'value'), [call('choice-result', 'choice.as-result', { choice: output('choice', 'choice') }), { kind: 'return', id: 'waiting-return', value: output('choice-result', 'result') }]))
  body.push(call('selected', 'choice.option-id-value', { choice: output('choice', 'choice') }))
  body.push(call('is-calm', 'compare.equal-string', { left: output('selected', 'text'), right: value('calm') }))
  const calm: Statement[] = [
    call('calm-card', 'card.hand-add', { player: output('owner', 'player') }, { cardId: 'watcher-calm' }),
  ]
  const calmMessageBody: Statement[] = []
  const calmMessage = text(calmMessageBody, 'calm-message', [value(''), output('name', 'text'), value('的红蓝形态发动：获得平静')])
  calm.push(...calmMessageBody, ...result('calm-success', true, calmMessage))
  const rage: Statement[] = [
    call('rage-card', 'card.hand-add', { player: output('owner', 'player') }, { cardId: 'watcher-rage' }),
  ]
  const rageMessageBody: Statement[] = []
  const rageMessage = text(rageMessageBody, 'rage-message', [value(''), output('name', 'text'), value('的红蓝形态发动：获得暴怒')])
  rage.push(...rageMessageBody, ...result('rage-success', true, rageMessage))
  body.push(ifThen('calm-branch', output('is-calm', 'value'), calm, rage))
  return graph(body)
}

function buildObitoGrudgeReset(): GameplayModuleGraph {
  const body: Statement[] = []
  const obito = holderPrelude(body, 'obito')
  body.push(
    call('event-player', 'turn.current-player'),
    call('owner', 'piece.owner', { piece: obito }),
    call('same-player', 'compare.player-reference', { left: output('event-player', 'player'), right: output('owner', 'player') }),
    call('wrong-player', 'logic.not', { value: output('same-player', 'value') }),
    ifThen('owner-turn-required', output('wrong-player', 'value'), fail('wrong-player')),
    call('grudge-id', 'status.find-id', { piece: obito }, { statusType: 'obito-grudge' }),
    call('grudge-present', 'value.present-string', { value: output('grudge-id', 'id') }),
    call('grudge-missing', 'logic.not', { value: output('grudge-present', 'present') }),
    ifThen('grudge-required', output('grudge-missing', 'value'), fail('grudge-missing')),
    call('removed', 'status.read-number', { piece: obito, statusId: output('grudge-id', 'id'), fallback: value(0) }, { field: 'intensity' }),
    call('attack', 'attribute.read', { piece: obito }, { attribute: 'attack' }),
    call('next-attack-raw', 'math.subtract', { left: output('attack', 'value'), right: output('removed', 'value') }),
    call('next-attack', 'math.max', { left: output('next-attack-raw', 'value'), right: value(0) }),
    call('save-attack', 'attribute.set', { piece: obito, value: output('next-attack', 'value') }, { attribute: 'attack' }),
    call('remove-grudge', 'status.remove-id', { piece: obito, statusId: output('grudge-id', 'id') }),
    call('name', 'attribute.text', { piece: obito }, { attribute: 'name' }),
    call('removed-text', 'text.from-number', { value: output('removed', 'value') }),
    call('attack-text', 'text.from-number', { value: output('next-attack', 'value') }),
  )
  const message: Statement[] = []
  const messageText = text(message, 'message', [value(''), output('name', 'text'), value('的怨念消散，攻击力-'), output('removed-text', 'text'), value('，现为'), output('attack-text', 'text')])
  body.push(...message, ...result('success', true, messageText))
  return graph(body)
}

function buildShadowChaosSpearRestore(): GameplayModuleGraph {
  const body: Statement[] = []
  const caster = holderPrelude(body, 'caster')
  body.push(
    call('event-player', 'event.player'),
    call('owner', 'piece.owner', { piece: caster }),
    call('same-player', 'compare.player-reference', { left: output('event-player', 'value'), right: output('owner', 'player') }),
    call('wrong-player', 'logic.not', { value: output('same-player', 'value') }),
    ifThen('owner-turn-required', output('wrong-player', 'value'), fail('wrong-player')),
    call('theft-id', 'status.find-id', { piece: caster }, { statusType: 'chaos-spear-theft' }),
    call('theft-present', 'value.present-string', { value: output('theft-id', 'id') }),
    call('theft-missing', 'logic.not', { value: output('theft-present', 'present') }),
    ifThen('theft-required', output('theft-missing', 'value'), [
      call('remove-missing-rule', 'rule.remove-piece', { target: caster }, { ruleId: 'rule-shadow-chaos-spear-restore' }),
      ...fail('theft-missing'),
    ]),
    call('target', 'status.read-reference', { piece: caster, statusId: output('theft-id', 'id') }, { field: 'targetId' }),
    call('intensity', 'status.read-number-truthy', { piece: caster, statusId: output('theft-id', 'id'), fallback: value(2) }, { field: 'intensity' }),
    call('move-range', 'attribute.read', { piece: caster }, { attribute: 'moveRange' }),
    call('restored-caster', 'math.subtract', { left: output('move-range', 'value'), right: output('intensity', 'value') }),
    call('save-caster', 'attribute.set', { piece: caster, value: output('restored-caster', 'value') }, { attribute: 'moveRange' }),
    call('target-resolved', 'query.piece', { pieceId: output('target', 'reference') }),
    call('target-alive', 'piece.alive', { piece: output('target-resolved', 'piece') }),
  )
  const restoreTarget: Statement[] = [
    call('target-range', 'attribute.read', { piece: output('target-resolved', 'piece') }, { attribute: 'moveRange' }),
    call('restored-target', 'math.add', { left: output('target-range', 'value'), right: output('intensity', 'value') }),
    call('save-target', 'attribute.set', { piece: output('target-resolved', 'piece'), value: output('restored-target', 'value') }, { attribute: 'moveRange' }),
  ]
  body.push(ifThen('restore-target', output('target-alive', 'alive'), restoreTarget))
  body.push(
    call('remove-theft', 'status.remove-record', { piece: caster, value: output('theft-id', 'id') }, { selector: 'id' }),
    call('remove-rule', 'rule.remove-piece', { target: caster }, { ruleId: 'rule-shadow-chaos-spear-restore' }),
  )
  body.push(...result('success', true, value('混沌之矛偷取的移动范围已归还')))
  return graph(body)
}

export const STATUS_TIMER_GRAPHS: Readonly<Record<string, GameplayModuleGraph>> = Object.freeze({
  'rule-arthas-slow-restore': buildArthasSlowRestore(),
  'rule-itachi-tsukuyomi': buildItachiTsukuyomi(),
  'rule-kenshin-tenken-boost': buildKenshinTenkenBoost(),
  'rule-damage-buff': buildDamageBuff(),
  'rule-muzan-damage-reduction': buildMuzanDamageReduction(),
  'rule-max-phase-recast-expire': buildMaxPhaseRecastExpire(),
  'rule-hidan-undying-tick': buildHidanUndyingTick(),
  'rule-watcher-form': buildWatcherForm(),
  'rule-obito-grudge-reset': buildObitoGrudgeReset(),
  'rule-shadow-chaos-spear-restore': buildShadowChaosSpearRestore(),
})

const GENERATED_FIELDS = new Set([
  'code', 'skillCode', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion',
  'contentGraphEntries', 'gameplayModules',
])

const JSON_LINE_ENDING = String.fromCharCode(10)

function writeJsonDocument(file: string, document: Record<string, unknown>): void {
  const serialized = JSON.stringify(document, null, 2)
  if (serialized === undefined) throw new Error(`${file}: cannot serialize migrated rule document`)
  fs.writeFileSync(file, serialized + JSON_LINE_ENDING, 'utf8')
}

/**
 * Migrate the whole batch only after every source and compatibility field has
 * passed the frozen fixture preflight.  A failed preflight performs no write.
 */
export function migrateStatusTimers(root: string, write = false): string[] {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries as Record<string, Record<string, unknown>>
  const pending: Array<{ file: string; next: Record<string, unknown> }> = []
  for (const [id, moduleGraph] of Object.entries(STATUS_TIMER_GRAPHS)) {
    const file = path.join(root, 'data/rules', `${id}.json`)
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    const original = fixture[`rules/${id}`]
    if (!original) throw new Error(`${id}: missing frozen fixture entry`)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) {
      if (GENERATED_FIELDS.has(key)) continue
      if (JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    }
    const existingModules = current.gameplayModules as { entries?: Record<string, unknown> } | undefined
    if (existingModules?.entries?.skillCode) {
      assertGameplayModuleDocument(current)
      const existingGraph = (existingModules.entries.skillCode as { graph?: unknown }).graph
      if (JSON.stringify(existingGraph) !== JSON.stringify(moduleGraph)) throw new Error(`${id}: existing gameplay graph differs from approved migration graph`)
      continue
    }
    assertFrozenExecutable(current, original, 'skillCode', 'rule', id)
    pending.push({ file, next: applyGameplayModuleGraph(current, moduleGraph, 'skillCode') })
  }
  if (write) for (const item of pending) writeJsonDocument(item.file, item.next)
  return pending.map(item => path.basename(item.file, '.json'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(migrateStatusTimers(process.cwd(), process.argv.includes('--write'))))
}

