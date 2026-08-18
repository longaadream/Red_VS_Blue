import { loadAllSkillsById } from './skills'

export interface ServerBattleState {
  type: 'server-state'
  seed: number
  state: unknown
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getBattleStorage(room: any): ServerBattleState | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bs = room?.battleState as any
  if (!bs) return null
  if (bs.type === 'server-state') return bs as ServerBattleState
  if (bs.type === 'action-log' && Array.isArray(bs.actions)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const init = bs.actions.find((a: any) => a.type === 'init')
    if (init?.payload) return { type: 'server-state', seed: bs.seed ?? 0, state: init.payload }
    return null
  }
  // Bare BattleState (has pieces/turn at top level, no `type` wrapper)
  if (Array.isArray(bs.pieces) && bs.turn) {
    return { type: 'server-state', seed: 0, state: bs }
  }
  return null
}

export function withServerSkills(state: unknown): unknown {
  if (!state || typeof state !== 'object') return state
  const currentState = state as Record<string, unknown>
  const embeddedSkills = currentState.skillsById && typeof currentState.skillsById === 'object'
    ? currentState.skillsById as Record<string, unknown>
    : {}
  return {
    ...currentState,
    skillsById: {
      ...loadAllSkillsById(),
      ...embeddedSkills,
    },
  }
}

export function withoutServerSkills(state: unknown): unknown {
  if (!state || typeof state !== 'object') return state
  const rest = { ...(state as Record<string, unknown>) }
  delete rest.skillsById
  return rest
}
