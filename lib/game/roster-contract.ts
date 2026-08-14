import type { ContentAlignment } from './match-identity'
import {
  DEMO_PIECE_MANIFEST_VERSION,
  getDemoPieceIds,
  getPieceById,
  isDemoPieceAdmitted,
} from './piece-repository'
import type { Player, Room } from './room-store'

export const DEMO_ROSTER_SIZE = 8
export const DEMO_ROSTER_MANIFEST_VERSION = DEMO_PIECE_MANIFEST_VERSION

export type RosterContractErrorCode =
  | 'ROSTER_INVALID_PAYLOAD'
  | 'ROSTER_INVALID_COUNT'
  | 'ROSTER_DUPLICATE_TEMPLATE'
  | 'ROSTER_UNKNOWN_TEMPLATE'
  | 'ROSTER_TEMPLATE_NOT_ADMITTED'
  | 'ROSTER_ALIGNMENT_REQUIRED'
  | 'ROSTER_ALIGNMENT_MISMATCH'
  | 'ROSTER_PLAYER_NOT_FOUND'
  | 'ROSTER_LOCKED'
  | 'ROSTER_NOT_ALL_LOCKED'
  | 'ROSTER_WRITE_CONFLICT'

export interface RosterErrorContext extends Record<string, unknown> {
  manifestVersion: string
}

const ERROR_MESSAGES: Record<RosterContractErrorCode, string> = {
  ROSTER_INVALID_PAYLOAD: 'Roster pieces must be an array of templateId objects',
  ROSTER_INVALID_COUNT: `A Demo roster must contain exactly ${DEMO_ROSTER_SIZE} templates`,
  ROSTER_DUPLICATE_TEMPLATE: 'A Demo roster cannot contain duplicate templates',
  ROSTER_UNKNOWN_TEMPLATE: 'Roster contains an unknown template',
  ROSTER_TEMPLATE_NOT_ADMITTED: 'Roster contains a template that is not admitted to this Demo manifest',
  ROSTER_ALIGNMENT_REQUIRED: 'Player content alignment is required before locking a roster',
  ROSTER_ALIGNMENT_MISMATCH: 'Roster templates must belong to the player content alignment',
  ROSTER_PLAYER_NOT_FOUND: 'Player is not in the room',
  ROSTER_LOCKED: 'The player roster is already locked and cannot be changed',
  ROSTER_NOT_ALL_LOCKED: 'Both player rosters must be valid and locked before deployment',
  ROSTER_WRITE_CONFLICT: 'Roster could not be locked because the room changed concurrently',
}

export class RosterContractError extends Error {
  readonly code: RosterContractErrorCode
  readonly context: RosterErrorContext

  constructor(code: RosterContractErrorCode, context: Record<string, unknown> = {}) {
    super(ERROR_MESSAGES[code])
    this.name = 'RosterContractError'
    this.code = code
    this.context = { manifestVersion: DEMO_ROSTER_MANIFEST_VERSION, ...context }
  }
}

export interface RosterErrorPayload {
  code: RosterContractErrorCode
  message: string
  context: RosterErrorContext
}

export function getRosterErrorPayload(error: unknown): RosterErrorPayload | undefined {
  if (!(error instanceof RosterContractError)) return undefined
  return { code: error.code, message: error.message, context: error.context }
}

export interface RosterSelectionInput {
  alignment: ContentAlignment | undefined
  pieces: unknown
}

export interface LockedRosterPiece {
  templateId: string
  faction: string
}

function readTemplateIds(pieces: unknown): string[] {
  if (!Array.isArray(pieces)) {
    throw new RosterContractError('ROSTER_INVALID_PAYLOAD', { receivedType: typeof pieces })
  }

  return pieces.map((piece, index) => {
    if (!piece || typeof piece !== 'object' || typeof (piece as { templateId?: unknown }).templateId !== 'string') {
      throw new RosterContractError('ROSTER_INVALID_PAYLOAD', { index })
    }
    const templateId = (piece as { templateId: string }).templateId.trim()
    if (!templateId) throw new RosterContractError('ROSTER_INVALID_PAYLOAD', { index })
    return templateId
  })
}

export function validateDemoRosterSelection(input: RosterSelectionInput): LockedRosterPiece[] {
  if (!input.alignment) throw new RosterContractError('ROSTER_ALIGNMENT_REQUIRED')

  const templateIds = readTemplateIds(input.pieces)
  if (templateIds.length !== DEMO_ROSTER_SIZE) {
    throw new RosterContractError('ROSTER_INVALID_COUNT', {
      expectedCount: DEMO_ROSTER_SIZE,
      actualCount: templateIds.length,
    })
  }

  const seen = new Set<string>()
  const duplicateTemplateIds = [...new Set(templateIds.filter(templateId => {
    if (seen.has(templateId)) return true
    seen.add(templateId)
    return false
  }))]
  if (duplicateTemplateIds.length > 0) {
    throw new RosterContractError('ROSTER_DUPLICATE_TEMPLATE', { duplicateTemplateIds })
  }

  const unknownTemplateIds = templateIds.filter(templateId => !getPieceById(templateId))
  if (unknownTemplateIds.length > 0) {
    throw new RosterContractError('ROSTER_UNKNOWN_TEMPLATE', { templateIds: unknownTemplateIds })
  }

  const notAdmittedTemplateIds = templateIds.filter(templateId => !isDemoPieceAdmitted(templateId))
  if (notAdmittedTemplateIds.length > 0) {
    throw new RosterContractError('ROSTER_TEMPLATE_NOT_ADMITTED', { templateIds: notAdmittedTemplateIds })
  }

  const requiredFaction = input.alignment === 'light' ? 'good' : 'evil'
  const mismatchedTemplateIds = templateIds.filter(templateId => getPieceById(templateId)?.faction !== requiredFaction)
  if (mismatchedTemplateIds.length > 0) {
    throw new RosterContractError('ROSTER_ALIGNMENT_MISMATCH', {
      alignment: input.alignment,
      requiredFaction,
      templateIds: mismatchedTemplateIds,
    })
  }

  return templateIds.map(templateId => ({
    templateId,
    faction: getPieceById(templateId)!.faction,
  }))
}

function rosterTemplateIds(player: Player): string[] {
  return (player.selectedPieces ?? []).map(piece => piece.templateId)
}

function sameRoster(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return rightSet.size === right.length && left.every(templateId => rightSet.has(templateId))
}

export function ensureRosterAlignmentMutable(player: Player, requestedAlignment: ContentAlignment | undefined): void {
  if (
    requestedAlignment &&
    player.rosterLocked === true &&
    player.alignment !== requestedAlignment
  ) {
    throw new RosterContractError('ROSTER_LOCKED', { playerId: player.id })
  }
}

export interface LockDemoRosterRequest {
  playerId: string
  alignment?: ContentAlignment
  pieces: unknown
}

export interface LockDemoRosterResult {
  room: Room
  duplicate: boolean
  playerId: string
  selectedPiecesCount: number
  manifestVersion: string
}

export function lockDemoRosterInRoom(room: Room, request: LockDemoRosterRequest): LockDemoRosterResult {
  const playerId = request.playerId.trim().toLowerCase()
  const playerIndex = room.players.findIndex(player => player.id.toLowerCase() === playerId)
  if (playerIndex < 0) throw new RosterContractError('ROSTER_PLAYER_NOT_FOUND', { playerId })

  const player = room.players[playerIndex]
  ensureRosterAlignmentMutable(player, request.alignment)
  const alignment = request.alignment ?? player.alignment
  const requestedTemplateIds = readTemplateIds(request.pieces)

  if (player.rosterLocked === true) {
    const sameVersion = player.rosterManifestVersion === DEMO_ROSTER_MANIFEST_VERSION
    const sameAlignment = player.alignment === alignment
    if (sameVersion && sameAlignment && sameRoster(rosterTemplateIds(player), requestedTemplateIds)) {
      return {
        room,
        duplicate: true,
        playerId: player.id,
        selectedPiecesCount: player.selectedPieces?.length ?? 0,
        manifestVersion: DEMO_ROSTER_MANIFEST_VERSION,
      }
    }
    throw new RosterContractError('ROSTER_LOCKED', { playerId: player.id })
  }

  const selectedPieces = validateDemoRosterSelection({ alignment, pieces: request.pieces })
  const lockedPlayer: Player = {
    ...player,
    alignment,
    selectedPieces,
    hasSelectedPieces: true,
    rosterLocked: true,
    rosterManifestVersion: DEMO_ROSTER_MANIFEST_VERSION,
  }
  const players = room.players.map((candidate, index) => index === playerIndex ? lockedPlayer : candidate)

  return {
    room: { ...room, players },
    duplicate: false,
    playerId: lockedPlayer.id,
    selectedPiecesCount: selectedPieces.length,
    manifestVersion: DEMO_ROSTER_MANIFEST_VERSION,
  }
}

export interface DemoRosterReadiness {
  ready: boolean
  lockedPlayerIds: string[]
  invalidPlayerIds: string[]
}

export function getDemoRosterReadiness(room: Room): DemoRosterReadiness {
  const players = room.players.slice(0, 2)
  const lockedPlayerIds: string[] = []
  const invalidPlayerIds: string[] = []

  for (const player of players) {
    if (player.rosterLocked !== true || player.rosterManifestVersion !== DEMO_ROSTER_MANIFEST_VERSION) continue
    try {
      validateDemoRosterSelection({ alignment: player.alignment, pieces: player.selectedPieces })
      lockedPlayerIds.push(player.id)
    } catch {
      invalidPlayerIds.push(player.id)
    }
  }

  return {
    ready: players.length === 2 && lockedPlayerIds.length === 2 && invalidPlayerIds.length === 0,
    lockedPlayerIds,
    invalidPlayerIds,
  }
}

export function assertDemoRostersReady(room: Room): void {
  const readiness = getDemoRosterReadiness(room)
  if (!readiness.ready) {
    throw new RosterContractError('ROSTER_NOT_ALL_LOCKED', {
      playerIds: room.players.slice(0, 2).map(player => player.id),
      lockedPlayerIds: readiness.lockedPlayerIds,
      invalidPlayerIds: readiness.invalidPlayerIds,
    })
  }
}

export interface RosterRoomStore {
  getRoom(roomId: string): Promise<Room | undefined>
  setRoom(roomId: string, room: Room): Promise<void>
  setRoomIfVersion(roomId: string, room: Room, expectedVersion: number): Promise<boolean>
}

export async function lockDemoRosterInStore(
  store: RosterRoomStore,
  roomId: string,
  request: LockDemoRosterRequest,
): Promise<LockDemoRosterResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const room = await store.getRoom(roomId)
    if (!room) throw new RosterContractError('ROSTER_PLAYER_NOT_FOUND', { playerId: request.playerId })

    const result = lockDemoRosterInRoom(room, request)
    if (result.duplicate) return result

    if (typeof room.version === 'number') {
      if (!await store.setRoomIfVersion(roomId, result.room, room.version)) continue
    } else {
      await store.setRoom(roomId, result.room)
    }

    const savedRoom = await store.getRoom(roomId)
    return { ...result, room: savedRoom ?? result.room }
  }

  throw new RosterContractError('ROSTER_WRITE_CONFLICT', { roomId, playerId: request.playerId })
}

export function getDefaultDemoRosterSelection(alignment: ContentAlignment): LockedRosterPiece[] {
  const faction = alignment === 'light' ? 'good' : 'evil'
  const pieces = getDemoPieceIds()
    .map(templateId => getPieceById(templateId))
    .filter(piece => piece?.faction === faction)
    .slice(0, DEMO_ROSTER_SIZE)
    .map(piece => ({ templateId: piece!.id, faction: piece!.faction }))

  return validateDemoRosterSelection({ alignment, pieces })
}

export async function lockDefaultBotRosterInStore(
  store: RosterRoomStore,
  roomId: string,
): Promise<Room | undefined> {
  const room = await store.getRoom(roomId)
  const bot = room?.players.find(player => player.isBot === true || player.id === 'bot')
  if (!room || !bot || bot.rosterLocked === true) return room
  if (!bot.alignment) throw new RosterContractError('ROSTER_ALIGNMENT_REQUIRED', { playerId: bot.id })

  return (await lockDemoRosterInStore(store, roomId, {
    playerId: bot.id,
    alignment: bot.alignment,
    pieces: getDefaultDemoRosterSelection(bot.alignment),
  })).room
}
