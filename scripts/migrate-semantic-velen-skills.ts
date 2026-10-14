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

export const VELEN_SKILL_IDS = ['velen-fate-shelter', 'velen-holy-prophecy', 'velen-thousand-futures-ultimate'] as const
type VelenSkillId = typeof VELEN_SKILL_IDS[number]

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const resultOutputs = [{ name: 'result', type: 'record' as const, nullable: true }]

const prophecySchema = {
  id: 'velen-holy-prophecy',
  version: '1',
  fields: [
    { name: 'sourcePieceId', type: 'string' as const },
    { name: 'createdTurnNumber', type: 'number' as const },
  ],
}

const shelterSchema = {
  id: 'velen-fate-shelter',
  version: '1',
  fields: [
    { name: 'id', type: 'string' as const },
    { name: 'name', type: 'string' as const },
    { name: 'type', type: 'string' as const },
    { name: 'currentDuration', type: 'number' as const },
    { name: 'currentUses', type: 'number' as const },
    { name: 'intensity', type: 'number' as const },
    { name: 'stacks', type: 'number' as const },
    { name: 'sourceId', type: 'string' as const },
    { name: 'createdTurnNumber', type: 'number' as const },
    { name: 'relatedRules', type: { kind: 'list' as const, element: 'string' as const } },
  ],
}

function actionResult(body: GameplayStatement[], id: string, success: boolean, message: GameplayValue): void {
  body.push(call(id, 'result.action', { success: literal(success), message }), { kind: 'return', id: id + '-return', value: out(id, 'result') })
}

function returnRawChoice(body: GameplayStatement[], id: string, choice: GameplayValue): void {
  body.push(call(id, 'choice.as-result', { choice }), { kind: 'return', id: id + '-return', value: out(id, 'result') })
}

type GameplayIfStatement = Extract<GameplayStatement, { kind: 'if' }>

// Graph types intentionally expose immutable branches to consumers. The builder
// creates fresh arrays above and below, so mutating those local construction
// branches is safe while assembling the graph before validation/compilation.
function mutableBranch(node: GameplayIfStatement, branch: 'then' | 'else'): GameplayStatement[] {
  const statements = node[branch]
  if (!statements) throw new Error(`Missing ${branch} branch on ${node.id}`)
  return statements as GameplayStatement[]
}

function ordinaryCardsFilter(
  id: string,
  items: GameplayValue,
  player: GameplayValue,
  excludeProphecy: boolean,
  excludeEnhanced: boolean,
): GameplayStatement {
  const body: GameplayStatement[] = [
    call(id + '-definition', 'card.read-definition-id', { player: input('player'), card: input('card') }),
    call(id + '-smite', 'compare.equal-string', { left: out(id + '-definition', 'cardId'), right: literal('holy-smite') }),
    call(id + '-heal', 'compare.equal-string', { left: out(id + '-definition', 'cardId'), right: literal('holy-heal') }),
    call(id + '-charge', 'compare.equal-string', { left: out(id + '-definition', 'cardId'), right: literal('holy-charge') }),
    call(id + '-ordinary-a', 'logic.or', { left: out(id + '-smite', 'value'), right: out(id + '-heal', 'value') }),
    call(id + '-ordinary', 'logic.or', { left: out(id + '-ordinary-a', 'value'), right: out(id + '-charge', 'value') }),
  ]
  let available: GameplayValue = out(id + '-ordinary', 'value')
  if (excludeProphecy) {
    body.push(
      call(id + '-prophecy', 'card.read-content-boolean', { player: input('player'), card: input('card') }, { field: 'velenHolyProphecy' }),
      call(id + '-no-prophecy', 'logic.not', { value: out(id + '-prophecy', 'value') }),
      call(id + '-without-prophecy', 'logic.and', { left: available, right: out(id + '-no-prophecy', 'value') }),
    )
    available = out(id + '-without-prophecy', 'value')
  }
  if (excludeEnhanced) {
    body.push(
      call(id + '-enhanced', 'card.read-content-boolean', { player: input('player'), card: input('card') }, { field: 'velenHolyProphecyEnhanced' }),
      call(id + '-no-enhanced', 'logic.not', { value: out(id + '-enhanced', 'value') }),
      call(id + '-without-enhanced', 'logic.and', { left: available, right: out(id + '-no-enhanced', 'value') }),
    )
    available = out(id + '-without-enhanced', 'value')
  }
  body.push({ kind: 'return', id: id + '-return', value: available })
  return { kind: 'collection', id, method: 'filter', items, item: 'card', inputs: { player }, body }
}

function cardLabelsMap(
  id: string,
  items: GameplayValue,
  player: GameplayValue,
  fallback: 'holy' | 'definition',
  appendInstance = false,
): GameplayStatement {
  const body: GameplayStatement[] = [
    call(id + '-definition', 'card.read-definition-id', { player: input('player'), card: input('card') }),
    call(id + '-name', 'card.read-definition-name', { player: input('player'), card: input('card') }),
    call(id + '-has-name', 'value.present-string', { value: out(id + '-name', 'name') }),
    call(id + '-name-text', 'value.string-or-empty', { value: out(id + '-name', 'name') }),
  ]
  let fallbackText: GameplayValue = out(id + '-definition', 'cardId')
  if (fallback === 'holy') {
    body.push(
      call(id + '-is-smite', 'compare.equal-string', { left: out(id + '-definition', 'cardId'), right: literal('holy-smite') }),
      call(id + '-is-heal', 'compare.equal-string', { left: out(id + '-definition', 'cardId'), right: literal('holy-heal') }),
      call(id + '-is-charge', 'compare.equal-string', { left: out(id + '-definition', 'cardId'), right: literal('holy-charge') }),
      call(id + '-fallback-smite', 'value.select-text', { condition: out(id + '-is-smite', 'value'), whenTrue: literal('圣光惩击'), whenFalse: literal('圣光治疗') }),
      call(id + '-fallback', 'value.select-text', { condition: out(id + '-is-charge', 'value'), whenTrue: literal('圣光充能'), whenFalse: out(id + '-fallback-smite', 'text') }),
    )
    fallbackText = out(id + '-fallback', 'text')
  }
  body.push(call(id + '-chosen-name', 'value.select-text', { condition: out(id + '-has-name', 'present'), whenTrue: out(id + '-name-text', 'text'), whenFalse: fallbackText }))
  let label: GameplayValue = out(id + '-chosen-name', 'text')
  if (appendInstance) {
    body.push(
      call(id + '-instance-prefix', 'text.concat', { left: label, right: literal('（') }),
      call(id + '-instance-value', 'text.concat', { left: out(id + '-instance-prefix', 'text'), right: input('card') }),
      call(id + '-instance-label', 'text.concat', { left: out(id + '-instance-value', 'text'), right: literal('）') }),
    )
    label = out(id + '-instance-label', 'text')
  }
  body.push({ kind: 'return', id: id + '-return', value: label })
  return { kind: 'collection', id, method: 'map', items, item: 'card', inputs: { player }, body }
}

function buildFateShelterGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('caster-ref', 'ref.holder'),
    call('caster', 'query.piece', { pieceId: out('caster-ref', 'piece') }),
    call('owner', 'piece.owner', { piece: out('caster', 'piece') }),
    call('choice', 'choice.target-piece', {}, { range: 99, filter: 'ally' }),
    call('choice-unresolved', 'choice.is-unresolved', { choice: out('choice', 'choice') }),
  ]
  body.push({ kind: 'if', id: 'choice-pending', condition: out('choice-unresolved', 'value'), then: [] })
  const pending = body[body.length - 1] as GameplayIfStatement
  returnRawChoice(mutableBranch(pending, 'then'), 'pending-result', out('choice', 'choice'))
  body.push(call('target', 'choice.piece', { choice: out('choice', 'choice') }), call('target-present', 'card.piece-present', { value: out('target', 'piece') }))
  const invalidTargetPresence: GameplayStatement[] = []
  const invalidTargetEligibility: GameplayStatement[] = []
  actionResult(invalidTargetPresence, 'invalid-target-presence-result', false, literal('命运庇护只能选择存活友方'))
  actionResult(invalidTargetEligibility, 'invalid-target-eligibility-result', false, literal('命运庇护只能选择存活友方'))
  body.push({ kind: 'if', id: 'target-present-branch', condition: out('target-present', 'present'), then: [], else: invalidTargetPresence })
  const validTarget = body[body.length - 1] as GameplayIfStatement
  mutableBranch(validTarget, 'then').push(
    call('target-hp', 'attribute.read', { piece: out('target', 'piece') }, { attribute: 'currentHp' }),
    call('target-alive', 'compare.greater-than', { left: out('target-hp', 'value'), right: literal(0) }),
    call('target-owner', 'piece.owner', { piece: out('target', 'piece') }),
    call('allied', 'compare.allied-players', { left: out('target-owner', 'player'), right: out('owner', 'player') }),
    call('alive-and-allied', 'logic.and', { left: out('target-alive', 'value'), right: out('allied', 'value') }),
    { kind: 'if', id: 'target-valid-branch', condition: out('alive-and-allied', 'value'), then: [], else: invalidTargetEligibility },
  )
  const targetValid = mutableBranch(validTarget, 'then')[mutableBranch(validTarget, 'then').length - 1] as GameplayIfStatement
  mutableBranch(targetValid, 'then').push(call('existing', 'status.matches-type', { piece: out('target', 'piece') }, { statusType: 'velen-fate-shelter' }))
  mutableBranch(targetValid, 'then').push({ kind: 'if', id: 'duplicate-branch', condition: out('existing', 'value'), then: [], else: [] })
  const duplicate = mutableBranch(targetValid, 'then')[mutableBranch(targetValid, 'then').length - 1] as GameplayIfStatement
  actionResult(mutableBranch(duplicate, 'then'), 'duplicate-result', false, literal('目标已经获得命运庇护'))
  mutableBranch(duplicate, 'else').push(
    call('turn', 'turn.number'),
    call('caster-id', 'piece.identifier', { piece: out('caster', 'piece') }),
    call('target-id', 'piece.identifier', { piece: out('target', 'piece') }),
    call('id-prefix', 'text.concat', { left: literal('velen-fate-shelter-'), right: out('caster-id', 'id') }),
    call('id-separator', 'text.concat', { left: out('id-prefix', 'text'), right: literal('-') }),
    call('status-id', 'text.concat', { left: out('id-separator', 'text'), right: out('target-id', 'id') }),
    {
      kind: 'record.create', id: 'shelter-record', schema: 'velen-fate-shelter@1', fields: {
        id: out('status-id', 'text'), name: literal('命运庇护'), type: literal('velen-fate-shelter'),
        currentDuration: literal(-1), currentUses: literal(-1), intensity: literal(8), stacks: literal(1),
        sourceId: out('caster-id', 'id'), createdTurnNumber: out('turn', 'value'), relatedRules: literal(['rule-velen-fate-target']),
      },
    },
    call('apply-shelter', 'status.apply-record', { target: out('target', 'piece'), record: out('shelter-record', 'value') }, { inputPolicy: 'host' }),
    call('apply-target-rule', 'rule.apply-piece', { target: out('target', 'piece') }, { ruleId: 'rule-velen-fate-target' }),
    call('caster-name', 'attribute.text', { piece: out('caster', 'piece') }, { attribute: 'name' }),
    call('target-name', 'attribute.text', { piece: out('target', 'piece') }, { attribute: 'name' }),
    call('message-a', 'text.concat', { left: out('caster-name', 'text'), right: literal('为') }),
    call('message-b', 'text.concat', { left: out('message-a', 'text'), right: out('target-name', 'text') }),
    call('message', 'text.concat', { left: out('message-b', 'text'), right: literal('预见了命运庇护') }),
  )
  actionResult(mutableBranch(duplicate, 'else'), 'success-result', true, out('message', 'text'))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: resultOutputs, schemas: [shelterSchema], body }
}

function buildHolyProphecyGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('caster-ref', 'ref.holder'),
    call('caster', 'query.piece', { pieceId: out('caster-ref', 'piece') }),
    call('owner', 'piece.owner', { piece: out('caster', 'piece') }),
    call('player-exists', 'query.has-player', { playerId: out('owner', 'player') }),
    { kind: 'if', id: 'missing-player', condition: out('player-exists', 'exists'), then: [], else: [] },
  ]
  const missing = body[body.length - 1] as GameplayIfStatement
  actionResult(mutableBranch(missing, 'else'), 'missing-player-result', false, literal('未找到玩家'))
  body.push(
    call('hand', 'card.hand-instances', { player: out('owner', 'player') }),
    ordinaryCardsFilter('eligible', out('hand', 'cards'), out('owner', 'player'), true, true),
    call('eligible-count', 'list.count', { items: out('eligible', 'value') }),
    call('has-eligible', 'compare.greater-than', { left: out('eligible-count', 'count'), right: literal(0) }),
    { kind: 'if', id: 'no-eligible', condition: out('has-eligible', 'value'), then: [], else: [] },
  )
  const noEligible = body[body.length - 1] as GameplayIfStatement
  actionResult(mutableBranch(noEligible, 'else'), 'no-eligible-result', false, literal('没有可预言的圣光手牌'))
  mutableBranch(noEligible, 'then').push(
    cardLabelsMap('labels', out('eligible', 'value'), out('owner', 'player'), 'holy'),
    call('choice', 'choice.hand-cards', { player: out('owner', 'player'), cards: out('eligible', 'value'), labels: out('labels', 'value') }, { title: '圣光预言：选择一张圣光手牌', selectionMode: 'single', minSelections: 1, maxSelections: 1 }),
    call('choice-unresolved', 'choice.is-unresolved', { choice: out('choice', 'choice') }),
    { kind: 'if', id: 'choice-pending', condition: out('choice-unresolved', 'value'), then: [] },
  )
  const pending = mutableBranch(noEligible, 'then')[mutableBranch(noEligible, 'then').length - 1] as GameplayIfStatement
  returnRawChoice(mutableBranch(pending, 'then'), 'pending-result', out('choice', 'choice'))
  mutableBranch(noEligible, 'then').push(
    call('selected', 'choice.strict-string', { choice: out('choice', 'choice') }),
    call('selected-valid', 'collection.contains-string', { items: out('eligible', 'value'), value: out('selected', 'text') }),
    { kind: 'if', id: 'selected-valid-branch', condition: out('selected-valid', 'contains'), then: [], else: [] },
  )
  const selectedBranch = mutableBranch(noEligible, 'then')[mutableBranch(noEligible, 'then').length - 1] as GameplayIfStatement
  actionResult(mutableBranch(selectedBranch, 'else'), 'invalid-selected-result', false, literal('选择的手牌已无法被预言'))
  mutableBranch(selectedBranch, 'then').push(
    call('turn', 'turn.number'),
    call('caster-id', 'piece.identifier', { piece: out('caster', 'piece') }),
    { kind: 'record.create', id: 'prophecy-record', schema: 'velen-holy-prophecy@1', fields: { sourcePieceId: out('caster-id', 'id'), createdTurnNumber: out('turn', 'value') } },
    call('set-record', 'card.set-content-record', { player: out('owner', 'player'), card: out('selected', 'text'), record: out('prophecy-record', 'value') }, { field: 'velenHolyProphecy' }),
    call('install-delayed-rule', 'rule.apply-player', { target: out('owner', 'player') }, { ruleId: 'rule-velen-delayed-effects' }),
    call('caster-name', 'attribute.text', { piece: out('caster', 'piece') }, { attribute: 'name' }),
    call('message', 'text.concat', { left: out('caster-name', 'text'), right: literal('留下了圣光预言') }),
  )
  actionResult(mutableBranch(selectedBranch, 'then'), 'success-result', true, out('message', 'text'))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: resultOutputs, schemas: [prophecySchema], body }
}

function buildThousandFuturesGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('caster-ref', 'ref.holder'),
    call('caster', 'query.piece', { pieceId: out('caster-ref', 'piece') }),
    call('owner', 'piece.owner', { piece: out('caster', 'piece') }),
    call('player-exists', 'query.has-player', { playerId: out('owner', 'player') }),
    { kind: 'if', id: 'missing-player', condition: out('player-exists', 'exists'), then: [], else: [] },
  ]
  const missing = body[body.length - 1] as GameplayIfStatement
  actionResult(mutableBranch(missing, 'else'), 'missing-player-result', false, literal('未找到玩家'))
  body.push(
    call('hand', 'card.hand-instances', { player: out('owner', 'player') }),
    ordinaryCardsFilter('eligible', out('hand', 'cards'), out('owner', 'player'), false, true),
    call('eligible-count', 'list.count', { items: out('eligible', 'value') }),
    call('has-eligible', 'compare.greater-than', { left: out('eligible-count', 'count'), right: literal(0) }),
    { kind: 'if', id: 'no-eligible', condition: out('has-eligible', 'value'), then: [], else: [] },
  )
  const noEligible = body[body.length - 1] as GameplayIfStatement
  actionResult(mutableBranch(noEligible, 'else'), 'no-eligible-result', false, literal('没有可强化的圣光手牌'))
  mutableBranch(noEligible, 'then').push(
    cardLabelsMap('labels', out('eligible', 'value'), out('owner', 'player'), 'definition', true),
    call('choice', 'choice.hand-cards', { player: out('owner', 'player'), cards: out('eligible', 'value'), labels: out('labels', 'value') }, { title: '万千未来：选择立即强化的手牌', selectionMode: 'multi', minSelections: 1, maxSelections: 3 }),
    call('choice-unresolved', 'choice.is-unresolved', { choice: out('choice', 'choice') }),
    { kind: 'if', id: 'choice-pending', condition: out('choice-unresolved', 'value'), then: [] },
  )
  const pending = mutableBranch(noEligible, 'then')[mutableBranch(noEligible, 'then').length - 1] as GameplayIfStatement
  returnRawChoice(mutableBranch(pending, 'then'), 'pending-result', out('choice', 'choice'))
  mutableBranch(noEligible, 'then').push(
    call('is-array', 'choice.is-array', { choice: out('choice', 'choice') }),
    { kind: 'if', id: 'array-branch', condition: out('is-array', 'value'), then: [], else: [] },
  )
  const arrayBranch = mutableBranch(noEligible, 'then')[mutableBranch(noEligible, 'then').length - 1] as GameplayIfStatement
  actionResult(mutableBranch(arrayBranch, 'else'), 'invalid-array-result', false, literal('万千未来选择无效'))
  mutableBranch(arrayBranch, 'then').push(
    call('selected', 'choice.strict-string-list', { choice: out('choice', 'choice') }),
    call('strict-list', 'choice.is-strict-string-list', { choice: out('choice', 'choice') }),
    { kind: 'if', id: 'strict-list-branch', condition: out('strict-list', 'value'), then: [], else: [] },
  )
  const strictListBranch = mutableBranch(arrayBranch, 'then')[mutableBranch(arrayBranch, 'then').length - 1] as GameplayIfStatement
  actionResult(mutableBranch(strictListBranch, 'else'), 'invalid-element-result', false, literal('选择的手牌已无法强化'))
  mutableBranch(strictListBranch, 'then').push(
    call('selected-count', 'list.count', { items: out('selected', 'values') }),
    call('too-few', 'compare.less-than', { left: out('selected-count', 'count'), right: literal(1) }),
    call('too-many', 'compare.greater-than', { left: out('selected-count', 'count'), right: literal(3) }),
    call('bad-count', 'logic.or', { left: out('too-few', 'value'), right: out('too-many', 'value') }),
    { kind: 'if', id: 'count-branch', condition: out('bad-count', 'value'), then: [], else: [] },
  )
  const countBranch = mutableBranch(strictListBranch, 'then')[mutableBranch(strictListBranch, 'then').length - 1] as GameplayIfStatement
  actionResult(mutableBranch(countBranch, 'then'), 'invalid-count-result', false, literal('万千未来选择无效'))
  mutableBranch(countBranch, 'else').push(
    call('duplicate', 'list.has-duplicate', { items: out('selected', 'values') }),
    { kind: 'if', id: 'duplicate-branch', condition: out('duplicate', 'duplicate'), then: [], else: [] },
  )
  const duplicateBranch = mutableBranch(countBranch, 'else')[mutableBranch(countBranch, 'else').length - 1] as GameplayIfStatement
  actionResult(mutableBranch(duplicateBranch, 'then'), 'duplicate-result', false, literal('不能重复选择同一张手牌'))
  mutableBranch(duplicateBranch, 'else').push(
    call('selected-valid', 'collection.all-in-strings', { items: out('selected', 'values'), allowed: out('eligible', 'value') }),
    { kind: 'if', id: 'selected-valid-branch', condition: out('selected-valid', 'valid'), then: [], else: [] },
  )
  const validBranch = mutableBranch(duplicateBranch, 'else')[mutableBranch(duplicateBranch, 'else').length - 1] as GameplayIfStatement
  actionResult(mutableBranch(validBranch, 'else'), 'invalid-selected-result', false, literal('选择的手牌已无法强化'))
  mutableBranch(validBranch, 'then').push({ kind: 'foreach', id: 'enhance-selected', items: out('selected', 'values'), item: 'card', body: [
    call('definition', 'card.read-definition-id', { player: out('owner', 'player'), card: input('card') }),
    call('enhance-flag', 'card.set-content-boolean', { player: out('owner', 'player'), card: input('card') }, { field: 'velenHolyProphecyEnhanced' }),
    call('clear-prophecy', 'card.clear-content-field', { player: out('owner', 'player'), card: input('card') }, { field: 'velenHolyProphecy' }),
    call('is-smite', 'compare.equal-string', { left: out('definition', 'cardId'), right: literal('holy-smite') }),
    call('is-heal', 'compare.equal-string', { left: out('definition', 'cardId'), right: literal('holy-heal') }),
    call('is-charge', 'compare.equal-string', { left: out('definition', 'cardId'), right: literal('holy-charge') }),
    {
      kind: 'if', id: 'smite-branch', condition: out('is-smite', 'value'), then: [
        call('smite-modifier', 'card.set-effect-modifier', { player: out('owner', 'player'), card: input('card') }, { effect: 'damage', operation: 'multiply', value: 1.5 }),
        call('smite-presentation', 'card.set-presentation', { player: out('owner', 'player'), card: input('card') }, { variant: 'enhanced', badge: '预言强化', description: '预言强化：对敌方生命值最低的棋子造成7点真实伤害。' }),
      ], else: [{
        kind: 'if', id: 'heal-branch', condition: out('is-heal', 'value'), then: [
          call('heal-modifier', 'card.set-effect-modifier', { player: out('owner', 'player'), card: input('card') }, { effect: 'heal', operation: 'multiply', value: 1.5 }),
          call('heal-presentation', 'card.set-presentation', { player: out('owner', 'player'), card: input('card') }, { variant: 'enhanced', badge: '预言强化', description: '预言强化：治疗己方生命值最低的棋子12点生命。' }),
        ], else: [{
          kind: 'if', id: 'charge-branch', condition: out('is-charge', 'value'), then: [
            call('charge-modifier', 'card.set-effect-modifier', { player: out('owner', 'player'), card: input('card') }, { effect: 'statusIntensity', operation: 'multiply', value: 1.5, statusType: 'damage-buff' }),
            call('charge-presentation', 'card.set-presentation', { player: out('owner', 'player'), card: input('card') }, { variant: 'enhanced', badge: '预言强化', description: '预言强化：使己方所有棋子下次造成的伤害提高3点。' }),
          ], else: [],
        }],
      }],
    },
  ] })
  mutableBranch(validBranch, 'then').push(
    call('caster-name', 'attribute.text', { piece: out('caster', 'piece') }, { attribute: 'name' }),
    call('count-text', 'text.from-number', { value: out('selected-count', 'count') }),
    call('message-a', 'text.concat', { left: out('caster-name', 'text'), right: literal('从') }),
    call('message-b', 'text.concat', { left: out('message-a', 'text'), right: out('count-text', 'text') }),
    call('message', 'text.concat', { left: out('message-b', 'text'), right: literal('种圣光的可能中选定了未来') }),
  )
  actionResult(mutableBranch(validBranch, 'then'), 'success-result', true, out('message', 'text'))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: resultOutputs, schemas: [], body }
}

export function buildVelenSkillGraph(id: VelenSkillId): GameplayModuleGraph {
  if (id === 'velen-fate-shelter') return buildFateShelterGraph()
  if (id === 'velen-holy-prophecy') return buildHolyProphecyGraph()
  return buildThousandFuturesGraph()
}

const ignoredFields = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
type SkillDocument = Record<string, unknown> & {
  gameplayModules?: { entries?: { code?: { graph?: unknown } } }
}

function assertPreservedFields(next: Record<string, unknown>, original: Record<string, unknown>, id: string): void {
  for (const key of new Set([...Object.keys(original), ...Object.keys(next)])) {
    if (!ignoredFields.has(key) && JSON.stringify(next[key]) !== JSON.stringify(original[key])) throw new Error(`${id}: changed compatibility field ${key}`)
  }
}

export function preflightVelenSkills(root: string): { migrated: string[]; preserved: string[] } {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries as Record<string, Record<string, unknown>>
  const migrated: string[] = []
  const preserved: string[] = []
  for (const id of VELEN_SKILL_IDS) {
    const original = fixture['skills/' + id]
    if (!original) throw new Error(`missing frozen Velen skill ${id}`)
    const file = path.join(root, 'data/skills', id + '.json')
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as SkillDocument
    const graph = buildVelenSkillGraph(id)
    if (current.gameplayModules?.entries?.code) {
      assertGameplayModuleDocument(current)
      const existing = current.gameplayModules.entries.code.graph
      if (JSON.stringify(existing) !== JSON.stringify(graph)) throw new Error(`${id}: existing gameplay graph differs from approved Velen migration graph`)
      assertPreservedFields(current, original, id)
      preserved.push(id)
      continue
    }
    assertFrozenExecutable(current, original, 'code', 'skill', id)
    assertPreservedFields(current, original, id)
    migrated.push(id)
  }
  return { migrated, preserved }
}

export function migrateVelenSkills(root: string, write = false): { migrated: string[]; preserved: string[] } {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries as Record<string, Record<string, unknown>>
  const migrated: string[] = []
  const preserved: string[] = []
  for (const id of VELEN_SKILL_IDS) {
    const original = fixture['skills/' + id]
    if (!original) throw new Error(`missing frozen Velen skill ${id}`)
    const file = path.join(root, 'data/skills', id + '.json')
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as SkillDocument
    const graph = buildVelenSkillGraph(id)
    if (current.gameplayModules?.entries?.code) {
      assertGameplayModuleDocument(current)
      if (JSON.stringify(current.gameplayModules.entries.code.graph) !== JSON.stringify(graph)) {
        if (!write) throw new Error(`${id}: existing gameplay graph differs from approved Velen migration graph`)
        const next = applyGameplayModuleGraph(current, graph, 'code')
        assertPreservedFields(next, original, id)
        assertGameplayModuleDocument(next)
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
        migrated.push(id)
        continue
      }
      assertPreservedFields(current, original, id)
      preserved.push(id)
      continue
    }
    assertFrozenExecutable(current, original, 'code', 'skill', id)
    const next = applyGameplayModuleGraph(current, graph, 'code')
    assertPreservedFields(next, original, id)
    assertGameplayModuleDocument(next)
    if (write) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
    migrated.push(id)
  }
  return { migrated, preserved }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const write = process.argv.includes('--write')
  console.log(JSON.stringify(migrateVelenSkills(process.cwd(), write)))
}
