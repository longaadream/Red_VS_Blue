import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const pagesDir = resolve(process.cwd(), 'data/pages')
const readPage = (name: string) => readFileSync(resolve(pagesDir, name), 'utf8')
const readScript = (name: string) => readFileSync(resolve(pagesDir, 'js/developer-tools', name), 'utf8')

describe('out-of-match developer center', () => {
  it('is linked from the public main menu as a separate page', () => {
    const menu = readPage('index.html')

    expect(menu).toContain("loadPage('developer-tools.html')")
    expect(menu).toContain('开发者中心')
  })

  it('fails closed while an active match marker exists and never connects to a room', () => {
    const page = readPage('developer-tools.html')
    const script = readScript('developer-center.js')
    const combined = page + '\n' + script

    expect(combined).toContain('readActiveBattle')
    expect(page).toContain('activeMatchGate')
    expect(page).toContain('scenarioForm')
    expect(combined).toContain('/api/developer-tools/scenario')
    expect(page).toContain('traceFileInput')
    expect(page).toContain('traceDropZone')
    expect(page).toContain('导入 Trace')
    expect(page).toContain('打开回放')
    expect(page).toContain('developer-center.js')
    expect(combined).toContain('developerToolsFetch')
    expect(combined).toContain("window.location.protocol === 'http:'")
    expect(page).toContain('match-trace.js')
    expect(page).toContain('再次下载 Trace')
    expect(combined).not.toContain('RvBColyseus.connect')
    expect(combined).not.toContain('requestBattleSnapshot')
    expect(combined).not.toContain("type: 'action'")
    expect(combined).not.toContain('new WebSocket')
  })

  it('removes the legacy in-match modifier and only stores trace from terminal handling', () => {
    const battle = readPage('battle.html')

    expect(battle).toContain('js/developer-tools/match-trace.js')
    expect(battle).toContain('storeCompletedMatchTrace')
    const transitionStateApply = battle.search(/applyServerState\(\r?\n\s+nextState,/)
    expect(transitionStateApply).toBeGreaterThan(-1)
    expect(battle.indexOf('latestAuthorityStateHash = msg.stateHash || latestAuthorityStateHash'))
      .toBeLessThan(transitionStateApply)
    expect(battle).toMatch(/function handleGameOver\(\)[\s\S]*?storeCompletedMatchTrace\(\)/)
    expect(battle).toContain('下载比赛 Trace')
    expect(battle).not.toContain('debugPanel')
    expect(battle).not.toContain('debugSetAP')
    expect(battle).not.toContain('debugSetCP')
    expect(battle).not.toContain('debugHealSelected')
    expect(battle).not.toContain('debugKillSelected')
    expect(battle).not.toContain('debugResetCooldowns')
    expect(battle).not.toContain('局内修改器')
  })
})
