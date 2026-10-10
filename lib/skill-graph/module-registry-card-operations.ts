import type {
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayPort,
} from './module-types'

type LoweringContext = GameplayNativeLoweringContext

const input = (ctx: LoweringContext, name: string) =>
  ctx.inputs[name]

const port = (name: string, type: GameplayPort['type'], options: Partial<GameplayPort> = {}): GameplayPort => ({ name, type, ...options })

const active: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']

const read = (domains: string[]) => ({ pure: true, previewSafe: false, reads: domains })

const write = (domains: string[], events: string[] = []) => ({ pure: false, previewSafe: false, writes: domains, events })

function define(value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'>, surfaces: readonly GameplayModuleSurface[] = active): GameplayModuleDescriptor {
  return { version: '1', allowedSurfaces: surfaces, ...value }
}

const runtime = (ctx: LoweringContext) =>
  ctx.surface === 'pending' ? 'ctx.flow' : 'flow'

const battle = (ctx: LoweringContext) =>
  ctx.surface === 'pending' ? 'ctx.battle' : 'battle'

const ownerPieceList = (ctx: LoweringContext, owner: string, relation: string) =>
  `(${owner} == null ? [] : ${runtime(ctx)}.query.pieces({ ownerId: ${owner}, relation: ${relation}, includeDead: false }))`

/**
 * Card content occasionally needs a small amount of host-owned state which is
 * intentionally not expressible as a card-specific script. These descriptors
 * keep those operations typed and reusable while leaving the game host as the
 * authority for piece lookup, target policy, status lifecycle, and queues.
 */
export const CARD_OPERATION_GAMEPLAY_MODULES: GameplayModuleDescriptor[] = [
  define({
    id: 'query.players', label: '按对局顺序查询玩家', inputs: [], outputs: [port('players', { kind: 'list', element: 'player' })],
    effects: read(['players']), lower: ctx => `${runtime(ctx)}.query.players()`,
  }),
  define({
    id: 'query.random-string', label: '按种子随机选择标识', inputs: [port('items', { kind: 'list', element: 'string' })], outputs: [port('value', 'string')],
    effects: { ...read(['random']), random: true },
    lower: ctx => `(function(items) { if (!items.length) throw new Error('query.random-string requires a nonempty list'); return ${runtime(ctx)}.query.random(items); })(${input(ctx, 'items')})`,
  }),
  define({
    id: 'player.set-buff-record', label: '设置玩家增益记录', inputs: [port('player', 'player'), port('record', 'record')], outputs: [port('success', 'boolean')],
    parameters: [port('buffId', 'string')], effects: write(['player-buffs']),
    lower: ctx => `${runtime(ctx)}.cards.setPlayerBuff(${input(ctx, 'player')}, ${ctx.emitLiteral(ctx.parameters.buffId)}, ${input(ctx, 'record')})`,
  }),
  define({
    id: 'source.capture-event-piece', label: '保留当前事件棋子', inputs: [],
    outputs: [port('source', 'record', { nullable: true })],
    parameters: [{ name: 'field', type: 'string', enum: ['sourcePiece', 'targetPiece', 'piece', 'rulePiece'] }],
    effects: write(['execution-context']),
    lower: ctx => `${runtime(ctx)}.effects.captureEventPiece(${ctx.emitLiteral(ctx.parameters.field)})`,
  }),
  define({
    id: 'source.is-present', label: '事件来源存在', inputs: [port('source', 'record', { nullable: true })],
    outputs: [port('value', 'boolean')], effects: read(['execution-context']),
    lower: ctx => `(${input(ctx, 'source')} != null)`,
  }),
  define({
    id: 'source.require-present', label: '解析已确认事件来源', inputs: [port('source', 'record', { nullable: true })],
    outputs: [port('source', 'record')], effects: read(['execution-context']),
    lower: ctx => `(function(source) { ${runtime(ctx)}.effects.capturedOwner(source); return source; })(${input(ctx, 'source')})`,
  }),
  define({
    id: 'source.captured-owner', label: '读取已保留来源归属', inputs: [port('source', 'record')],
    outputs: [port('player', 'player')], effects: read(['execution-context']),
    lower: ctx => `${runtime(ctx)}.effects.capturedOwner(${input(ctx, 'source')})`,
  }),
  define({
    id: 'effect.damage-captured', label: '结算已保留事件对象伤害',
    inputs: [port('source', 'record'), port('target', 'record'), port('amount', 'number')],
    outputs: [port('result', 'record')],
    parameters: [{ name: 'damageType', type: 'string', enum: ['physical', 'magical', 'true'] }, { name: 'skillId', type: 'string' }],
    effects: write(['damage', 'events']),
    lower: ctx => `${runtime(ctx)}.effects.damageCaptured(${input(ctx, 'source')}, ${input(ctx, 'target')}, ${input(ctx, 'amount')}, ${ctx.emitLiteral(ctx.parameters.damageType)}, ${ctx.emitLiteral(ctx.parameters.skillId)})`,
  }),
  define({
    id: 'card.bound-living-template',
    label: '解析绑定的存活棋子',
    inputs: [port('owner', 'player', { nullable: true })],
    outputs: [port('piece', 'piece', { nullable: true })],
    parameters: [port('templateId', 'string'), port('cardId', 'string')],
    effects: read(['pieces', 'card']),
    lower: (ctx) => {
      const owner = input(ctx, 'owner')
      const templateId = ctx.emitLiteral(ctx.parameters.templateId)
      const cardId = ctx.emitLiteral(ctx.parameters.cardId)
      const board = battle(ctx)
      return `(function(owner, templateId, cardId) {
        var pieces = (${board}.pieces || []);
        var player = (${board}.players || []).find(function(item) { return item && item.playerId === owner; });
        var hand = player && Array.isArray(player.hand) ? player.hand : [];
        var card = hand.find(function(item) { return item && item.cardId === cardId && item.boundPieceInstanceId; });
        var boundId = card && card.boundPieceInstanceId;
        if (boundId) {
          var bound = pieces.find(function(piece) {
            return piece && piece.instanceId === boundId && Number(piece.currentHp || 0) > 0;
          });
          return bound ? bound.instanceId : null;
        }
        var fallback = pieces.find(function(piece) {
          return piece && piece.ownerPlayerId === owner && piece.templateId === templateId && Number(piece.currentHp || 0) > 0;
        });
        return fallback ? fallback.instanceId : null;
      })(${owner}, ${templateId}, ${cardId})`
    },
  }),
  define({
    id: 'query.living-template',
    label: '查询玩家拥有的存活模板棋子',
    inputs: [port('owner', 'player', { nullable: true })],
    outputs: [port('piece', 'piece', { nullable: true })],
    parameters: [port('templateId', 'string')],
    effects: read(['pieces']),
    lower: (ctx) => {
      const owner = input(ctx, 'owner')
      const templateId = ctx.emitLiteral(ctx.parameters.templateId)
      const pieces = ownerPieceList(ctx, owner, ctx.emitLiteral('ally'))
      return `(function(owner, templateId) {
        var ids = ${pieces} || [];
        for (var index = 0; index < ids.length; index += 1) {
          var piece = ${runtime(ctx)}.query.piece(ids[index]);
          if (piece && piece.ownerPlayerId === owner && piece.templateId === templateId && Number(piece.currentHp || 0) > 0) return piece.instanceId;
        }
        return null;
      })(${owner}, ${templateId})`
    },
  }),
  define({
    id: 'query.affectable-pieces',
    label: '查询卡牌可影响的存活棋子',
    inputs: [port('owner', 'player', { nullable: true })],
    outputs: [port('pieces', { kind: 'list', element: 'piece' })],
    parameters: [{ name: 'relation', type: 'string', enum: ['ally', 'enemy'] }],
    effects: read(['pieces', 'target-policy']),
    lower: (ctx) => {
      const owner = input(ctx, 'owner')
      const relation = ctx.emitLiteral(ctx.parameters.relation)
      const ids = ownerPieceList(ctx, owner, relation)
      return `((${ids}) || []).filter(function(pieceId) {
        var piece = ${runtime(ctx)}.query.piece(pieceId);
        return piece && canAffectAdventureTarget(${battle(ctx)}, ${owner}, piece);
      })`
    },
  }),
  define({
    id: 'query.lowest-hp',
    label: '选择生命值最低的棋子',
    inputs: [port('pieces', { kind: 'list', element: 'piece' })],
    outputs: [port('piece', 'piece', { nullable: true })],
    effects: read(['pieces']),
    lower: (ctx) => {
      const pieces = input(ctx, 'pieces')
      return `(function(ids) {
        var selected = null;
        (ids || []).forEach(function(pieceId) {
          var piece = ${runtime(ctx)}.query.piece(pieceId);
          if (piece && (!selected || Number(piece.currentHp || 0) < Number(selected.currentHp || 0))) selected = piece;
        });
        return selected ? selected.instanceId : null;
      })(${pieces})`
    },
  }),
  define({
    id: 'piece.display-name',
    label: '读取卡牌消息中的棋子名称',
    inputs: [port('piece', 'piece', { nullable: true })],
    outputs: [port('value', 'string')],
    parameters: [{ name: 'fallback', type: 'string', enum: ['none', 'templateId'], default: 'none' }],
    effects: read(['pieces']),
    lower: (ctx) => {
      const pieceId = input(ctx, 'piece')
      const flow = runtime(ctx)
      const fallback = ctx.parameters.fallback === 'templateId' ? 'piece.name || piece.templateId' : 'piece.name'
      return `(function(id) {
        var piece = id == null ? null : ${flow}.query.piece(id);
        return String(piece == null ? undefined : ${fallback});
      })(${pieceId})`
    },
  }),
  define({
    id: 'piece.captured-name',
    label: '读取已保留棋子名称',
    description: '读取本次结算中已捕获的棋子；即使棋子随后离场，当前效果仍可生成稳定消息。',
    inputs: [port('source', 'record')],
    outputs: [port('value', 'string')],
    parameters: [{ name: 'fallback', type: 'string', enum: ['none', 'templateId'], default: 'none' }],
    effects: read(['execution-context']),
    lower: (ctx) => `${runtime(ctx)}.effects.capturedName(${input(ctx, 'source')}, ${ctx.emitLiteral(ctx.parameters.fallback ?? 'none')})`,
  }),
  define({
    id: 'attribute.adjust-captured',
    label: '调整已保留棋子属性',
    description: '对本次结算中已捕获的棋子调整属性；棋子离场后仍完成已经开始的效果。',
    inputs: [port('source', 'record'), port('amount', 'number')],
    outputs: [port('value', 'number')],
    parameters: [{ name: 'attribute', type: 'string', enum: ['attack', 'defense', 'moveRange'] }],
    effects: write(['pieces', 'execution-context']),
    lower: (ctx) => `${runtime(ctx)}.effects.capturedAttribute(${input(ctx, 'source')}, ${ctx.emitLiteral(ctx.parameters.attribute)}, ${input(ctx, 'amount')})`,
  }),
  define({
    id: 'effect.damage-from-player',
    label: '以玩家来源造成伤害',
    inputs: [port('owner', 'player'), port('target', 'piece'), port('amount', 'number')],
    outputs: [port('result', 'record'), port('success', 'boolean'), port('damage', 'number')],
    parameters: [
      { name: 'kind', type: 'string', enum: ['player', 'environment'] },
      port('instanceId', 'string'),
      port('name', 'string'),
      { name: 'damageType', type: 'string', enum: ['normal', 'true', 'toxin'], default: 'normal' },
      { name: 'legacyNormalSpelling', type: 'string', enum: ['physical', 'magical'], optional: true },
      { name: 'skillId', type: 'string', optional: true },
      { name: 'inputPolicy', type: 'string', enum: ['floor', 'host'], optional: true },
    ],
    effects: write(['damage', 'events'], ['beforeDamageDealt', 'afterDamageDealt']),
    lower: (ctx) => {
      const owner = input(ctx, 'owner')
      const target = input(ctx, 'target')
      const amount = input(ctx, 'amount')
      const damageType = ctx.parameters.damageType ?? 'normal'
      const kind = ctx.emitLiteral(damageType)
      const engineKind = damageType === 'normal'
        ? ctx.emitLiteral(ctx.parameters.legacyNormalSpelling ?? 'physical')
        : kind
      const skillId = Object.prototype.hasOwnProperty.call(ctx.parameters, 'skillId')
        ? ctx.emitLiteral(ctx.parameters.skillId)
        : `${ctx.surface === 'pending' ? 'ctx' : 'context'}.skill?.id || ${ctx.surface === 'pending' ? 'ctx' : 'context'}.ruleId || "flow"`
      const policy = Object.prototype.hasOwnProperty.call(ctx.parameters, 'inputPolicy')
        ? `, ${ctx.emitLiteral(ctx.parameters.inputPolicy)}`
        : ''
      const source = `{ kind: ${ctx.emitLiteral(ctx.parameters.kind)}, instanceId: ${ctx.emitLiteral(ctx.parameters.instanceId)}, ownerPlayerId: ${owner}, name: ${ctx.emitLiteral(ctx.parameters.name)} }`
      const call = `${runtime(ctx)}.effects.damage(${source}, ${target}, ${amount}, ${engineKind}, ${skillId}${policy})`
      return `(function(value) { return { result: value, success: value.success, damage: value.damage }; })(${call})`
    },
  }),
  define({
    id: 'effect.damage-from-piece',
    label: '以棋子来源造成卡牌伤害',
    inputs: [port('source', 'piece'), port('target', 'piece'), port('amount', 'number')],
    outputs: [port('result', 'record'), port('success', 'boolean'), port('damage', 'number')],
    parameters: [
      { name: 'damageType', type: 'string', enum: ['normal', 'true', 'toxin'], default: 'normal' },
      { name: 'legacyNormalSpelling', type: 'string', enum: ['physical', 'magical'], optional: true },
      { name: 'skillId', type: 'string', optional: true },
    ],
    effects: write(['damage', 'events'], ['beforeDamageDealt', 'afterDamageDealt']),
    lower: (ctx) => {
      const damageType = ctx.parameters.damageType ?? 'normal'
      const kind = ctx.emitLiteral(damageType)
      const engineKind = damageType === 'normal'
        ? ctx.emitLiteral(ctx.parameters.legacyNormalSpelling ?? 'physical')
        : kind
      const skillId = Object.prototype.hasOwnProperty.call(ctx.parameters, 'skillId')
        ? ctx.emitLiteral(ctx.parameters.skillId)
        : 'context.card?.id || "flow"'
      const flow = runtime(ctx)
      const source = `${flow}.query.piece(${input(ctx, 'source')})`
      const target = `${flow}.query.piece(${input(ctx, 'target')})`
      const call = `dealDamage(${source}, ${target}, ${input(ctx, 'amount')}, ${engineKind}, battle, ${skillId})`
      return `(function(value) { return { result: value, success: value.success, damage: value.damage }; })(${call})`
    },
  }, ['card']),
  define({
    id: 'player.consume-buff',
    label: '消耗玩家增益并返回倍率',
    inputs: [port('player', 'player')],
    outputs: [port('applied', 'boolean'), port('multiplier', 'number')],
    parameters: [port('buffId', 'string')],
    effects: write(['player-buffs']),
    lower: (ctx) => {
      const player = input(ctx, 'player')
      const flow = runtime(ctx)
      return `(function(playerId, buffId) {
        var player = playerId == null ? null : ${flow}.query.player(playerId);
        var buff = player && player.buffs && player.buffs[buffId];
        if (!buff || Number(buff.uses || 0) <= 0) return { applied: false, multiplier: 1 };
        buff.uses = Number(buff.uses || 0) - 1;
        return { applied: true, multiplier: Number(buff.multiplier) };
      })(${player}, ${ctx.emitLiteral(ctx.parameters.buffId)})`
    },
  }),
  define({
    id: 'effect.status-record',
    label: '通过卡牌状态生命周期应用状态记录',
    inputs: [port('target', 'piece'), port('record', 'record')],
    outputs: [port('success', 'boolean')],
    parameters: [{ name: 'inputPolicy', type: 'string', enum: ['flow', 'host'], default: 'flow' }],
    effects: write(['status'], ['status-applied']),
    lower: (ctx) => {
      const target = input(ctx, 'target')
      const record = input(ctx, 'record')
      if (ctx.surface === 'card' && ctx.parameters.inputPolicy === 'host') {
        return `(function(target, record) {
          if (!target) return false;
          addStatusEffectById(target, record);
          return true;
        })(${target}, ${record})`
      }
      const policy = ctx.parameters.inputPolicy === 'host' ? 'host' : 'flow'
      return `${runtime(ctx)}.status.add(${target}, ${record}, 'piece', ${ctx.emitLiteral(policy)})`
    },
  }),
  define({
    id: 'summon.unique-template-available',
    label: '检查唯一储存召唤是否尚未上场',
    inputs: [port('owner', 'player', { nullable: true })],
    outputs: [port('available', 'boolean')],
    parameters: [port('templateId', 'string'), port('storageExtensionKey', 'string'), port('ownerScopedStorageExtensionKey', 'string')],
    effects: read(['pieces', 'extensions']),
    lower: (ctx) => {
      const owner = input(ctx, 'owner')
      const board = battle(ctx)
      return `(function(owner, templateId, storageKey, ownerStorageKey) {
        var extensions = ${board}.extensions || {};
        var ownerKey = String(owner || '').trim().toLowerCase();
        var scoped = extensions[ownerStorageKey];
        var stored = scoped && scoped[ownerKey] ? scoped[ownerKey] : null;
        if (!stored) {
          var legacy = extensions[storageKey];
          stored = legacy && String(legacy.ownerPlayerId || '').trim().toLowerCase() === ownerKey ? legacy : null;
        }
        if (stored) return true;
        return !((${board}.pieces || []).some(function(piece) {
          return piece && Number(piece.currentHp || 0) > 0 && String(piece.ownerPlayerId || '').trim().toLowerCase() === ownerKey && (piece.templateId === templateId || piece.instanceId === templateId);
        }));
      })(${owner}, ${ctx.emitLiteral(ctx.parameters.templateId)}, ${ctx.emitLiteral(ctx.parameters.storageExtensionKey)}, ${ctx.emitLiteral(ctx.parameters.ownerScopedStorageExtensionKey)})`
    },
  }),
  define({
    id: 'card.cell-unoccupied',
    label: '检查卡牌召唤地格为空',
    inputs: [port('cell', 'cell', { nullable: true })],
    outputs: [port('value', 'boolean')],
    effects: read(['position', 'pieces']),
    lower: (ctx) => {
      const cell = input(ctx, 'cell')
      const state = battle(ctx)
      return `(function(cell) {
        if (!cell) return false;
        return !((${state}.pieces || []).some(function(piece) {
          return piece && Number(piece.currentHp || 0) > 0 && piece.x === cell.x && piece.y === cell.y;
        }));
      })(${cell})`
    },
  }),
  define({
    id: 'card.piece-present',
    label: '检查棋子引用存在',
    inputs: [port('value', 'piece', { nullable: true })],
    outputs: [port('present', 'boolean')],
    effects: read([]),
    lower: (ctx) => `(${input(ctx, 'value')} !== null && ${input(ctx, 'value')} !== undefined && ${input(ctx, 'value')} !== __gameplayInvalid)`,
  }),
  define({
    id: 'card.string-present',
    label: '检查文本引用存在',
    inputs: [port('value', 'string', { nullable: true })],
    outputs: [port('present', 'boolean')],
    effects: read([]),
    lower: (ctx) => `(${input(ctx, 'value')} !== null && ${input(ctx, 'value')} !== undefined && ${input(ctx, 'value')} !== __gameplayInvalid)`,
  }),
  define({
    id: 'lifecycle.queue-stored-summon',
    label: '在已验证地格排队储存召唤',
    inputs: [port('source', 'piece'), port('cell', 'cell')],
    outputs: [port('queued', 'number')],
    effects: write(['summon'], ['summon-queued']),
    lower: (ctx) => {
      const source = input(ctx, 'source')
      const cell = input(ctx, 'cell')
      return `${runtime(ctx)}.lifecycle.summon({ sourceId: ${source}, summons: [{ x: ${cell}.x, y: ${cell}.y }] })`
    },
  }),
  define({
    id: 'lifecycle.summon-captured',
    label: '排队召唤已保留棋子',
    description: '使用本次结算中已捕获的棋子排队召唤；来源随后离场也不会丢失召唤。',
    inputs: [port('source', 'record'), port('cell', 'cell')],
    outputs: [port('queued', 'number')],
    effects: write(['summon', 'execution-context'], ['summon-queued']),
    lower: (ctx) => `${runtime(ctx)}.lifecycle.summonCaptured(${input(ctx, 'source')}, ${input(ctx, 'cell')})`,
  }),
  define({
    id: 'effect.result-killed',
    label: '读取伤害结果的击杀标记',
    inputs: [port('result', 'record')],
    outputs: [port('killed', 'boolean')],
    effects: read(['damage']),
    lower: (ctx) => {
      const result = input(ctx, 'result')
      return `Boolean(${result} && ${result}.isKilled)`
    },
  }),
]
