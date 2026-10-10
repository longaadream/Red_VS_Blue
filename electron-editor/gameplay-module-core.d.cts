/** Types for the generated shared-module bundle; implementation lives in lib/skill-graph. */
export const GAMEPLAY_MODULE_COMPILER_VERSION: string
export const GAMEPLAY_MODULE_DOCUMENT_VERSION: string
export const GAMEPLAY_MODULE_REGISTRY: Readonly<Record<string, unknown>>
export function compileGameplayModuleGraph(graph: unknown, registry?: unknown): { code: string; surface: string; dependencies: unknown[] }
export function applyGameplayModuleGraph(content: Record<string, unknown>, graph: unknown, field?: string): Record<string, unknown>
export function assertGameplayModuleDocument(content: unknown): void
export function assertGameplayModuleTransition(previous: unknown, next: unknown): void
export function getGameplayModuleGraph(content: unknown, field: string): unknown
export function getGameplayModuleCatalog(): unknown
