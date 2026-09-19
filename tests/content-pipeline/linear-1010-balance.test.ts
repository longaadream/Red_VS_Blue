import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(process.cwd())
const readJson = (relative: string) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')) as Record<string, any>

describe('RED-211 documented balance changes', () => {
  it('keeps Ulquiorra ranges and damage wording aligned', () => {
    const cero = readJson('data/skills/ulquiorra-cero.json')
    const black = readJson('data/skills/ulquiorra-black-cero.json')
    expect(cero.targeting.steps[0].range).toBe(4)
    expect(cero.description).toContain('0.5倍伤害')
    expect(black.targeting.steps[0].range).toBe(2)
    expect(black.description).toContain('2倍伤害')
  })

  it('keeps the documented AP and roster changes', () => {
    const gaze = readJson('data/skills/blackwidow-deadly-gaze.json')
    const grimmjow = readJson('data/pieces/dark-grimmjow.json')
    expect(gaze.actionPointCost).toBe(1)
    expect(grimmjow.name).toBe('格里姆乔')
    expect(grimmjow.skills.map((skill: { skillId: string }) => skill.skillId)).not.toContain('grimmjow-gran-rey-cero')
  })
})
