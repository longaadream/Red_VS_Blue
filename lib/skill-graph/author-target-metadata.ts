import { getGameplayModule } from './module-registry'
import type { GameplayModuleGraph } from './module-types'

/** Only hoist the unconditional selection prefix. Later/conditional choices
 * keep their runtime continuation, so preparation never executes content. */
export function authorTargetMetadata(graph: GameplayModuleGraph | undefined) {
  if (!graph || graph.version !== 'rvb-gameplay-modules/v1' || !Array.isArray(graph.body)) return undefined
  const steps: Array<{
    kind: 'target'; type: 'piece' | 'cell'; filter: 'enemy' | 'ally' | 'all';
    range: number; minRange: number; requireWalkable?: boolean; requireUnoccupied?: boolean;
  }> = []
  for (const statement of graph.body) {
    if (statement.kind !== 'call') break
    const descriptor = getGameplayModule(statement.module, statement.version)
    if (!descriptor) break
    if (statement.module === 'author.choice.target-piece' || statement.module === 'author.choice.target-cell') {
      const cell = statement.module === 'author.choice.target-cell'
      const parameters = statement.parameters ?? {}
      const range = parameters.range ?? 5
      const filter = parameters.filter ?? (cell ? 'all' : 'enemy')
      if (typeof range !== 'number' || !Number.isFinite(range) || range < 0
        || (filter !== 'all' && filter !== 'enemy' && filter !== 'ally')) break
      steps.push({
        kind: 'target', type: cell ? 'cell' : 'piece', filter, range,
        minRange: range === 0 ? 0 : 1,
        ...(cell ? { requireWalkable: parameters.requireWalkable !== false, requireUnoccupied: parameters.requireUnoccupied !== false } : {}),
      })
      continue
    }
    if (!descriptor.effects.pure || descriptor.effects.pending) break
  }
  return steps
}
