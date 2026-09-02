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
    expect(page).toMatch(/id="mode-online"[\s\S]*?onclick="showHostSheet\(\)"[\s\S]*?我当主机/)
    expect(page).toMatch(/id="mode-online"[\s\S]*?onclick="showJoinSheet\(\)"[\s\S]*?连接主机/)
    expect(page).toMatch(/id="mode-online"[\s\S]*?onclick="showConnectSheet\(\)"[\s\S]*?连接游戏服务器/)
    expect(page).toMatch(/id="mode-adventure"[\s\S]*?id="pveBtn"[\s\S]*?onclick="startPve\(\)"/)
    expect(page).toMatch(/id="mode-training"[\s\S]*?onclick="goToTraining\(\)"/)
    expect(page).toMatch(/id="mode-codex"[\s\S]*?loadPage\('pieces\.html'\)[\s\S]*?loadPage\('maps\.html'\)/)

    expect(page).toMatch(/class="utility-bar"[\s\S]*?onclick="openRecordsSheet\(\)"/)
    expect(page).toMatch(/class="utility-bar"[\s\S]*?loadPage\('pack\.html'\)/)
    expect(page).toMatch(/class="utility-bar"[\s\S]*?loadPage\('developer-tools\.html'\)/)
    expect(page).toMatch(/id="userPill"[\s\S]*?onclick="openIdentitySheet\(\)"/)
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
})
