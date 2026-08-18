import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

interface EncodingIssue {
  rel: string
  line: number
  message: string
}

interface EncodingChecker {
  findBufferIssues(bytes: Buffer, rel: string): EncodingIssue[]
}

const require = createRequire(import.meta.url)
const { findBufferIssues } = require('../../scripts/check-encoding.js') as EncodingChecker

function scan(text: string, rel = 'fixture.html'): EncodingIssue[] {
  return findBufferIssues(Buffer.from(text, 'utf8'), rel)
}

describe('encoding checker', () => {
  it('reports every concrete mojibake, private-use, and lost-text occurrence with its line', () => {
    const cjkMojibake = String.fromCodePoint(0x6d93, 0x5b2d, 0x6d47, 0x93b4, 0x6a3b, 0x59e4)
    const shorterCjkMojibake = String.fromCodePoint(0x934f, 0x5470, 0x5158)
    const privateUseMojibake = String.fromCodePoint(0x6dc7, 0xe1bd, 0x657c, 0x9363, 0x2559)
    const lostText = `const message = '${'?'.repeat(6)}'`

    const issues = scan([
      cjkMojibake,
      `${shorterCjkMojibake} ${shorterCjkMojibake}`,
      privateUseMojibake,
      lostText,
    ].join('\n'))

    expect(issues.map(issue => issue.line)).toEqual([1, 2, 2, 3, 4])
    expect(issues.every(issue => issue.message.startsWith('possible mojibake:'))).toBe(true)
  })

  it('does not flag normal Chinese, Japanese, accented Latin text, or nullish operators', () => {
    const text = [
      '正常中文：战斗日志、玩家、取消、状态。',
      '日本語：ミナト。',
      'Français: élève; Português: São Paulo.',
      'const value = primary ?? fallback',
    ].join('\n')

    expect(scan(text, 'normal.ts')).toEqual([])
  })

  it('preserves BOM, invalid UTF-8, and invalid JSON checks', () => {
    const bomIssues = findBufferIssues(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{}', 'utf8'),
    ]), 'bom.json')
    const invalidUtf8Issues = findBufferIssues(Buffer.from([0xff]), 'invalid.txt')
    const invalidJsonIssues = scan('{ nope', 'invalid.json')

    expect(bomIssues.some(issue => issue.message === 'UTF-8 BOM detected')).toBe(true)
    expect(invalidUtf8Issues.some(issue => issue.message === 'replacement character detected')).toBe(true)
    expect(invalidJsonIssues.some(issue => issue.message.startsWith('invalid JSON:'))).toBe(true)
  })

  it('keeps the repaired tracked runtime sources free of detectable corruption', () => {
    const trackedFiles = [
      'data/pages/battle.html',
      'data/pages/js/game-engine.js',
      'data/pieces/blue-minato.json',
      'lib/game/turn.ts',
    ]

    for (const rel of trackedFiles) {
      const bytes = readFileSync(resolve(process.cwd(), rel))
      expect(findBufferIssues(bytes, rel), rel).toEqual([])
    }
  })

  it('keeps one complete battle-log overlay header and its actions', () => {
    const battleHtml = readFileSync(resolve(process.cwd(), 'data/pages/battle.html'), 'utf8')

    expect(battleHtml.match(/>📜 战斗日志<\/div>/g)).toHaveLength(1)
    expect(battleHtml.match(/onclick="clearLog\(\)"/g)).toHaveLength(1)
    expect(battleHtml.match(/onclick="closeLog\(\)"/g)).toHaveLength(1)
  })
})
