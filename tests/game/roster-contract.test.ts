import { describe, expect, it } from 'vitest'

import { DEFAULT_PIECES, getDemoPieceIds } from '../../lib/game/piece-repository'
import type { PieceTemplate } from '../../lib/game/piece'
import type { Room } from '../../lib/game/room-model'
import {
  DEMO_ROSTER_MANIFEST_VERSION,
  DEMO_ROSTER_SIZE,
  RosterContractError,
  getDemoRosterReadiness,
  lockDemoRosterInRoom,
  validateDemoRosterSelection,
} from '../../lib/game/roster-contract'

const lightRoster = [
  'ana',
  'anduin',
  'blue-kenshin',
  'blue-minato',
  'blue-naruto',
  'blue-tirion-fordring',
  'blue-watcher',
  'hashirama-edo',
]

const darkRoster = [
  'arthas',
  'guldan',
  'kiljaedan',
  'reaper',
  'red-blackwidow',
  'red-doomsday-fist',
  'red-hidan',
  'red-illidan',
]

function selection(templateIds: string[]) {
  return templateIds.map(templateId => ({ templateId, faction: 'untrusted-client-value' }))
}

function makeRoom(): Room {
  return {
    id: 'red-26-test',
    name: 'RED-26 test room',
    status: 'ready',
    players: [
      { id: 'alice', name: 'Alice', seat: 'red', faction: 'red', alignment: 'light' },
      { id: 'bob', name: 'Bob', seat: 'blue', faction: 'blue', alignment: 'dark' },
    ],
    spectators: [],
    currentTurnIndex: 0,
    actions: [],
    version: 3,
  }
}

function expectRosterError(run: () => unknown, code: string) {
  try {
    run()
    throw new Error(`Expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(RosterContractError)
    expect((error as RosterContractError).code).toBe(code)
    expect((error as RosterContractError).context.manifestVersion).toBe(DEMO_ROSTER_MANIFEST_VERSION)
  }
}

describe('Demo roster contract', () => {
  it('reads admitted candidates from the server manifest without enforcing faction-size symmetry', () => {
    const admittedIds = getDemoPieceIds()
    const admittedPieces = admittedIds.map(templateId => DEFAULT_PIECES[templateId])

    expect(new Set(admittedIds).size).toBe(admittedIds.length)
    expect(admittedIds).toEqual(expect.arrayContaining([
      'blue-ichigo',
      'red-itachi',
      'red-venom',
      'velen',
      'turalyon',
    ]))
    expect(admittedPieces.every(piece => piece && (piece.faction === 'good' || piece.faction === 'evil'))).toBe(true)
  })

  it.each([
    ['light', lightRoster, 'good'],
    ['dark', darkRoster, 'evil'],
  ] as const)('accepts exactly eight distinct admitted %s templates', (alignment, templateIds, faction) => {
    const result = validateDemoRosterSelection({ alignment, pieces: selection(templateIds) })

    expect(result).toHaveLength(DEMO_ROSTER_SIZE)
    expect(result.map(piece => piece.templateId)).toEqual(templateIds)
    expect(result.every(piece => piece.faction === faction)).toBe(true)
  })

  it.each([
    ['ROSTER_INVALID_COUNT', lightRoster.slice(0, 7)],
    ['ROSTER_INVALID_COUNT', [...lightRoster, 'jaina']],
    ['ROSTER_DUPLICATE_TEMPLATE', [...lightRoster.slice(0, 7), lightRoster[0]]],
    ['ROSTER_UNKNOWN_TEMPLATE', [...lightRoster.slice(0, 7), 'does-not-exist']],
    ['ROSTER_ALIGNMENT_MISMATCH', [...lightRoster.slice(0, 7), darkRoster[0]]],
  ])('rejects %s without accepting a partial roster', (code, templateIds) => {
    expectRosterError(
      () => validateDemoRosterSelection({ alignment: 'light', pieces: selection(templateIds) }),
      code,
    )
  })

  it('distinguishes a known but non-admitted template from an unknown template', () => {
    const templateId = 'future-light-piece'
    DEFAULT_PIECES[templateId] = {
      ...DEFAULT_PIECES[lightRoster[0]],
      id: templateId,
    } as PieceTemplate

    try {
      expectRosterError(
        () => validateDemoRosterSelection({
          alignment: 'light',
          pieces: selection([...lightRoster.slice(0, 7), templateId]),
        }),
        'ROSTER_TEMPLATE_NOT_ADMITTED',
      )
    } finally {
      delete DEFAULT_PIECES[templateId]
    }
  })

  it('does not mutate room state when validation fails', () => {
    const room = makeRoom()
    const before = structuredClone(room)

    expectRosterError(
      () => lockDemoRosterInRoom(room, {
        playerId: 'alice',
        pieces: selection(lightRoster.slice(0, 7)),
      }),
      'ROSTER_INVALID_COUNT',
    )
    expect(room).toEqual(before)
  })

  it('locks a ready player to the lobby alignment for forged roster requests', () => {
    const room = makeRoom()
    room.players[0].ready = true
    const before = structuredClone(room)

    expectRosterError(
      () => lockDemoRosterInRoom(room, {
        playerId: 'alice',
        alignment: 'dark',
        pieces: selection(darkRoster),
      }),
      'ROSTER_ALIGNMENT_LOCKED',
    )
    expect(room).toEqual(before)
  })

  it('uses the stored lobby alignment rather than a client selection alignment', () => {
    const room = makeRoom()
    room.players[0].ready = true

    const locked = lockDemoRosterInRoom(room, {
      playerId: 'alice',
      alignment: 'light',
      pieces: selection(lightRoster),
    })

    expect(locked.room.players[0]).toMatchObject({ alignment: 'light', rosterLocked: true })
    expect(locked.room.players[0].selectedPieces?.every(piece => piece.faction === 'good')).toBe(true)
  })

  it('treats the same locked roster as idempotent and rejects a later modification', () => {
    const first = lockDemoRosterInRoom(makeRoom(), {
      playerId: 'alice',
      pieces: selection(lightRoster),
    })
    const duplicate = lockDemoRosterInRoom(first.room, {
      playerId: 'alice',
      pieces: selection([...lightRoster].reverse()),
    })

    expect(first.duplicate).toBe(false)
    expect(duplicate.duplicate).toBe(true)
    expect(duplicate.room).toBe(first.room)
    expectRosterError(
      () => lockDemoRosterInRoom(first.room, {
        playerId: 'alice',
        pieces: selection([...lightRoster.slice(0, 7), 'jaina']),
      }),
      'ROSTER_LOCKED',
    )
  })

  it('does not allow deployment until both player rosters are valid and locked', () => {
    const oneLocked = lockDemoRosterInRoom(makeRoom(), {
      playerId: 'alice',
      pieces: selection(lightRoster),
    }).room

    expect(getDemoRosterReadiness(oneLocked)).toMatchObject({ ready: false, lockedPlayerIds: ['alice'] })

    const bothLocked = lockDemoRosterInRoom(oneLocked, {
      playerId: 'bob',
      pieces: selection(darkRoster),
    }).room
    expect(getDemoRosterReadiness(bothLocked)).toMatchObject({ ready: true, lockedPlayerIds: ['alice', 'bob'] })
  })

  it('allows same-alignment players to lock the same templates independently', () => {
    const room = makeRoom()
    room.players[1].alignment = 'light'

    const aliceLocked = lockDemoRosterInRoom(room, { playerId: 'alice', pieces: selection(lightRoster) }).room
    const bothLocked = lockDemoRosterInRoom(aliceLocked, { playerId: 'bob', pieces: selection(lightRoster) }).room

    expect(getDemoRosterReadiness(bothLocked).ready).toBe(true)
    expect(bothLocked.players[0].selectedPieces).toHaveLength(DEMO_ROSTER_SIZE)
    expect(bothLocked.players[1].selectedPieces).toHaveLength(DEMO_ROSTER_SIZE)
    expect(new Set(bothLocked.players[0].selectedPieces?.map(piece => piece.templateId)).size).toBe(DEMO_ROSTER_SIZE)
    expect(new Set(bothLocked.players[1].selectedPieces?.map(piece => piece.templateId)).size).toBe(DEMO_ROSTER_SIZE)
  })
})
