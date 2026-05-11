// Shim for @/lib/resource-pack — no resource packs in mobile server context.
export function getResourcePackDataDir(): string | null { return null }
export function ensureResourcePackLoaded(): void {}
export function getResourcePackMetadata(): null { return null }
