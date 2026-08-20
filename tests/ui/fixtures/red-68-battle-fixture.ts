export type Red68FixturePiece = {
  instanceId: string
  ownerPlayerId: 'red-player' | 'blue-player'
  faction: 'red' | 'blue'
  x: number
  y: number
  currentHp: number
  maxHp: number
  statusTags: Array<{ id: string; name: string; visible: true }>
}

const statusCatalog = [
  { id: 'burn', name: '灼烧', visible: true as const },
  { id: 'slow', name: '迟缓', visible: true as const },
  { id: 'silence', name: '沉默', visible: true as const },
]

export function createRed68BattleFixture() {
  const pieces: Red68FixturePiece[] = Array.from({ length: 16 }, (_, index) => {
    const isRed = index < 8
    const sideIndex = index % 8
    const statusCount = sideIndex % 4
    return {
      instanceId: `red-68-${isRed ? 'red' : 'blue'}-${sideIndex + 1}`,
      ownerPlayerId: isRed ? 'red-player' : 'blue-player',
      faction: isRed ? 'red' : 'blue',
      x: 6 + (sideIndex % 4) + (isRed ? 0 : 4),
      y: 7 + Math.floor(sideIndex / 4),
      currentHp: 5 + (sideIndex % 4),
      maxHp: 8,
      statusTags: statusCatalog.slice(0, statusCount),
    }
  })

  return {
    fixtureId: 'red-68-20x16-dense-table-v1',
    seed: 'red-68-fixed-seed-2026-08-20',
    map: {
      id: 'red-68-20x16',
      width: 20,
      height: 16,
      tiles: Array.from({ length: 20 * 16 }, (_, index) => ({
        id: `${index % 20},${Math.floor(index / 20)}`,
        x: index % 20,
        y: Math.floor(index / 20),
        props: { type: 'floor', walkable: true },
      })),
    },
    pieces,
    hands: {
      'red-player': Array.from({ length: 5 }, (_, index) => `red-card-${index + 1}`),
      'blue-player': Array.from({ length: 8 }, (_, index) => `blue-card-${index + 1}`),
    },
    targetingRevision: 7,
    turn: { currentPlayerId: 'red-player', turnNumber: 3, phase: 'action' },
  }
}
