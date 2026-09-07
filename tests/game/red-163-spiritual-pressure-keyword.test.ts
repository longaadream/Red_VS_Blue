import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

type SkillKeyword = {
  id: string
  name: string
  category: string
  shortDescription: string
  longDescription: string
  highlight: boolean
}

describe('RED-163 Spiritual Pressure keyword contract', () => {
  it('publishes the approved player-visible explanation', () => {
    const keywords = JSON.parse(
      readFileSync(resolve(process.cwd(), 'data/skill-keywords.json'), 'utf8'),
    ) as SkillKeyword[]

    expect(keywords).toContainEqual({
      id: 'spiritual-pressure',
      name: '灵压',
      category: 'mechanic',
      shortDescription: '只能选择当前攻击力低于施法者的主要目标。',
      longDescription: '只能选择当前攻击力低于施法者的主要目标。',
      highlight: true,
    })
  })
})
