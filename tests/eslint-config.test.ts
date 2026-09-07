import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const eslint = new ESLint()

describe('repository ESLint boundaries', () => {
  it('checks CommonJS tooling without requiring Next.js plugins in its file scope', async () => {
    const [result] = await eslint.lintText('const unused = 1\n', { filePath: 'docs/qa/check.cjs' })
    expect(result.messages.some(message => message.ruleId === '@typescript-eslint/no-unused-vars')).toBe(true)
  })

  it('ignores the vendored SDK while keeping application source checked', async () => {
    expect(await eslint.isPathIgnored('data/pages/js/colyseus-sdk.js')).toBe(true)
    expect(await eslint.isPathIgnored('data/pages/js/battle-ui/battle-presentation.js')).toBe(false)
    expect(await eslint.isPathIgnored('lib/game/skills.ts')).toBe(false)
  })

  it('applies Next.js navigation rules only to Next.js pages', async () => {
    const source = 'window.location.href = "/battle.html"\n'
    const [standalone] = await eslint.lintText(source, { filePath: 'data/pages/js/developer-tools/developer-center.js' })
    const [nextPage] = await eslint.lintText(source, { filePath: 'app/test-page.tsx' })
    const rule = '@next/next/no-location-assign-relative-destination'
    expect(standalone.messages.some(message => message.ruleId === rule)).toBe(false)
    expect(nextPage.messages.some(message => message.ruleId === rule)).toBe(true)
  })

  it('still rejects new explicit any in source and tests', async () => {
    for (const filePath of ['lib/game/lint-probe.ts', 'tests/lint-probe.test.ts']) {
      const [result] = await eslint.lintText('export const identity = (value: any) => value\n', { filePath })
      expect(result.messages.some(message => message.ruleId === '@typescript-eslint/no-explicit-any' && message.severity === 2)).toBe(true)
    }
  })

  it('rejects removed catch bindings that are still used in browser error paths', async () => {
    for (const filePath of ['android-client/www/js/ws-client.js', 'data/pages/js/developer-tools/replay-viewer.js']) {
      const [result] = await eslint.lintText('try { JSON.parse("{") } catch { console.error(error) }', { filePath })
      expect(result.messages.some(message => message.ruleId === 'no-undef' && message.severity === 2)).toBe(true)
    }
  })
})
