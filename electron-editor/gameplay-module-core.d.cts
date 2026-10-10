/** Types for the generated shared-module bundle; implementation lives in lib/skill-graph. */
export const GAMEPLAY_MODULE_COMPILER_VERSION: string
export const GAMEPLAY_MODULE_DOCUMENT_VERSION: string
export const GAMEPLAY_MODULE_REGISTRY: Readonly<Record<string, unknown>>
export function compileGameplayModuleGraph(graph: unknown, registry?: unknown): { code: string; surface: string; dependencies: unknown[] }
export function applyGameplayModuleGraph(content: Record<string, unknown>, graph: unknown, field?: string): Record<string, unknown>
export function applyGameplayModuleTextBindings(content: Record<string, unknown>, bindings: unknown): Record<string, unknown>
export function assertGameplayModuleDocument(content: unknown): void
export function assertGameplayModuleTransition(previous: unknown, next: unknown): void
export function getGameplayModuleGraph(content: unknown, field: string): unknown
export function getGameplayModuleCatalog(): unknown
export const SKILL_CLUSTER_DEFINITION_VERSION: string
export const SKILL_CLUSTER_VERSION: string
export function buildSkillCluster(catalog: unknown, root: unknown, options?: unknown): unknown
export function buildSkillClusterCatalog(catalog: unknown, options?: unknown): unknown
export function validateSkillClusterDefinition(value: unknown): readonly unknown[]
export function cloneSkillClusterDefinition(value: unknown): unknown
export function assertSkillClusterMetadata(value: unknown): void
