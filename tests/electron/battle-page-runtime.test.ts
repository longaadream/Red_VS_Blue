import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

import { describe, expect, it } from 'vitest'

const projectRoot = process.cwd()
const battlePagePath = path.join(projectRoot, 'data', 'pages', 'battle.html')

function readBattlePage(): string {
  return fs.readFileSync(battlePagePath, 'utf8')
}

interface InlineScript {
  source: string
  htmlLine: number
}

function inlineScripts(html: string): InlineScript[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => {
      const source = match[1]
      const sourceOffset = (match.index ?? 0) + match[0].indexOf(source)
      return {
        source,
        htmlLine: html.slice(0, sourceOffset).split('\n').length,
      }
    })
}

function styleBlocks(html: string): string[] {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map(match => match[1])
}

function documentMarkup(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
}

describe('battle page runtime source', () => {
  it('parses every inline script before the loading overlay can initialize', () => {
    const scripts = inlineScripts(readBattlePage())

    expect(scripts.length).toBeGreaterThan(0)
    scripts.forEach((script, index) => {
      const filename = `battle-inline-${index + 1}.js`
      expect(() => {
        try {
          new vm.Script(script.source, { filename })
        } catch (error) {
          const stack = error instanceof Error ? error.stack ?? '' : ''
          const scriptLine = Number(stack.match(new RegExp(`${filename.replace('.', '\\.')}:(\\d+)`))?.[1] ?? 1)
          const htmlLine = script.htmlLine + scriptLine - 1
          throw new Error(`battle.html:${htmlLine} inline script ${index + 1} failed to parse: ${String(error)}`, {
            cause: error,
          })
        }
      }).not.toThrow()
    })
  })

  it('keeps HTML elements out of style blocks', () => {
    const styles = styleBlocks(readBattlePage())

    expect(styles.length).toBeGreaterThan(0)
    styles.forEach(style => {
      expect(style).not.toMatch(/^\s*<[a-z][^>]*>/im)
    })
  })

  it('uses unique ids in the rendered document markup', () => {
    const markup = documentMarkup(readBattlePage())
    const ids = [...markup.matchAll(/\bid=["']([^"']+)["']/gi)].map(match => match[1])
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]

    expect(duplicates).toEqual([])
  })

  it('starts initialization on load and turns terminal setup errors into visible errors', () => {
    const html = readBattlePage()

    expect(html).toMatch(/window\.addEventListener\('load',[\s\S]*?\binit\(\)/)
    expect(html).toMatch(/if \(!roomId \|\| !myPlayerId\) \{ showMsg\([^\n]+, 'err'\); return \}/)
    expect(html).toContain("spinner.style.display = type === 'err' ? 'none' : ''")
  })
})
