import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import { atomicPresenceRecipe } from '../../lib/skill-graph/atomic-migration-presence'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'

describe('surviving gameplay presence conditions', () => {
  it.each(['query.has-piece', 'query.has-piece-id', 'query.has-player', 'piece.alive'])('preserves %s for missing, null, alive and dead identities using ordinary collection expressions', module => {
    const isPlayer = module === 'query.has-player'
    const input = module === 'query.has-piece-id' ? 'id' : isPlayer ? 'playerId' : module === 'piece.alive' ? 'piece' : 'pieceId'
    const port = module === 'piece.alive' ? 'alive' : 'exists'
    for (const identity of [null, 'missing', 'alive', 'dead']) {
      const graph: GameplayModuleGraph = {
        version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'answer', type: 'boolean' }],
        body: [
          { kind: 'call', id: 'target', module: isPlayer ? 'ref.player' : 'ref.target', version: '1' },
          { kind: 'call', id: 'probe', module, version: '1', inputs: { [input]: module === 'query.has-piece-id' ? { kind: 'literal', value: identity } : { kind: 'output', node: 'target', port: isPlayer ? 'player' : 'piece' } } },
          { kind: 'return', id: 'done', values: { answer: { kind: 'output', node: 'probe', port } } },
        ],
      }
      const migrated = rewriteAtomicGraph(graph, atomicPresenceRecipe)
      const runtime = {
        refs: { player: () => identity, target: () => identity },
        query: {
          hasPiece: (id: string) => ['alive', 'dead'].includes(id), hasPlayer: (id: string) => ['alive', 'dead'].includes(id),
          piece: (id: string) => ({ instanceId: id, currentHp: id === 'alive' ? 10 : 0 }),
          players: () => ['alive', 'dead'], pieces: (options: { includeDead: boolean }) => options.includeDead ? ['alive', 'dead'] : ['alive'],
        },
      }
      const execute = (value: GameplayModuleGraph) => runInNewContext('(' + compileGameplayModuleGraph(value, GAMEPLAY_MODULE_REGISTRY).code + ')', { flow: runtime })({})
      expect(execute(migrated)).toEqual(execute(graph))
      expect(rewriteAtomicGraph(migrated, atomicPresenceRecipe)).toEqual(migrated)
    }
  })
})
