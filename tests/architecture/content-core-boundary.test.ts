import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const CORE_ROOTS = [
  join(ROOT, 'lib', 'game'),
  join(ROOT, 'electron'),
  join(ROOT, 'electron-client'),
] as const
const CONTENT_DIRS = ['pieces', 'skills', 'cards', 'rules', 'status-effects', 'tiles'] as const
const ALLOWED_CONTENT_IDS = new Set(['rule-lucky-coin-gamestart'])
const CONTENT_EXTENSION_KEYS = [
  'amaterasuCells',
  'amaterasuOwnerPlayerId',
  'kiljaedanPiece',
  'minatoAnchors',
  'recallData',
  'shishioBurnTiles',
  'stickyBombs',
  'turalyonLightforgedTurns',
] as const

function walkFiles(directory: string, extension: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .flatMap(entry => {
      const path = join(directory, entry)
      return statSync(path).isDirectory() ? walkFiles(path, extension) : [path]
    })
    .filter(path => path.endsWith(extension))
}

function loadContentIds(): string[] {
  const ids = new Set<string>()
  for (const directory of CONTENT_DIRS) {
    for (const path of walkFiles(join(ROOT, 'data', directory), '.json')) {
      if (path.endsWith('manifest.json')) continue
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { id?: unknown }
      if (typeof parsed.id === 'string' && !ALLOWED_CONTENT_IDS.has(parsed.id)) ids.add(parsed.id)
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right))
}

describe('RED-127 content/core architecture boundary', () => {
  it('keeps concrete content IDs, keywords, and extension keys out of gameplay core and Electron main', () => {
    const contentIds = loadContentIds()
    const violations: string[] = []

    for (const coreRoot of CORE_ROOTS) {
      for (const path of walkFiles(coreRoot, '.ts')) {
      const source = readFileSync(path, 'utf8')
      const displayPath = relative(ROOT, path).replaceAll('\\', '/')

      for (const id of contentIds) {
        const appearsAsLiteral = source.includes(`'${id}'`)
          || source.includes(`"${id}"`)
          || source.includes('`' + id + '`')
        if (appearsAsLiteral) violations.push(`${displayPath}: content id ${id}`)
      }

      if (/mangekyo/i.test(displayPath) || /mangekyo/i.test(source) || source.includes('万花筒')) {
        violations.push(`${displayPath}: dedicated Mangekyo coupling`)
      }
      for (const key of CONTENT_EXTENSION_KEYS) {
        if (source.includes(key)) violations.push(`${displayPath}: content extension key ${key}`)
      }
      }
    }

    expect(violations).toEqual([])
  })
})
