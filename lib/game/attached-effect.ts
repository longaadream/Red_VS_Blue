/**
 * attached-effect.ts
 *
 * 统一效果系统：替代原有 rule + statusTag 二元体系。
 *
 * 一个 AttachedEffect 同时描述：
 *   - 视觉状态（图标、颜色，显示在棋子上）
 *   - 被动触发器（声明监听哪个事件，filter + effect 均为完整 JS 函数字符串）
 *   - 生命周期（turns / uses / permanent）
 *   - 运行时数据（stacks、intensity 等）
 *
 * 无需单独的 rule 文件，也无需手动管理 relatedRules。
 */

import { getDataRoot } from '@/lib/app-paths'

// ── 类型定义 ──────────────────────────────────────────────────────────────────

/** 单条触发器规范（来自 effects/*.json 的 triggers[] 数组） */
export interface EffectTriggerSpec {
  /** 事件名（任意字符串，内置如 "beforeDamageDealt"，也可以自定义如 "shishio-burn-applied"） */
  on: string
  /** 执行优先级，越小越先（默认 50） */
  priority?: number
  /** 过滤函数字符串：(ctx, battle, self) => boolean — 完整 JS，可含任意 if 语句 */
  filterCode: string
  /** 效果函数字符串：(ctx, battle, self) => { success, message?, blocked?, ... } */
  effectCode: string
}

/** 效果定义（对应 data/effects/*.json） */
export interface AttachedEffectDefinition {
  id: string
  name: string
  icon?: string
  color?: string
  /** 是否在棋子上显示视觉标记（默认 true） */
  visible?: boolean
  /** 如果指定，statusTag 创建时使用此 type 而不是 effectId。
   *  当 filterCode 检查旧版 statusTag type 时使用。 */
  statusType?: string
  /** 初始数据，applyEffect 时会浅拷贝到实例的 data 字段 */
  initialData?: Record<string, any>
  triggers: EffectTriggerSpec[]
}

/** 效果实例（挂载在 PieceInstance.attachedEffects[] 上） */
export interface AttachedEffectInstance {
  /** 唯一实例 ID，格式为 `{definitionId}-{ownerId}` */
  instanceId: string
  id?: string
  /** 对应的 data/effects/*.json 的 id */
  definitionId: string
  effectId?: string
  /** 拥有此效果的棋子 instanceId */
  ownerId: string
  /** 视觉属性（从定义复制过来） */
  visible?: boolean
  icon?: string
  label?: string
  color?: string
  /** 生命周期（可选，不设则永久存在直到手动 expire） */
  duration?: {
    type: 'turns' | 'uses' | 'permanent'
    remaining: number
  }
  /** 运行时可变数据（stacks、intensity、shieldActive 等） */
  data: Record<string, any>
  /** 触发器列表（从定义复制，避免每次重新加载文件） */
  triggers: EffectTriggerSpec[]
}

// ── 效果定义缓存 ───────────────────────────────────────────────────────────────

const effectCache = new Map<string, AttachedEffectDefinition>()

/** 从 data/effects/{effectId}.json 加载效果定义（有缓存） */
export function loadEffectDefinition(effectId: string): AttachedEffectDefinition | null {
  if (effectCache.has(effectId)) return effectCache.get(effectId)!
  try {
    const fs = require('fs')
    const path = require('path')
    const filePath = path.join(getDataRoot(), 'effects', `${effectId}.json`)
    if (!fs.existsSync(filePath)) {
      console.warn(`[loadEffectDefinition] Not found: ${filePath}`)
      return null
    }
    const def = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AttachedEffectDefinition
    effectCache.set(effectId, def)
    return def
  } catch (e) {
    console.warn(`[loadEffectDefinition] Error loading ${effectId}:`, e)
    return null
  }
}

/** 加载 data/effects/ 下所有效果定义 */
export function loadAllEffects(): Record<string, AttachedEffectDefinition> {
  try {
    const fs = require('fs')
    const path = require('path')
    const dir = path.join(getDataRoot(), 'effects')
    if (!fs.existsSync(dir)) return {}
    const files: string[] = fs.readdirSync(dir).filter((f: string) => f.endsWith('.json') && f !== 'manifest.json')
    const result: Record<string, AttachedEffectDefinition> = {}
    for (const file of files) {
      const id = file.replace('.json', '')
      const def = loadEffectDefinition(id)
      if (def) result[id] = def
    }
    return result
  } catch {
    return {}
  }
}

// ── 效果应用 / 移除 ────────────────────────────────────────────────────────────

/**
 * 将效果应用到棋子。
 * 同时写入 piece.attachedEffects 和（若可见）piece.statusTags。
 * @returns 是否成功应用（已存在同 id 效果时返回 false）
 */
export function applyEffectToPiece(
  battle: any,
  pieceId: string,
  effectId: string,
  dataOverrides?: Record<string, any>
): boolean {
  const piece = battle.pieces.find((p: any) => p.instanceId === pieceId)
  if (!piece) return false

  const def = loadEffectDefinition(effectId)
  if (!def) {
    console.warn(`[applyEffect] Definition not found: ${effectId}`)
    return false
  }

  if (!piece.attachedEffects) piece.attachedEffects = []

  const instanceId = `${effectId}-${pieceId}`

  // 防止重复应用
  if (piece.attachedEffects.some((e: AttachedEffectInstance) => e.instanceId === instanceId)) {
    return false
  }

  const instance: AttachedEffectInstance = {
    instanceId,
    definitionId: effectId,
    ownerId: pieceId,
    visible: def.visible !== false,
    icon: def.icon,
    label: def.name,
    color: def.color,
    data: { ...(def.initialData || {}), ...(dataOverrides || {}) },
    triggers: def.triggers || []
  }

  piece.attachedEffects.push(instance)

  // 若可见，同步写 statusTag（供 UI 显示）
  if (instance.visible) {
    if (!piece.statusTags) piece.statusTags = []
    const alreadyTag = piece.statusTags.find((t: any) => t.id === instanceId)
    if (!alreadyTag) {
      piece.statusTags.push({
        id: instanceId,
        type: def.statusType || effectId,
        name: def.name,
        icon: def.icon,
        color: def.color,
        visible: true,
        relatedRules: []
      })
    }
  }

  return true
}

/**
 * 从棋子移除效果（同时清理 statusTag）。
 */
export function removeEffectFromPiece(
  battle: any,
  pieceId: string,
  effectId: string
): boolean {
  const piece = battle.pieces.find((p: any) => p.instanceId === pieceId)
  if (!piece) return false

  const instanceId = `${effectId}-${pieceId}`

  if (piece.attachedEffects) {
    const idx = piece.attachedEffects.findIndex((e: AttachedEffectInstance) => e.instanceId === instanceId)
    if (idx !== -1) piece.attachedEffects.splice(idx, 1)
  }

  if (piece.statusTags) {
    const tagIdx = piece.statusTags.findIndex((t: any) => t.id === instanceId)
    if (tagIdx !== -1) piece.statusTags.splice(tagIdx, 1)
  }

  return true
}

/**
 * 获取棋子上的效果实例（不存在返回 null）。
 */
export function getEffectOnPiece(
  battle: any,
  pieceId: string,
  effectId: string
): AttachedEffectInstance | null {
  const piece = battle.pieces.find((p: any) => p.instanceId === pieceId)
  if (!piece?.attachedEffects) return null
  const instanceId = `${effectId}-${pieceId}`
  return piece.attachedEffects.find((e: AttachedEffectInstance) => e.instanceId === instanceId) ?? null
}

// ── Self 对象 ─────────────────────────────────────────────────────────────────

/**
 * 构建 trigger 函数的第三个参数 `self`。
 * 提供效果数据访问和生命周期操作。
 */
export function buildSelfObject(effect: AttachedEffectInstance, piece: any, battle: any) {
  return {
    instanceId: effect.instanceId,
    definitionId: effect.definitionId,
    ownerId: effect.ownerId,
    ownerName: piece?.name ?? '',
    /** 运行时可变数据（intensity、stacks 等） */
    data: effect.data,
    /** 立即使效果过期并移除（从 attachedEffects 和 statusTags 中删除） */
    expire() {
      removeEffectFromPiece(battle, effect.ownerId, effect.definitionId)
    },
    /** 消耗一次使用次数；若次数耗尽则自动过期 */
    consumeUse() {
      if (effect.duration && effect.duration.type === 'uses') {
        effect.duration.remaining = Math.max(0, effect.duration.remaining - 1)
        if (effect.duration.remaining <= 0) {
          removeEffectFromPiece(battle, effect.ownerId, effect.definitionId)
        }
      }
    }
  }
}
