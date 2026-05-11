// Replaces lib/game/skill-repository.ts in the mobile server bundle.

import { loadJsonFilesServer } from './file-loader-shim'
import type { SkillDefinition } from '../lib/game/skills'

export let DEFAULT_SKILLS: Record<string, SkillDefinition> = loadJsonFilesServer<SkillDefinition>('data/skills')

export async function loadSkills(): Promise<void> {}

export function getSkillById(id: string): SkillDefinition | undefined {
  return DEFAULT_SKILLS[id]
}

export function getAllSkills(): SkillDefinition[] {
  return Object.values(DEFAULT_SKILLS)
}
