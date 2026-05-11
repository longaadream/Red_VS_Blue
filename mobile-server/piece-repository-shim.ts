// Replaces lib/game/piece-repository.ts in the mobile server bundle.

import { loadJsonFilesServer } from './file-loader-shim'
import type { PieceTemplate } from '../lib/game/piece'

export let DEFAULT_PIECES: Record<string, PieceTemplate> = loadJsonFilesServer<PieceTemplate>('data/pieces')

export async function loadPieces(): Promise<void> {}

export function getPieceById(id: string): PieceTemplate | undefined {
  return DEFAULT_PIECES[id]
}

export function getAllPieces(): PieceTemplate[] {
  return Object.values(DEFAULT_PIECES)
}

export function getPiecesByFaction(faction: string): PieceTemplate[] {
  return Object.values(DEFAULT_PIECES).filter(p => (p as { faction?: string }).faction === faction)
}
