import { schema, t, type SchemaType } from '@colyseus/schema'

export const BattleRoomState = schema({
  battleId: t.string(),
  roomStatus: t.string(),
  authorityVersion: t.number(),
  durableAuthorityVersion: t.number(),
  stateHash: t.string(),
  transitionHash: t.string(),
  phase: t.string(),
  turnNumber: t.number(),
  currentPlayerId: t.string(),
  terminalStatus: t.string(),
}, 'RvbBattleRoomState')

export type BattleRoomState = SchemaType<typeof BattleRoomState>
