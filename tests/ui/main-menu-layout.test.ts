import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const page = readFileSync(resolve(process.cwd(), 'data/pages/index.html'), 'utf8')

describe('RED-171 game-style main menu layout contract', () => {
  it('establishes the four-mode navigation with online play selected by default', () => {
    expect(page).toContain('class="game-shell"')
    expect(page).toContain('role="tablist" aria-label="游戏模式"')
    expect(page).toMatch(/class="mode-tab is-active"[\s\S]*?data-mode="online"[\s\S]*?aria-selected="true"[\s\S]*?联机对战/)

    for (const [mode, label] of [
      ['online', '联机对战'],
      ['adventure', '开始冒险'],
      ['training', '训练营'],
      ['codex', '棋子与地图'],
    ]) {
      expect(page).toMatch(new RegExp(`data-mode="${mode}"[\\s\\S]*?${label}`))
      expect(page).toContain(`id="mode-${mode}"`)
    }
  })

  it('keeps every existing destination mapped to the approved hierarchy', () => {
    expect(page).toMatch(/id="mode-online"[\s\S]*?局域网联机[\s\S]*?id="createLocalRoom"[\s\S]*?创建 LAN 房间/)
    expect(page).toMatch(/id="mode-online"[\s\S]*?加入 LAN 房间[\s\S]*?互联网联机/)
    expect(page).toMatch(/id="mode-online"[\s\S]*?服务器大厅[\s\S]*?登录 \/ 排位对战/)
    expect(page).toMatch(/id="mode-adventure"[\s\S]*?id="pveBtn"[\s\S]*?onclick="window.location.href='adventure.html'"/)
    expect(page).toMatch(/id="mode-adventure"[\s\S]*?加入局域网冒险[\s\S]*?服务器冒险/)
    expect(page).toMatch(/id="mode-training"[\s\S]*?onclick="goToTraining\(\)"/)
    expect(page).toMatch(/id="mode-codex"[\s\S]*?loadPage\('pieces\.html'\)[\s\S]*?loadPage\('maps\.html'\)/)

    expect(page).toMatch(/class="utility-bar"[\s\S]*?onclick="openRecordsSheet\(\)"/)
    expect(page).toMatch(/class="utility-bar"[\s\S]*?loadPage\('pack\.html'\)/)
    expect(page).toMatch(/class="utility-bar"[\s\S]*?loadPage\('developer-tools\.html'\)/)
    expect(page).toMatch(/id="userPill"[\s\S]*?onclick="openIdentitySheet\(\)"/)
  })

  it('separates local player identity from persistent per-server accounts', () => {
    const utilities = readFileSync(resolve(process.cwd(), 'data/pages/js/server-utils.js'), 'utf8')
    const official = readFileSync(resolve(process.cwd(), 'data/pages/js/official.js'), 'utf8')
    const colyseus = readFileSync(resolve(process.cwd(), 'data/pages/js/colyseus-client.js'), 'utf8')

    expect(page).toContain('aria-label="打开本机玩家资料"')
    expect(page).toContain('不是互联网服务器账号')
    expect(utilities).toContain("var OFFICIAL_SESSION_PREFIX = 'rvb_official_session:'")
    expect(utilities).toContain('function readOfficialSession(url)')
    expect(utilities).toContain('function saveOfficialSession(value)')
    expect(official).toContain('window.RvBUtils.saveOfficialSession')
    expect(colyseus).toContain('window.RvBUtils.readOfficialSession(requested)')
    expect(readFileSync(resolve(process.cwd(), 'data/pages/js/ranked-session.js'), 'utf8')).toContain('window.RvBUtils.readOfficialSession(selectedUrl)')
  })

  it('keeps the first-session tutorial visible without opening the training tab', () => {
    const shortcutIndex = page.indexOf('id="tutorialShortcut"')
    const tablistIndex = page.indexOf('class="mode-tabs"')
    const trainingPanelIndex = page.indexOf('id="mode-training"')

    expect(shortcutIndex).toBeGreaterThan(-1)
    expect(shortcutIndex).toBeLessThan(tablistIndex)
    expect(shortcutIndex).toBeLessThan(trainingPanelIndex)
    expect(page).toMatch(/id="tutorialShortcut"[\s\S]*?onclick="goToTutorial\(\)"/)
    expect(page).toContain('第一次来？')
    expect(page).toContain('id="tutorialEntryDescription"')
    expect(page.match(/onclick="goToTutorial\(\)"/g)).toHaveLength(1)
    expect(page).toMatch(/function goToTutorial\(\)\s*\{\s*window\.location\.href = 'tutorial\.html'\s*\}/)
    const tutorial = readFileSync(resolve(process.cwd(), 'data/pages/tutorial.html'), 'utf8')
    expect(tutorial).toContain('battle.html?mode=tutorial')
    expect(page).not.toContain("goToLocalPractice('tutorial')")
  })

  it('uses a two-column desktop shell and structural narrow-screen reflow', () => {
    expect(page).toMatch(/\.menu-workspace\s*\{[\s\S]*?grid-template-columns:\s*minmax\(220px,\s*0\.72fr\)\s+minmax\(0,\s*1\.7fr\)/)
    expect(page).toContain('@media (max-width: 760px)')
    expect(page).toContain('@media (orientation: landscape) and (max-height: 500px)')
    expect(page).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.menu-workspace\s*\{[\s\S]*?grid-template-columns:\s*1fr/)
    expect(page).toContain('env(safe-area-inset-bottom)')
    expect(page).not.toContain('transition: all')
  })

  it('switches panels locally without replacing the existing overlay behavior', () => {
    expect(page).toContain("function selectMenuMode(mode)")
    expect(page).toContain("document.querySelectorAll('[data-mode-panel]')")
    expect(page).toContain("tab.setAttribute('aria-selected', String(active))")

    for (const overlay of ['connectOverlay', 'hostOverlay', 'lanOverlay', 'identityOverlay', 'recordsOverlay']) {
      expect(page).toContain(`id="${overlay}"`)
    }
    for (const handler of ['showHostSheet', 'showJoinSheet', 'showConnectSheet', 'openIdentitySheet', 'openRecordsSheet']) {
      expect(page).toMatch(new RegExp(`function ${handler}\\(`))
    }
  })

  it('reuses one verified PostgreSQL report read across the summary and records sheet', () => {
    expect(page).toContain('var _recordsLoadInFlight = null')
    expect(page).toContain('var _recordsCache = null')
    expect(page).toMatch(/if \(_recordsCache && _recordsCache\.key === cacheKey\) return _recordsCache\.records\.slice\(\)/)
    expect(page).toMatch(/if \(_recordsLoadInFlight && _recordsLoadInFlight\.key === cacheKey\) return _recordsLoadInFlight\.promise/)
    expect(page).toMatch(/_recordsCache = \{ key: cacheKey, records \}/)
    expect(page).toMatch(/if \(_recordsLoadInFlight && _recordsLoadInFlight\.promise === promise\) _recordsLoadInFlight = null/)
    expect(page).toContain('async function retryRecordsSheet()')
    expect(page).toContain("RvBUtils.getServerModeForUrl(serverUrl) === 'local'")
    expect(page).toContain('await (window.RvBHost || window.electronAPI).ensureLocalAuthority()')
    expect(page).toContain("RvBUtils.saveServerConfig({ mode: 'local', url: mode.localUrl })")
    expect(page).toMatch(/function _recordsLoadErrorMarkup[\s\S]*?role="alert"[\s\S]*?retryRecordsSheet\(\)[\s\S]*?重试/)
    expect(page).toContain("_recordsLoadErrorMarkup('权威战绩读取失败')")
  })
})
