import { ATOMIC_FIELD_WRITE_MODULES } from './atomic-migration-field-writes'
import { ATOMIC_DAMAGE_ATTRIBUTION_MODULES } from './atomic-migration-damage-attribution'
import type { GameplayModuleDescriptor } from './module-types'
import { ATOMIC_CARD_WRITE_MODULES } from './atomic-migration-card-writes'
import { ATOMIC_FIELD_ALIASES } from './atomic-migration-fields'
import { ATOMIC_PREDICATE_MODULES } from './atomic-migration-predicates'
import { ATOMIC_VALUE_MODULES } from './module-registry-generic-values'
import { ATOMIC_CAPTURED_FIELD_MODULES } from './atomic-migration-captured-fields'
import { ATOMIC_CAPTURED_EFFECT_MODULES } from './atomic-migration-captured-effects'
import { ATOMIC_CAPTURED_SUMMON_MODULES } from './atomic-migration-captured-summon'
import { ATOMIC_MISC_VALUE_MODULES } from './atomic-migration-misc-values'
import { ATOMIC_CONTEXT_FIELD_MODULES } from './atomic-migration-context-fields'
import { ATOMIC_STATUS_FIELD_MODULES } from './atomic-migration-status-fields'
import { ATOMIC_PREVIEW_FIELD_MODULES } from './atomic-migration-preview-fields'
import { ATOMIC_COLLECTION_ALIASES } from './atomic-migration-collection-aliases'
import { ATOMIC_REMAINING_PREDICATE_MODULES } from './atomic-migration-remaining-predicates'
import { ATOMIC_HAND_QUERY_MODULES } from './atomic-migration-hand-queries'
import { ATOMIC_STORAGE_WRITE_MODULES } from './atomic-migration-storage-writes'
import { ATOMIC_EXTENSION_QUERY_MODULES } from './atomic-migration-extension-queries'
import { ATOMIC_UNIQUE_SUMMON_MODULES } from './atomic-migration-unique-summon'
import { ATOMIC_ABILITY_WRITE_MODULES } from './atomic-migration-ability-writes'
import { ATOMIC_FORMATION_MODULES } from './atomic-migration-formation'
import { ATOMIC_ACTION_HISTORY_MODULES } from './atomic-migration-action-history'
import { ATOMIC_CARD_READ_MODULES } from './atomic-migration-card-reads'
import { ATOMIC_SKILL_DEFINITION_FIELD_MODULES } from './atomic-migration-skill-definition-fields'
import { ATOMIC_STORAGE_READ_MODULES } from './atomic-migration-storage-reads'
import { ATOMIC_SPATIAL_QUERY_MODULES } from './atomic-migration-spatial-queries'
import { ATOMIC_RAW_STATUS_REMOVAL_MODULES } from './atomic-migration-raw-status-removal'
import { ATOMIC_OPTION_CHOICE_MODULES } from './atomic-migration-option-choices'
import { ATOMIC_MARKER_WRITE_MODULES } from './atomic-migration-marker-writes'
import { ATOMIC_CAPTURED_COLLECTION_MODULES } from './atomic-migration-captured-collections'
import { ATOMIC_FLIGHT_STATUS_MODULES } from './atomic-migration-flight-status'
import { ATOMIC_PROJECTILE_QUERY_MODULES } from './atomic-migration-projectile-queries'
import { ATOMIC_MESSAGE_BUFFER_MODULES } from './atomic-migration-message-buffer'
import { ATOMIC_DELAYED_DAMAGE_MODULES } from './atomic-migration-delayed-damage'
import { ATOMIC_EXTENSION_WRITE_MODULES } from './atomic-migration-extension-writes'
import { ATOMIC_QUERY_COMPOSITION_MODULES } from './atomic-migration-query-compositions'
import { ATOMIC_FOLLOWUP_COMPOSITION_MODULES } from './atomic-migration-followup-compositions'
import { ATOMIC_PLAYER_BUFF_MODULES } from './atomic-migration-player-buff-extension'
import { ATOMIC_STATUS_CHOICE_MODULES } from './atomic-migration-status-choice'
import { ATOMIC_REMAINING_AUTHORING_MODULES } from './atomic-migration-remaining-authoring'
import { ATOMIC_LOCAL_ALIAS_MODULES } from './atomic-migration-local-aliases'
import { ATOMIC_SKILL_OWNER_MODULES } from './atomic-migration-skill-owner'
import { ATOMIC_MOVEMENT_MODULES } from './atomic-migration-movement'
import { ATOMIC_SCOPED_FIELD_MODULES } from './atomic-migration-scoped-fields'

/** Old resources can still load these adapters; new authors use their primitive expansions. */
export const RETIRED_AUTHOR_MODULES = new Set([
  ...ATOMIC_FIELD_ALIASES, ...ATOMIC_PREDICATE_MODULES, ...ATOMIC_VALUE_MODULES, ...ATOMIC_CAPTURED_FIELD_MODULES, ...ATOMIC_MISC_VALUE_MODULES,
  ...ATOMIC_CONTEXT_FIELD_MODULES, ...ATOMIC_STATUS_FIELD_MODULES, ...ATOMIC_PREVIEW_FIELD_MODULES,
  ...ATOMIC_COLLECTION_ALIASES,
  ...ATOMIC_REMAINING_PREDICATE_MODULES,
  ...ATOMIC_HAND_QUERY_MODULES,
  ...ATOMIC_STORAGE_WRITE_MODULES,
  ...ATOMIC_EXTENSION_QUERY_MODULES, ...ATOMIC_UNIQUE_SUMMON_MODULES,
  ...ATOMIC_ABILITY_WRITE_MODULES, ...ATOMIC_FORMATION_MODULES,
  ...ATOMIC_ACTION_HISTORY_MODULES,
  ...ATOMIC_CARD_READ_MODULES, ...ATOMIC_SKILL_DEFINITION_FIELD_MODULES,
  ...ATOMIC_STORAGE_READ_MODULES, ...ATOMIC_SPATIAL_QUERY_MODULES,
  ...ATOMIC_RAW_STATUS_REMOVAL_MODULES, ...ATOMIC_MARKER_WRITE_MODULES,
  ...ATOMIC_OPTION_CHOICE_MODULES,
  ...ATOMIC_CARD_WRITE_MODULES,
  ...ATOMIC_CAPTURED_COLLECTION_MODULES,
  ...ATOMIC_FLIGHT_STATUS_MODULES,
  ...ATOMIC_PROJECTILE_QUERY_MODULES,
  ...ATOMIC_MESSAGE_BUFFER_MODULES,
  ...ATOMIC_DELAYED_DAMAGE_MODULES,
  ...ATOMIC_EXTENSION_WRITE_MODULES,
  ...ATOMIC_QUERY_COMPOSITION_MODULES,
  ...ATOMIC_FOLLOWUP_COMPOSITION_MODULES,
  ...ATOMIC_PLAYER_BUFF_MODULES,
  ...ATOMIC_STATUS_CHOICE_MODULES,
  ...ATOMIC_REMAINING_AUTHORING_MODULES,
  ...ATOMIC_LOCAL_ALIAS_MODULES,
  ...ATOMIC_SKILL_OWNER_MODULES,
  ...ATOMIC_MOVEMENT_MODULES,
  ...ATOMIC_SCOPED_FIELD_MODULES,
  ...ATOMIC_DAMAGE_ATTRIBUTION_MODULES,
  ...ATOMIC_FIELD_WRITE_MODULES,
  ...ATOMIC_CAPTURED_EFFECT_MODULES,
  ...ATOMIC_CAPTURED_SUMMON_MODULES,
  'extension.read-piece-cells', 'extension.set-piece-cells',
  'extension.clear-piece-cells', 'extension.remove-empty-piece-store',
  'extension.record-source',
  'query.same-relation', 'compare.allied-players', 'query.has-piece', 'query.has-piece-id', 'query.has-player', 'piece.alive', 'text.from-number',
])

/** Author tasks, shared by the palette and generated reference. */
export const AUTHOR_MODULE_CATEGORIES = {
  data: '变量与数据',
  calculation: '计算与容器',
  selection: '查询与选择',
  control: '流程控制',
  combat: '战斗效果',
  board: '棋盘与召唤',
  'status-rule': '状态与规则',
  'card-ability': '卡牌与能力',
} as const

type Category = keyof typeof AUTHOR_MODULE_CATEGORIES
const categoryGroups: Readonly<Record<string, Category>> = {
  context: 'data', state: 'data', record: 'data', attribute: 'data',
  math: 'calculation', value: 'calculation', logic: 'calculation', condition: 'calculation',
  text: 'calculation', collection: 'calculation', query: 'selection', choice: 'selection',
  flow: 'control', result: 'control', log: 'control', event: 'status-rule',
  status: 'status-rule', rule: 'status-rule', effect: 'combat',
  position: 'board', projectile: 'board', lifecycle: 'board', presentation: 'board',
  skill: 'card-ability', card: 'card-ability', content: 'card-ability', preview: 'data',
}

// An explicit public vocabulary, not a prefix rule that accidentally publishes
// the next compatibility adapter. Native descriptors can opt in explicitly.
const standard = new Set([
  'ref.holder', 'ref.source', 'ref.target', 'ref.player', 'ref.event-player', 'ref.event-piece', 'ref.rule-piece',
  'piece.owner', 'piece.is-core', 'piece.identifier', 'piece.alive',
  'query.pieces', 'query.distance', 'query.players', 'query.pieces-around-cell', 'query.random-cell',
  'attribute.read', 'attribute.text', 'attribute.player-text', 'attribute.adjust', 'attribute.set', 'piece.write-field',
  'resource.read', 'resource.limit', 'resource.adjust', 'turn.number', 'turn.current-player', 'identity.host-time',
  'math.add', 'math.subtract', 'math.multiply', 'math.divide', 'math.modulo', 'math.power', 'math.floor', 'math.abs', 'math.min', 'math.max',
  'compare.equal', 'compare.not-equal', 'compare.equal-string', 'compare.not-equal-string', 'compare.equal-string-nullable',
  'compare.equal-boolean', 'compare.not-equal-boolean', 'compare.equal-piece', 'compare.not-equal-piece',
  'compare.equal-player', 'compare.not-equal-player', 'compare.less-than', 'compare.less-or-equal',
  'compare.greater-than', 'compare.greater-or-equal',
  'logic.and', 'logic.or', 'logic.not', 'logic.select-number',
  'text.concat', 'text.from-number', 'text.join-list', 'collection.length', 'collection.at', 'collection.sort',
  'damage.killed', 'damage.batch-kill-count', 'damage.batch-total',
  'effect.displace-one', 'effect.displace-policy', 'effect.swap-pieces', 'effect.displace-many', 'effect.free-move', 'effect.destroy-walls', 'effect.force-defeat',
  'spatial.piece-position', 'spatial.cell', 'spatial.cell-distance', 'spatial.map-cells',
  'spatial.cell-coordinates', 'spatial.cell-equal', 'spatial.cardinal-cells', 'spatial.ray-cells',
  'spatial.adjacent-cells-ordered', 'spatial.cell-in-list', 'spatial.cell-landing-legal',
  'movement.trace', 'movement.first-trace-obstruction', 'movement.actual-path-enemies', 'projectile.trace',
  'tile.has-effect', 'tile.add-source-effect', 'tile.remove-source-effects',
  'status.has-piece', 'status.has-player', 'status.count-piece', 'status.find-instance', 'status.make-id',
  'status.read-number-instance', 'status.set-number-instance', 'status.apply-record', 'status.apply-player-record',
  'status.remove-piece', 'status.remove-player', 'rule.has-piece',
  'rule.apply-piece', 'rule.apply-player', 'rule.remove-piece', 'rule.remove-player',
  'event.type', 'event.player', 'event.actual-damage', 'event.read-number', 'event.write-number', 'event.read-string',
  'event.target-cell', 'event.movement-kind', 'event.single-piece-target-action', 'event.skill-id', 'event.reserved-cells', 'event.block',
  'card.hand-instances', 'card.hand-count', 'card.hand-add', 'card.discard-instance',
  'skill.add', 'skill.remove', 'skill.identifiers', 'skill.adjust-cooldown', 'skill.power-multiplier', 'result.action',
  'log.trigger-effect', 'preview.piece-number', 'preview.skill-number', 'preview.result',
])

const categoryOverrides: Readonly<Record<string, Category>> = {
  'attribute.read': 'data', 'attribute.text': 'data', 'attribute.player-text': 'data', 'attribute.set': 'data', 'attribute.adjust': 'data',
  'effect.displace-one': 'board', 'effect.displace-many': 'board', 'effect.free-move': 'board',
  'effect.destroy-walls': 'board', 'effect.teleport': 'board', 'effect.displace-policy': 'board', 'effect.swap-pieces': 'board',
  'resource.read': 'combat', 'resource.adjust': 'combat', 'resource.limit': 'combat',
}

/** Metadata only: never changes lowering, versions, or existing content. */
export function authorModuleUi(entry: GameplayModuleDescriptor): NonNullable<GameplayModuleDescriptor['ui']> {
  const category = entry.ui?.category
  const normalized = category && Object.hasOwn(AUTHOR_MODULE_CATEGORIES, category)
    ? category as Category
    : categoryOverrides[entry.id] || categoryGroups[category || ''] || categoryGroups[entry.id.split('.')[0]] || 'data'
  return {
    ...entry.ui,
    category: normalized,
    authoring: RETIRED_AUTHOR_MODULES.has(entry.id) || entry.id === 'logic.select' && entry.version === '1' ? 'compatibility' : entry.ui?.authoring || (standard.has(entry.id) ? 'standard' : 'compatibility'),
  }
}
