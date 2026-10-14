import type { AtomicRecipe, AtomicReplacement } from './atomic-graph-rewrite'

export const ATOMIC_SKILL_OWNER_MODULES = new Set(['skill.add-player', 'skill.remove-player'])

/** Player and piece owners share a typed skill operation, not a separate palette. */
export const atomicSkillOwnerRecipe: AtomicRecipe = (node, fresh): AtomicReplacement | undefined => {
  if (!ATOMIC_SKILL_OWNER_MODULES.has(node.module) || node.version !== '1') return undefined
  if (!node.inputs?.player || typeof node.parameters?.skillId !== 'string') return undefined
  const definition = fresh('skill-definition')
  return {
    statements: [
      { kind: 'call', id: definition, module: 'ref.skill-definition', version: '1', parameters: { skillId: node.parameters.skillId } },
      { ...node, module: node.module === 'skill.add-player' ? 'skill.add' : 'skill.remove', version: '2',
        inputs: { owner: node.inputs.player, skill: { kind: 'output', node: definition, port: 'skill' } }, parameters: { ownerType: 'player' } },
    ],
    outputs: { success: { kind: 'output', node: node.id, port: 'success' } },
  }
}
