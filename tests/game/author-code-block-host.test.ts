import { describe, expect, it } from 'vitest'

import { createSkillCodeFlow } from '@/lib/game/skills'
import {
  AUTHOR_CODE_BLOCK_VERSION,
  type AuthorCodeBlock,
} from '@/lib/skill-graph/author-code-block'
import { GAMEPLAY_MODULE_GRAPH_VERSION } from '@/lib/skill-graph/module-types'
import { makePiece, makeState } from '../helpers/minimal-state'

function ownerBlock(): AuthorCodeBlock {
  return {
    version: AUTHOR_CODE_BLOCK_VERSION,
    id: 'armor.host-runtime-test',
    signature: {
      inputs: [{ name: 'target', type: 'piece' }],
      outputs: [{ name: 'owner', type: 'player' }],
    },
    graph: {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'pending',
      schemas: [{
        id: 'armor-host-arguments',
        version: '1',
        fields: [{ name: 'target', type: 'piece' }],
      }],
      hostBindings: {
        payload: { kind: 'record', schema: 'armor-host-arguments@1' },
      },
      outputs: [{ name: 'owner', type: 'player' }],
      body: [
        {
          kind: 'record.get',
          id: 'target-value',
          record: { kind: 'input', name: 'payload' },
          field: 'target',
        },
        {
          kind: 'call',
          id: 'owner-value',
          module: 'piece.owner',
          version: '1',
          inputs: { piece: { kind: 'output', node: 'target-value', port: 'value' } },
        },
        {
          kind: 'return',
          id: 'return-owner',
          values: { owner: { kind: 'output', node: 'owner-value', port: 'player' } },
        },
      ],
    },
  }
}

describe('author code block host facade', () => {
  it('executes a validated block through createSkillCodeFlow', () => {
    const battle = makeState({ pieces: [makePiece({ instanceId: 'self' })] })
    const flow = createSkillCodeFlow(battle, { piece: battle.pieces[0] }, 'skill')

    expect(flow.codeBlocks.invoke(ownerBlock(), { target: 'self' }, { type: 'record', schemas: [] })).toEqual({
      owner: 'player-red',
    })
  })

  it('rejects a requested scalar result before returning a false value', () => {
    const battle = makeState({ pieces: [makePiece({ instanceId: 'self' })] })
    const flow = createSkillCodeFlow(battle, { piece: battle.pieces[0] }, 'skill')

    expect(() => flow.codeBlocks.invoke(ownerBlock(), { target: 'self' }, { type: 'number', schemas: [] })).toThrow(/result type|incompatible/i)
  })
})
