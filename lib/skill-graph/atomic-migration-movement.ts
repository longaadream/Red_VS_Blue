import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'
import type { GameplayCallStatement, GameplayJsonValue, GameplayModuleGraph, GameplayValue } from './module-types'

/**
 * Legacy movement adapters remain loadable for historical resources, but new
 * graphs use the public generic movement primitives.  The policy and swap
 * descriptors already live in the movement-family registry; this recipe only
 * removes the two old single-move wrappers.
 */
export const ATOMIC_MOVEMENT_MODULES = new Set([
  'effect.teleport',
  'effect.displace',
])
export const ATOMIC_MOVEMENT_MODULE_IDS = ATOMIC_MOVEMENT_MODULES

const TELEPORT_KINDS = new Set(['teleport', 'dash', 'walk', 'push', 'pull', 'swap'])
const DISPLACE_KINDS = new Set(['dash', 'teleport'])
const TERRAIN_KINDS = new Set(['walkable', 'projectile', 'any'])

function input(call: GameplayCallStatement, name: string): GameplayValue | undefined {
  const value = call.inputs?.[name]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'literal') return Object.hasOwn(record, 'value') ? value : undefined
  if (record.kind === 'input') return typeof record.name === 'string' && record.name.length > 0 ? value : undefined
  return record.kind === 'output' && typeof record.node === 'string' && typeof record.port === 'string' ? value : undefined
}

function parameterString(call: GameplayCallStatement, name: string, fallback: string, allowed: ReadonlySet<string>): string | undefined {
  const value = call.parameters?.[name]
  const selected = value === undefined ? fallback : value
  return typeof selected === 'string' && allowed.has(selected) ? selected : undefined
}

function parameterBoolean(call: GameplayCallStatement, name: string, fallback: boolean): boolean | undefined {
  const value = call.parameters?.[name]
  const selected = value === undefined ? fallback : value
  return typeof selected === 'boolean' ? selected : undefined
}

function replaceTeleport(call: GameplayCallStatement): AtomicReplacement | undefined {
  const piece = input(call, 'piece')
  const destination = input(call, 'destination')
  const kind = parameterString(call, 'kind', 'teleport', TELEPORT_KINDS)
  if (!piece || !destination || !kind) return undefined

  // Both descriptors expose result/success.  Keep the original node id and
  // all references so downstream return/branch values stay byte-for-byte
  // addressable after the module id changes.
  return {
    statements: [{ ...call, module: 'effect.displace-one', version: '1', inputs: { piece, destination }, parameters: { kind } }],
  }
}

function replaceDisplace(call: GameplayCallStatement): AtomicReplacement | undefined {
  const piece = input(call, 'piece')
  const destination = input(call, 'destination')
  const kind = parameterString(call, 'kind', 'dash', DISPLACE_KINDS)
  if (!piece || !destination || !kind) return undefined

  // A teleport never consumes path policy in the legacy descriptor.  Route it
  // through the same public one-piece primitive as effect.teleport.  The dash
  // form needs the generic policy module because its path options affect
  // blockers and terrain.  Explicitly materialize the old defaults so the
  // migrated graph is stable and carries the empty blocked-terrain list.
  if (kind === 'teleport') {
    return {
      statements: [{ ...call, module: 'effect.displace-one', version: '1', inputs: { piece, destination }, parameters: { kind } }],
    }
  }

  const passAllies = parameterBoolean(call, 'passAllies', true)
  const passEnemies = parameterBoolean(call, 'passEnemies', true)
  const terrain = parameterString(call, 'terrain', 'any', TERRAIN_KINDS)
  if (passAllies === undefined || passEnemies === undefined || !terrain) return undefined
  const parameters: Readonly<Record<string, GameplayJsonValue>> = {
    kind,
    passAllies,
    passEnemies,
    terrain,
    blockedTerrainTypes: [],
  }
  return {
    statements: [{ ...call, module: 'effect.displace-policy', version: '1', inputs: { piece, destination }, parameters }],
  }
}

export const atomicMovementRecipe: AtomicRecipe = (call): AtomicReplacement | undefined => {
  if (call.module === 'effect.teleport') return replaceTeleport(call)
  if (call.module === 'effect.displace') return replaceDisplace(call)
  return undefined
}

export function migrateMovementModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicMovementRecipe)
}

export const migrateAtomicMovementGraph = migrateMovementModules
