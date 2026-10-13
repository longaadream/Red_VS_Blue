import { vi } from 'vitest'

import * as originalModuleDocument from '../../lib/skill-graph/module-document'
import { migrateAtomicAuthorGraph } from '../../scripts/migrate-atomic-author-modules'
import type { GameplayModuleGraph } from '../../lib/skill-graph/module-types'

const originalApplyGameplayModuleGraph = originalModuleDocument.applyGameplayModuleGraph

/**
 * Run the frozen gameplay-module suites against the canonical graph emitted by
 * the production atomic migrator.  The original module is loaded before the
 * mock is installed so the migrator itself keeps its original document API.
 */
vi.doMock('../../lib/skill-graph/module-document', () => ({
  ...originalModuleDocument,
  applyGameplayModuleGraph: (
    input: Parameters<typeof originalApplyGameplayModuleGraph>[0],
    graph: Parameters<typeof originalApplyGameplayModuleGraph>[1],
    field?: Parameters<typeof originalApplyGameplayModuleGraph>[2],
  ) => originalApplyGameplayModuleGraph(
    input,
    migrateAtomicAuthorGraph(graph as GameplayModuleGraph),
    field,
  ),
}))
