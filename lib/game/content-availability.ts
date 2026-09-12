/** Shared content metadata. Missing metadata preserves pre-existing content access. */
export type ContentMode = 'pvp' | 'pve'
export interface ContentAvailability {
  modes: ContentMode[]
  status: 'ready' | 'draft'
}
export interface ModeScopedContent {
  availability?: ContentAvailability
}

export function isValidContentAvailability(value: unknown): value is ContentAvailability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return Object.keys(item).every(key => key === 'modes' || key === 'status')
    && (item.status === 'ready' || item.status === 'draft')
    && Array.isArray(item.modes) && item.modes.length > 0
    && item.modes.every(mode => mode === 'pvp' || mode === 'pve')
    && new Set(item.modes).size === item.modes.length
}

export function isContentAvailable(content: { availability?: unknown }, mode: ContentMode): boolean {
  if (content.availability === undefined) return true
  return isValidContentAvailability(content.availability)
    && content.availability.status === 'ready'
    && content.availability.modes.includes(mode)
}

export function battleContentMode(battle: { extensions?: Record<string, unknown> }): ContentMode {
  const world = battle.extensions?.adventureWorld as { version?: string } | undefined
  return world?.version === 'same-map-v1' || battle.extensions?.contentMode === 'pve' ? 'pve' : 'pvp'
}

export class ContentUnavailableError extends Error {
  readonly code = 'CONTENT_MODE_UNAVAILABLE'
  constructor(id: string, mode: ContentMode) {
    super(`内容 ${id} 未开放给 ${mode.toUpperCase()}（专用内容或草案）`)
    this.name = 'ContentUnavailableError'
  }
}

export function assertContentAvailable(content: { id?: string; availability?: unknown }, mode: ContentMode): void {
  if (!isContentAvailable(content, mode)) throw new ContentUnavailableError(content.id ?? '<unknown>', mode)
}
