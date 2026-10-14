import { describe, expect, it } from 'vitest'

import { AUTHOR_CONTAINER_MODULES } from '../../lib/skill-graph/module-registry-author-containers'
import type { GameplayNativeLoweringContext } from '../../lib/skill-graph/module-types'

describe('author container module registry', () => {
  it('compares generic type parameters recursively without relying on JSON key order', () => {
    const descriptor = AUTHOR_CONTAINER_MODULES.find(module => module.id === 'map.create')
    expect(descriptor?.lower).toBeTypeOf('function')
    if (!descriptor?.lower) return

    const context: GameplayNativeLoweringContext = {
      surface: 'skill',
      callId: 'create-map',
      moduleId: descriptor.id,
      moduleVersion: descriptor.version,
      inputs: { keys: 'keys', values: 'values' },
      parameters: {
        containerType: JSON.stringify({ value: 'number', key: 'string', kind: 'map' }),
        keyType: 'string',
        valueType: 'number',
        keysType: JSON.stringify({ element: 'string', kind: 'list' }),
        valuesType: JSON.stringify({ element: 'number', kind: 'list' }),
      },
      outputPorts: descriptor.outputs,
      emitLiteral: value => JSON.stringify(value),
    }

    expect(descriptor.lower(context)).toContain('flow.containers.authorMapCreate')
  })
})
