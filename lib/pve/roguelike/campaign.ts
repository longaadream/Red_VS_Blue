import type { RoguelikeAdventureV1 } from '../contracts/roguelike-content-v1'
import { generateAdventureContent } from './generation'
import { deriveStreamSeed } from '../../game/rule-runtime'

/** Act layouts share the resource registry and party, but never another act's mutable map. */
export function campaignAct(source: RoguelikeAdventureV1, index: number, seed: number): RoguelikeAdventureV1 {
  const next = index === 0 ? source : source.nextActs?.[index - 1]
  if (!next) throw new Error('没有后续幕')
  const content = { ...source, roaming: undefined, ...next, nextActs: undefined }
  return generateAdventureContent(content, index === 0 ? seed : deriveStreamSeed(seed, `adventure-act-${index + 1}`))
}
