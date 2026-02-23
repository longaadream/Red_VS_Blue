"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import {
  ArrowLeft,
  RotateCcw,
  ChevronRight,
  Zap,
  Swords,
  Shield,
  Play,
  SkipForward,
  Target,
  X,
  ChevronDown,
  ChevronUp,
  Info,
} from "lucide-react"

// ─── 类型 ────────────────────────────────────────────────────────────────────

interface PieceTemplate {
  id: string
  name: string
  faction: "red" | "blue" | "neutral"
  stats: { maxHp: number; attack: number; defense: number; moveRange: number }
  skills: Array<{ skillId: string; level?: number }>
}

interface PieceInstance {
  instanceId: string
  templateId: string
  name: string
  ownerPlayerId: string
  faction: string
  currentHp: number
  maxHp: number
  attack: number
  defense: number
  moveRange: number
  x: number | null
  y: number | null
  skills: Array<{ skillId: string; currentCooldown?: number; usesRemaining?: number }>
  statusTags: Array<{ id: string; type: string; currentDuration?: number; stacks?: number; intensity?: number }>
  rules: any[]
}

interface PlayerMeta {
  playerId: string
  chargePoints: number
  actionPoints: number
  maxActionPoints: number
}

interface TurnState {
  currentPlayerId: string
  turnNumber: number
  phase: "start" | "action" | "end"
  actions: { hasMoved: boolean; hasUsedBasicSkill: boolean; hasUsedChargeSkill: boolean }
}

interface ActionLog {
  type: string
  playerId: string
  turn: number
  payload?: { message?: string; [k: string]: any }
}

interface BattleState {
  pieces: PieceInstance[]
  graveyard: PieceInstance[]
  players: PlayerMeta[]
  turn: TurnState
  skillsById: Record<string, { id: string; name: string; actionPointCost: number; cooldownTurns: number; chargeCost?: number; type: string }>
  actions?: ActionLog[]
}

interface TargetRequest {
  targetType: "piece" | "grid"
  range: number
  filter: "enemy" | "ally" | "all"
  pendingAction: any
}

const RED_ID = "debug-red"
const BLUE_ID = "debug-blue"

// ─── API 工具 ────────────────────────────────────────────────────────────────

async function apiGet(): Promise<{ availablePieces: PieceTemplate[]; battleState: BattleState | null }> {
  const r = await fetch("/api/debug-battle")
  return r.json()
}

async function apiPost(body: any): Promise<{ battleState?: BattleState; error?: string; needsTargetSelection?: boolean; targetType?: string; range?: number; filter?: string }> {
  const r = await fetch("/api/debug-battle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return r.json()
}

// ─── 子组件 ──────────────────────────────────────────────────────────────────

function HpBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 0
  const color = pct > 50 ? "bg-green-500" : pct > 25 ? "bg-yellow-500" : "bg-red-500"
  return (
    <div className="h-1.5 w-full rounded-full bg-zinc-700">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function StatusBadge({ tag }: { tag: { id: string; type: string; currentDuration?: number; stacks?: number } }) {
  return (
    <span className="inline-flex items-center gap-0.5 rounded bg-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300">
      {tag.type}
      {tag.stacks && tag.stacks > 1 && <span className="text-yellow-400">×{tag.stacks}</span>}
      {tag.currentDuration !== undefined && tag.currentDuration !== -1 && (
        <span className="text-zinc-500">/{tag.currentDuration}t</span>
      )}
    </span>
  )
}

function PieceCard({
  piece,
  isCurrentPlayer,
  isActionPhase,
  skillsById,
  onSkill,
  isSelectingTarget,
  onSelectAsTarget,
  targetFilter,
  currentPlayerId,
}: {
  piece: PieceInstance
  isCurrentPlayer: boolean
  isActionPhase: boolean
  skillsById: BattleState["skillsById"]
  onSkill: (pieceId: string, skillId: string) => void
  isSelectingTarget: boolean
  onSelectAsTarget: (piece: PieceInstance) => void
  targetFilter: "enemy" | "ally" | "all"
  currentPlayerId: string
}) {
  const isOwned = piece.ownerPlayerId === currentPlayerId
  const isEnemy = !isOwned
  const canBeTarget =
    isSelectingTarget &&
    (targetFilter === "all" || (targetFilter === "ally" && isOwned) || (targetFilter === "enemy" && isEnemy))

  return (
    <div
      onClick={canBeTarget ? () => onSelectAsTarget(piece) : undefined}
      className={[
        "rounded-lg border p-3 text-sm transition-all",
        piece.ownerPlayerId === RED_ID
          ? "border-red-800/50 bg-red-950/30"
          : "border-blue-800/50 bg-blue-950/30",
        canBeTarget && "cursor-pointer ring-2 ring-yellow-400 hover:bg-yellow-900/20",
        isCurrentPlayer && "ring-1 ring-white/20",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${piece.ownerPlayerId === RED_ID ? "bg-red-500" : "bg-blue-500"}`}
          />
          <span className="truncate font-semibold text-white">{piece.name}</span>
          {canBeTarget && (
            <span className="shrink-0 rounded bg-yellow-400 px-1 text-[10px] font-bold text-black">选择</span>
          )}
        </div>
        <span className="shrink-0 text-xs text-zinc-400">
          {piece.currentHp}/{piece.maxHp}
        </span>
      </div>

      {/* HP 条 */}
      <div className="mt-1.5">
        <HpBar current={piece.currentHp} max={piece.maxHp} />
      </div>

      {/* 属性 */}
      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-400">
        <span className="flex items-center gap-0.5">
          <Swords className="h-3 w-3" /> {piece.attack}
        </span>
        <span className="flex items-center gap-0.5">
          <Shield className="h-3 w-3" /> {piece.defense}
        </span>
        <span className="flex items-center gap-0.5">
          <ChevronRight className="h-3 w-3" /> {piece.moveRange}格
        </span>
        <span className="text-zinc-500">
          ({piece.x ?? "?"},{piece.y ?? "?"})
        </span>
      </div>

      {/* 状态效果 */}
      {piece.statusTags?.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {piece.statusTags.map((t, i) => (
            <StatusBadge key={i} tag={t} />
          ))}
        </div>
      )}

      {/* 规则 */}
      {piece.rules?.length > 0 && (
        <div className="mt-1 text-[10px] text-zinc-600">
          规则: {piece.rules.map((r: any) => r.id || r.name).join(", ")}
        </div>
      )}

      {/* 技能按钮（仅当前玩家且行动阶段） */}
      {isCurrentPlayer && isActionPhase && !isSelectingTarget && (
        <div className="mt-2 flex flex-wrap gap-1">
          {piece.skills?.map((s) => {
            const def = skillsById[s.skillId]
            const onCooldown = (s.currentCooldown ?? 0) > 0
            const noUses = s.usesRemaining !== undefined && s.usesRemaining !== -1 && s.usesRemaining <= 0
            const disabled = onCooldown || noUses
            return (
              <button
                key={s.skillId}
                disabled={disabled}
                onClick={() => onSkill(piece.instanceId, s.skillId)}
                title={def ? `${def.name} | AP:${def.actionPointCost} | CD:${def.cooldownTurns}` : s.skillId}
                className={[
                  "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                  disabled
                    ? "cursor-not-allowed bg-zinc-800 text-zinc-600"
                    : "bg-zinc-700 text-zinc-200 hover:bg-zinc-600",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {def?.name ?? s.skillId}
                {onCooldown && <span className="ml-1 text-zinc-500">(CD:{s.currentCooldown})</span>}
                {noUses && <span className="ml-1 text-red-500">(已用)</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function LogEntry({ log }: { log: ActionLog }) {
  const colorMap: Record<string, string> = {
    move: "text-cyan-400",
    useBasicSkill: "text-yellow-400",
    useChargeSkill: "text-purple-400",
    triggerEffect: "text-emerald-400",
    endTurn: "text-zinc-500",
    beginPhase: "text-zinc-500",
    surrender: "text-red-500",
  }
  const color = colorMap[log.type] ?? "text-zinc-300"
  return (
    <div className="flex gap-2 py-0.5 text-xs">
      <span className="shrink-0 text-zinc-600">[T{log.turn}]</span>
      <span className={`${color} break-words`}>{log.payload?.message ?? log.type}</span>
    </div>
  )
}

// ─── 主页面 ──────────────────────────────────────────────────────────────────

export default function TurnDebugPage() {
  const [availablePieces, setAvailablePieces] = useState<PieceTemplate[]>([])
  const [redSelected, setRedSelected] = useState<string[]>([])
  const [blueSelected, setBlueSelected] = useState<string[]>([])
  const [battle, setBattle] = useState<BattleState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [targetReq, setTargetReq] = useState<TargetRequest | null>(null)
  const [showJson, setShowJson] = useState(false)
  const [showGraveyard, setShowGraveyard] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  // 加载可用棋子
  useEffect(() => {
    apiGet().then(({ availablePieces, battleState }) => {
      setAvailablePieces(availablePieces)
      if (battleState) setBattle(battleState)
    })
  }, [])

  // 日志自动滚底
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [battle?.actions])

  // ── 工具 ──────────────────────────────────────────────────────────────────

  const togglePiece = (id: string, side: "red" | "blue") => {
    if (side === "red") {
      setRedSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
    } else {
      setBlueSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
    }
  }

  const act = useCallback(async (action: any) => {
    setLoading(true)
    setError(null)
    const res = await apiPost(action)
    setLoading(false)
    if (res.battleState) {
      setBattle(res.battleState)
      setTargetReq(null)
    } else if (res.needsTargetSelection) {
      setTargetReq({
        targetType: res.targetType as any,
        range: res.range ?? 5,
        filter: res.filter as any,
        pendingAction: action,
      })
    } else if (res.error) {
      setError(res.error)
    }
  }, [])

  const initBattle = async () => {
    if (redSelected.length === 0 || blueSelected.length === 0) {
      setError("双方各需至少选择一个棋子")
      return
    }
    setLoading(true)
    setError(null)
    const res = await apiPost({ type: "init", redPieceIds: redSelected, bluePieceIds: blueSelected })
    setLoading(false)
    if (res.battleState) {
      setBattle(res.battleState)
      setTargetReq(null)
    } else if (res.error) {
      setError(res.error)
    }
  }

  const handleSkill = (pieceId: string, skillId: string, skillType: "useBasicSkill" | "useChargeSkill" = "useBasicSkill") => {
    if (!battle) return
    act({ type: skillType, playerId: battle.turn.currentPlayerId, pieceId, skillId })
  }

  const handleSelectTarget = (target: PieceInstance) => {
    if (!targetReq || !battle) return
    act({ ...targetReq.pendingAction, targetPieceId: target.instanceId })
  }

  const cancelTarget = () => setTargetReq(null)

  // ── 派生状态 ──────────────────────────────────────────────────────────────

  const currentPlayer = battle?.players.find((p) => p.playerId === battle.turn.currentPlayerId)
  const isActionPhase = battle?.turn.phase === "action"
  const phaseLabel =
    battle?.turn.phase === "start" ? "开始阶段" : battle?.turn.phase === "action" ? "行动阶段" : "结束阶段"

  const redPieces = battle?.pieces.filter((p) => p.ownerPlayerId === RED_ID) ?? []
  const bluePieces = battle?.pieces.filter((p) => p.ownerPlayerId === BLUE_ID) ?? []
  const redMeta = battle?.players.find((p) => p.playerId === RED_ID)
  const blueMeta = battle?.players.find((p) => p.playerId === BLUE_ID)

  const redAvail = availablePieces.filter((p) => p.faction === "red" || p.faction === "neutral")
  const blueAvail = availablePieces.filter((p) => p.faction === "blue" || p.faction === "neutral")

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* 顶栏 */}
      <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-sm text-zinc-500 transition-colors hover:text-zinc-200"
        >
          <ArrowLeft className="h-4 w-4" />
          主菜单
        </Link>
        <div className="flex-1">
          <span className="font-bold text-white">战斗调试台</span>
          <span className="ml-2 text-xs text-zinc-500">使用真实进程代码 · 本地 API</span>
        </div>
        {battle && (
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span>第 {battle.turn.turnNumber} 回合</span>
            <span
              className={`rounded px-2 py-0.5 font-medium ${
                battle.turn.phase === "action"
                  ? "bg-emerald-900 text-emerald-300"
                  : battle.turn.phase === "start"
                    ? "bg-blue-900 text-blue-300"
                    : "bg-orange-900 text-orange-300"
              }`}
            >
              {phaseLabel}
            </span>
          </div>
        )}
        <button
          onClick={initBattle}
          disabled={loading}
          className="flex items-center gap-1.5 rounded bg-zinc-700 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-zinc-600 disabled:opacity-50"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          重置战局
        </button>
      </header>

      <div className="mx-auto flex max-w-7xl flex-col gap-0 lg:flex-row">
        {/* ── 左侧：棋子选择 + 状态 ──────────────────────────────────────────── */}
        <aside className="w-full shrink-0 border-b border-zinc-800 p-4 lg:w-72 lg:border-b-0 lg:border-r">
          {/* 棋子选择器 */}
          <div className="space-y-4">
            {/* 红方 */}
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-red-500" />
                <span className="text-sm font-semibold text-red-400">红方</span>
                {redMeta && (
                  <span className="ml-auto text-xs text-zinc-400">
                    AP {redMeta.actionPoints}/{redMeta.maxActionPoints} · {redMeta.chargePoints}充
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {redAvail.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => !battle && togglePiece(p.id, "red")}
                    className={[
                      "rounded border px-2 py-1 text-xs transition-all",
                      redSelected.includes(p.id)
                        ? "border-red-500 bg-red-900/40 text-red-300"
                        : "border-zinc-700 text-zinc-400 hover:border-red-700 hover:text-zinc-200",
                      battle && "cursor-default opacity-60",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>

            {/* 蓝方 */}
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-blue-500" />
                <span className="text-sm font-semibold text-blue-400">蓝方</span>
                {blueMeta && (
                  <span className="ml-auto text-xs text-zinc-400">
                    AP {blueMeta.actionPoints}/{blueMeta.maxActionPoints} · {blueMeta.chargePoints}充
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {blueAvail.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => !battle && togglePiece(p.id, "blue")}
                    className={[
                      "rounded border px-2 py-1 text-xs transition-all",
                      blueSelected.includes(p.id)
                        ? "border-blue-500 bg-blue-900/40 text-blue-300"
                        : "border-zinc-700 text-zinc-400 hover:border-blue-700 hover:text-zinc-200",
                      battle && "cursor-default opacity-60",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>

            {/* 开始按钮 */}
            {!battle && (
              <button
                onClick={initBattle}
                disabled={loading || redSelected.length === 0 || blueSelected.length === 0}
                className="w-full rounded bg-emerald-700 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-40"
              >
                <Play className="mr-1.5 inline h-4 w-4" />
                初始化战局
              </button>
            )}
          </div>

          {/* 分割线 */}
          {battle && <div className="my-4 border-t border-zinc-800" />}

          {/* 回合控制 */}
          {battle && (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">回合控制</div>
              <div className="flex flex-col gap-1.5">
                <button
                  onClick={() => act({ type: "beginPhase" })}
                  disabled={loading || battle.turn.phase === "action"}
                  className="flex items-center justify-center gap-1.5 rounded bg-zinc-800 py-1.5 text-sm transition-colors hover:bg-zinc-700 disabled:opacity-40"
                >
                  <ChevronRight className="h-4 w-4" />
                  {battle.turn.phase === "start" ? "进入行动阶段" : "进入下一回合"}
                </button>
                <button
                  onClick={() => act({ type: "endTurn", playerId: battle.turn.currentPlayerId })}
                  disabled={loading || !isActionPhase}
                  className="flex items-center justify-center gap-1.5 rounded bg-zinc-800 py-1.5 text-sm transition-colors hover:bg-zinc-700 disabled:opacity-40"
                >
                  <SkipForward className="h-4 w-4" />
                  结束回合（进入结束阶段）
                </button>
                <button
                  onClick={() =>
                    act({
                      type: "grantChargePoints",
                      playerId: battle.turn.currentPlayerId,
                      amount: 1,
                    })
                  }
                  disabled={loading}
                  className="flex items-center justify-center gap-1.5 rounded bg-zinc-800 py-1.5 text-sm transition-colors hover:bg-zinc-700 disabled:opacity-40"
                >
                  <Zap className="h-4 w-4 text-yellow-400" />
                  当前玩家 +1 充能点
                </button>
              </div>

              {/* 当前回合信息 */}
              <div className="mt-3 rounded bg-zinc-900 p-2.5 text-xs text-zinc-400">
                <div>
                  当前玩家：
                  <span className={battle.turn.currentPlayerId === RED_ID ? "text-red-400" : "text-blue-400"}>
                    {battle.turn.currentPlayerId === RED_ID ? "红方" : "蓝方"}
                  </span>
                </div>
                <div className="mt-0.5">
                  AP：{currentPlayer?.actionPoints ?? 0}/{currentPlayer?.maxActionPoints ?? 0} · 充能：{currentPlayer?.chargePoints ?? 0}
                </div>
              </div>
            </div>
          )}

          {/* 墓地 */}
          {battle && battle.graveyard.length > 0 && (
            <div className="mt-4">
              <button
                onClick={() => setShowGraveyard((v) => !v)}
                className="flex w-full items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
              >
                <span>墓地 ({battle.graveyard.length})</span>
                {showGraveyard ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
              {showGraveyard && (
                <div className="mt-1.5 space-y-1">
                  {battle.graveyard.map((p) => (
                    <div key={p.instanceId} className="text-xs text-zinc-600 line-through">
                      {p.name} ({p.ownerPlayerId === RED_ID ? "红" : "蓝"})
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </aside>

        {/* ── 中央：棋子状态 + 日志 ──────────────────────────────────────────── */}
        <div className="flex flex-1 flex-col gap-0 overflow-hidden">
          {/* 目标选择提示横幅 */}
          {targetReq && (
            <div className="flex items-center gap-3 border-b border-yellow-700 bg-yellow-950 px-4 py-2">
              <Target className="h-4 w-4 shrink-0 text-yellow-400" />
              <span className="flex-1 text-sm text-yellow-300">
                请选择目标（
                {targetReq.filter === "enemy" ? "敌方棋子" : targetReq.filter === "ally" ? "友方棋子" : "任意棋子"}，范围 {targetReq.range} 格）
              </span>
              <button onClick={cancelTarget} className="text-yellow-500 hover:text-yellow-300">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* 错误提示 */}
          {error && (
            <div className="flex items-center gap-2 border-b border-red-900 bg-red-950/50 px-4 py-2 text-sm text-red-400">
              <Info className="h-4 w-4 shrink-0" />
              {error}
              <button onClick={() => setError(null)} className="ml-auto text-red-600 hover:text-red-400">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* 加载中 */}
          {loading && (
            <div className="border-b border-zinc-800 bg-zinc-900/50 px-4 py-1.5 text-xs text-zinc-500">
              处理中…
            </div>
          )}

          {/* 战场：棋子卡片 */}
          {battle ? (
            <div className="flex flex-col gap-4 p-4 lg:flex-row">
              {/* 红方棋子 */}
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-red-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                  红方棋子
                </div>
                {redPieces.length === 0 ? (
                  <div className="text-xs text-zinc-600">（无存活棋子）</div>
                ) : (
                  redPieces.map((p) => (
                    <PieceCard
                      key={p.instanceId}
                      piece={p}
                      isCurrentPlayer={battle.turn.currentPlayerId === RED_ID}
                      isActionPhase={isActionPhase ?? false}
                      skillsById={battle.skillsById}
                      onSkill={(pieceId, skillId) => {
                        const skillDef = battle.skillsById[skillId]
                        const skillType = skillDef?.type === "super" ? "useChargeSkill" : "useBasicSkill"
                        handleSkill(pieceId, skillId, skillType)
                      }}
                      isSelectingTarget={!!targetReq}
                      onSelectAsTarget={handleSelectTarget}
                      targetFilter={targetReq?.filter ?? "all"}
                      currentPlayerId={battle.turn.currentPlayerId}
                    />
                  ))
                )}
              </div>

              {/* 分割 */}
              <div className="hidden border-l border-zinc-800 lg:block" />

              {/* 蓝方棋子 */}
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-blue-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                  蓝方棋子
                </div>
                {bluePieces.length === 0 ? (
                  <div className="text-xs text-zinc-600">（无存活棋子）</div>
                ) : (
                  bluePieces.map((p) => (
                    <PieceCard
                      key={p.instanceId}
                      piece={p}
                      isCurrentPlayer={battle.turn.currentPlayerId === BLUE_ID}
                      isActionPhase={isActionPhase ?? false}
                      skillsById={battle.skillsById}
                      onSkill={(pieceId, skillId) => {
                        const skillDef = battle.skillsById[skillId]
                        const skillType = skillDef?.type === "super" ? "useChargeSkill" : "useBasicSkill"
                        handleSkill(pieceId, skillId, skillType)
                      }}
                      isSelectingTarget={!!targetReq}
                      onSelectAsTarget={handleSelectTarget}
                      targetFilter={targetReq?.filter ?? "all"}
                      currentPlayerId={battle.turn.currentPlayerId}
                    />
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-zinc-600">
              <div className="text-center">
                <Swords className="mx-auto mb-3 h-12 w-12 opacity-30" />
                <div>选择棋子后点击「初始化战局」开始调试</div>
              </div>
            </div>
          )}
        </div>

        {/* ── 右侧：战斗日志 ─────────────────────────────────────────────────── */}
        <aside className="w-full shrink-0 border-t border-zinc-800 lg:w-72 lg:border-l lg:border-t-0">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">战斗日志</span>
            <span className="text-xs text-zinc-600">{battle?.actions?.length ?? 0} 条</span>
          </div>
          <div
            ref={logRef}
            className="h-64 overflow-y-auto px-3 py-2 lg:h-[calc(100vh-12rem)]"
          >
            {!battle?.actions || battle.actions.length === 0 ? (
              <div className="text-xs text-zinc-700">日志为空</div>
            ) : (
              battle.actions.map((log, i) => <LogEntry key={i} log={log} />)
            )}
          </div>

          {/* JSON 状态查看器 */}
          {battle && (
            <div className="border-t border-zinc-800">
              <button
                onClick={() => setShowJson((v) => !v)}
                className="flex w-full items-center gap-2 px-4 py-2 text-xs text-zinc-500 hover:text-zinc-300"
              >
                <span>原始状态 JSON</span>
                {showJson ? <ChevronUp className="ml-auto h-3 w-3" /> : <ChevronDown className="ml-auto h-3 w-3" />}
              </button>
              {showJson && (
                <pre className="max-h-96 overflow-auto bg-zinc-900 px-3 py-2 text-[10px] text-zinc-400">
                  {JSON.stringify(battle, null, 2)}
                </pre>
              )}
            </div>
          )}
        </aside>
      </div>
    </main>
  )
}
