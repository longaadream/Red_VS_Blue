'use strict'

// RED-250 UI entry smoke. This deliberately renders production HTML snippets
// with the production CSS in a hidden Electron window. It does not start the
// game, an authority server, or an authentication service.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..', '..')
const pages = path.join(root, 'data', 'pages')
const output = process.env.RED250_UI_OUTPUT
  ? path.resolve(process.env.RED250_UI_OUTPUT)
  : path.join(root, 'docs', 'qa', 'RED250')
const phase = process.env.RED250_UI_PHASE || 'after'
const baseRef = process.env.RED250_UI_BASE_REF || 'e49d74a68807d0bbfb233f875a7ba52811f77e75'
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

function fileUrl(file) {
  return pathToFileURL(file).href
}

function localStyles(page, options = {}) {
  const skip = new Set(options.skip || [])
  const inline = options.inline || {}
  const chunks = []
  const token = /<style[^>]*>[\s\S]*?<\/style>|<link[^>]*rel=["']stylesheet["'][^>]*href=["'][^"']+["'][^>]*>/gi
  for (const match of page.matchAll(token)) {
    const source = match[0]
    if (/^<style/i.test(source)) {
      chunks.push(source)
      continue
    }
    const href = source.match(/href=["']([^"']+)["']/i)?.[1] || ''
    const normalizedHref = href.replace(/^\.\//, '')
    if (/^(?:https?:)?\/\//i.test(href)) continue
    if (skip.has(normalizedHref)) continue
    if (Object.prototype.hasOwnProperty.call(inline, normalizedHref)) {
      chunks.push('<style data-red250-inline="' + normalizedHref + '">\n' + inline[normalizedHref] + '\n</style>')
      continue
    }
    chunks.push('<link rel="stylesheet" href="' + fileUrl(path.join(pages, normalizedHref)) + '">')
  }
  return chunks.join('\n')
}
function battleBodyMarkup(page) {
  page = page.replace(/\r\n/g, '\n')
  const start = page.indexOf('<body')
  const end = page.lastIndexOf('</body>')
  assert.ok(start >= 0 && end > start, 'battle body markup boundary missing')
  const body = page.slice(start, end + '</body>'.length)
  return body.replace(/<script\b[\s\S]*?<\/script>/gi, '')
}

function menuMarkup(page) {
  page = page.replace(/\r\n/g, '\n')
  const bodyStart = page.indexOf('<body')
  const scriptsStart = page.indexOf('<script', bodyStart)
  assert.ok(bodyStart >= 0 && scriptsStart > bodyStart, 'index body boundary missing')
  const bodyOpenEnd = page.indexOf('>', bodyStart)
  assert.ok(bodyOpenEnd >= 0 && bodyOpenEnd < scriptsStart, 'index body opening tag missing')
  return page.slice(bodyStart, bodyOpenEnd + 1) + page.slice(bodyOpenEnd + 1, scriptsStart) + '</body>'
}

function writeFixtures() {
  const battle = phase === 'before'
    ? execFileSync('git', ['show', baseRef + ':data/pages/battle.html'], { cwd: root, encoding: 'utf8' })
    : fs.readFileSync(path.join(pages, 'battle.html'), 'utf8')
  const index = fs.readFileSync(path.join(pages, 'index.html'), 'utf8')
  const battleFixture = path.join(root, 'dist', 'red250-ui-entry-battle-fixture.html')
  const menuFixture = path.join(root, 'dist', 'red250-ui-entry-menu-fixture.html')
  fs.mkdirSync(path.dirname(battleFixture), { recursive: true })
  fs.mkdirSync(output, { recursive: true })

  const battleStyles = phase === 'before'
    ? localStyles(battle, { inline: {
      'css/battle-tactical-table.css': execFileSync('git', ['show', baseRef + ':data/pages/css/battle-tactical-table.css'], { cwd: root, encoding: 'utf8' }),
    } })
    : localStyles(battle)

  fs.writeFileSync(battleFixture, `<!doctype html>
<meta charset="utf-8">
<base href="${fileUrl(pages + path.sep)}">
${battleStyles}
<style id="red250-fixture-style">
  html, body { width:100%; height:100%; margin:0; overflow:hidden; }
  body { min-height:100%; background:#1a1c24 !important; }
  .red250-fixture-board { position:fixed; inset:0; background:
    radial-gradient(circle at 50% 42%, #4b4051 0, #2a2c38 46%, #111722 100%); }
  .red250-fixture-board::after { content:'目标选择场景 · RED250'; position:absolute; left:50%; top:50%;
    transform:translate(-50%,-50%); color:#d6c3a3; opacity:.75; font:700 16px/1.4 Georgia,serif; }
</style>
${battleBodyMarkup(battle)}
`)

  const menu = menuMarkup(index)
  fs.writeFileSync(menuFixture, `<!doctype html>
<meta charset="utf-8">
<base href="${fileUrl(pages + path.sep)}">
${localStyles(index)}
<style id="red250-menu-fixture-style">html,body{min-height:100%;margin:0}</style>
${menu.replace('</body>', `<script src="${fileUrl(path.join(pages, 'js', 'player-profile.js'))}"></script></body>`)}
`)
  return { battleFixture, menuFixture }
}

async function nextFrame(win) {
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}

async function battleState(win, width, height) {
  await win.setContentSize(width, height)
  await nextFrame(win)
  return win.webContents.executeJavaScript(`(() => {
    const viewport = { width: innerWidth, height: innerHeight }
    const names = ['targetPromptText', 'targetCancelButton', 'targetConfirmButton']
    const controls = document.getElementById('targetSelectionControls')
    const visible = element => {
      if (!element) return false
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden'
        && rect.width > 0 && rect.height > 0
    }
    const values = {}
    for (const name of names) {
      const element = document.getElementById(name)
      const rect = element?.getBoundingClientRect()
      const x = rect ? rect.left + rect.width / 2 : 0
      const y = rect ? rect.top + rect.height / 2 : 0
      const hit = rect ? document.elementFromPoint(x, y) : null
      values[name] = {
        visible: visible(element),
        hidden: !!element?.hidden,
        disabled: !!element?.disabled,
        text: element?.textContent?.trim() || '',
        rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          width: rect.width, height: rect.height } : null,
        hitTag: hit?.tagName || null,
        hitId: hit?.id || null,
        hitButton: !!(element && (hit === element || hit?.closest?.('button') === element)),
      }
    }
    return {
      viewport,
      controls: {
        visible: visible(controls),
        display: getComputedStyle(controls).display,
        rect: controls?.getBoundingClientRect().toJSON?.() || null,
        parentId: controls?.parentElement?.id || null,
        handCardCount: document.querySelectorAll('#handCards .card-item').length,
        hudPresent: !!document.querySelector('[data-battle-ui-region="player-hud"]'),
        characterPanelPresent: !!document.getElementById('pieceInfoModal') && !!document.getElementById('myPanel'),
        characterDock: (() => {
          const modal = document.getElementById('pieceInfoModal')
          const sheet = modal?.querySelector('.pi-sheet')
          const style = modal ? getComputedStyle(modal) : null
          const rect = modal?.getBoundingClientRect()
          return {
            open: !!modal && modal.classList.contains('character-dock'),
            display: style?.display || '',
            visible: !!modal && !modal.hidden && style?.display !== 'none' && style?.visibility !== 'hidden',
            rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null,
            scrolled: !!sheet && sheet.scrollTop > 0,
            scrollTop: sheet?.scrollTop || 0,
            scrollHeight: sheet?.scrollHeight || 0,
            clientHeight: sheet?.clientHeight || 0,
          }
        })(),
      },
      values,
    }
  })()`)
}

function assertBattleState(state, label) {
  assert.equal(state.controls.parentId, 'targetOverlay', `${label}: controls are not mounted in targetOverlay: ${JSON.stringify(state.controls)}`)
  assert.ok(state.controls.handCardCount >= 3, `${label}: real hand fixture is missing sample cards: ${JSON.stringify(state.controls)}`)
  assert.equal(state.controls.hudPresent, true, `${label}: real battle HUD is missing from fixture`)
  assert.equal(state.controls.characterPanelPresent, true, `${label}: real character panel is missing from fixture`)
  assert.equal(state.controls.characterDock.open, true, `${label}: character dock fixture is not open`)
  assert.equal(state.controls.characterDock.visible, true, `${label}: character dock is not visible: ${JSON.stringify(state.controls.characterDock)}`)
  assert.equal(state.controls.characterDock.scrolled, true, `${label}: character dock was not scrolled: ${JSON.stringify(state.controls.characterDock)}`)
  const prompt = state.values.targetPromptText
  assert.ok(prompt && prompt.visible, `${label}: target prompt is not visible: ${JSON.stringify(prompt)}`)
  for (const name of ['targetCancelButton', 'targetConfirmButton']) {
    const value = state.values[name]
    assert.ok(value && value.visible, `${label}: ${name} is not visible: ${JSON.stringify(value)}`)
    assert.ok(value.rect.height >= 44, `${label}: ${name} touch height < 44: ${JSON.stringify(value.rect)}`)
    assert.ok(value.hitButton, `${label}: ${name} center did not hit the button: ${JSON.stringify(value)}`)
    const edgeGap = Math.min(value.rect.left, value.rect.top,
      state.viewport.width - value.rect.right, state.viewport.height - value.rect.bottom)
    assert.ok(edgeGap >= 16, `${label}: ${name} is too close to viewport edge: ${JSON.stringify(value.rect)}`)
  }
}

async function renderBattle(win, fixture, before) {
  await win.loadFile(fixture)
  await win.webContents.executeJavaScript(`(() => {
    // The fixture keeps the real battle body (HUD, board, hand, modals and
    // character-sheet nodes) but omits game scripts. Hide only boot/result
    // blockers and seed static labels/cards so the target controls are tested
    // in the same layout layers as a loaded battle.
    for (const id of ['loadingOverlay', 'orientationGuard', 'turnAnnounce', 'resultOverlay', 'cardDetailModal', 'optionPickerOverlay', 'trainingSetupOverlay', 'surrenderConfirmOverlay']) {
      const node = document.getElementById(id)
      if (node) { node.hidden = true; node.style.display = 'none' }
    }
    const room = document.getElementById('roomNameLabel')
    const turn = document.getElementById('turnBadge')
    const phase = document.getElementById('phaseLabel')
    if (room) room.textContent = 'RED250 演示战局'
    if (turn) turn.textContent = '行动中'
    if (phase) phase.textContent = '选择目标'
    const hand = document.getElementById('handCards')
    if (hand) {
      hand.innerHTML = ['圣光牌', '火球', '护盾'].map((name, index) =>
        '<button type="button" class="card-item' + (index === 0 ? ' card-pending' : '') + '">' +
        '<span class="card-art">' + ['✦', '☄', '⬡'][index] + '</span>' +
        '<span class="card-name-banner">' + name + '</span><span class="card-body"><span class="card-desc">演示手牌 · 不执行规则</span></span></button>'
      ).join('')
    }
    const characterModal = document.getElementById('pieceInfoModal')
    const characterContent = document.getElementById('pieceInfoContent')
    if (characterModal && characterContent) {
      // Keep a real character dock open and scrolled while target controls are tested.
      // This is static fixture content; no battle rules or character scripts run.
      document.getElementById('pieceInfoName').textContent = '演示角色'
      document.getElementById('pieceInfoIdentity').textContent = '本人'
      characterContent.innerHTML = '<div class="pi-piece-state"><div class="pi-stats">' +
        '<div class="pi-stat"><strong>24</strong><span>生命</span></div>'.repeat(4) +
        '</div></div>' + Array.from({ length: 12 }, (_, index) =>
          '<section class="pi-skill"><div class="pi-skill-header"><span class="pi-skill-icon">✦</span><strong class="pi-skill-name">演示技能 ' + (index + 1) + '</strong></div>' +
          '<div class="pi-skill-desc">角色面板滚动内容，仅用于 RED250 布局遮挡与命中测试。</div></section>'
        ).join('')
      characterModal.classList.add('character-dock')
      characterModal.style.display = 'flex'
      characterModal.setAttribute('aria-hidden', 'false')
      document.body.classList.add('character-dock-open')
      const characterSheet = characterModal.querySelector('.pi-sheet')
      if (characterSheet) characterSheet.scrollTop = characterSheet.scrollHeight
    }
    const overlay = document.getElementById('targetOverlay')
    const controls = document.getElementById('targetSelectionControls')
    const prompt = document.getElementById('targetPromptText')
    const confirm = document.getElementById('targetConfirmButton')
    const cancel = document.getElementById('targetCancelButton')
    prompt.textContent = '选择目标'
    overlay.classList.add('show')
    controls.classList.add('show')
    confirm.style.display = ''
    confirm.disabled = false
    cancel.hidden = false
    cancel.disabled = false
    document.body.classList.add('target-mode-active')
  })()`)
  const results = {}
  for (const [width, height] of [[1280, 720], [844, 390]]) {
    const state = await battleState(win, width, height)
    if (!before) assertBattleState(state, `${width}x${height}`)
    results[`${width}x${height}`] = state
    const png = await win.webContents.capturePage()
    fs.writeFileSync(path.join(output, `red250-battle-cancel-${before ? 'before-fix' : 'after-fix'}-${width}x${height}.png`), png.toPNG())
  }
  fs.writeFileSync(path.join(output, `red250-battle-cancel-${before ? 'before-fix' : 'after-fix'}-geometry.json`), JSON.stringify(results, null, 2) + '\n')
  return results
}

async function renderAccountEntries(win, fixture) {
  await win.setContentSize(1280, 720)
  await win.loadFile(fixture)
  const own = await win.webContents.executeJavaScript(`(async () => {
    const calls = []
    const requests = []
    window.__red250LogoutCalls = calls
    window.RvBUtils = {
      normalizeOfficialOrigin: value => String(value || '').replace(/\\/$/, ''),
      getServerUrl: () => 'https://mock.invalid',
      readOfficialSession: () => ({ token: 'mock-token', account: { id: 'self', name: '本人' } }),
    }
    window.RvBIdentity = { getIdentity: () => ({ id: 'guest', displayName: '离线玩家' }) }
    localStorage.setItem('rvb_official_url', 'https://mock.invalid')
    window.fetch = async (url, init) => {
      requests.push({ url: String(url), method: init?.method || 'GET' })
      const route = String(url).replace('https://mock.invalid', '')
      if (route === '/official/players/catalog') return { ok: true, status: 200, json: async () => ({ characters: [] }) }
      if (route === '/official/players/self' || route === '/official/players/opponent') {
        const id = route.split('/').pop()
        return { ok: true, status: 200, json: async () => ({ id, name: id === 'self' ? '本人' : '对手', recentMatches: [] }) }
      }
      throw new Error('unexpected mock route: ' + route)
    }
    window.__red250LogoutMock = async () => { calls.push('logout'); return true }
    window.RvBHomeAccount = { logout: window.__red250LogoutMock }
    const profileSource = ${JSON.stringify(fs.readFileSync(path.join(pages, 'js', 'player-profile.js'), 'utf8'))}
    const script = document.createElement('script')
    script.textContent = profileSource
    document.head.appendChild(script)
    window.RvBPlayerProfile.setLogoutHandler(window.RvBHomeAccount.logout)
    await window.RvBPlayerProfile.open('self', { focus: false })
    // Electron capturePage on a hidden BrowserWindow can omit the dialog top layer;
    // keep the production profile CSS and force only a normal fixed stacking layer.
    const dialog = document.getElementById('rvbPlayerProfileDialog')
    if (dialog) {
      dialog.style.position = 'fixed'
      dialog.style.zIndex = '2147483647'
      dialog.style.margin = 'auto'
    }
    const ownLogout = document.getElementById('rvbPlayerProfileLogout')
    window.__red250AccountFixture = { calls, requests }
    const ownLogoutRect = ownLogout?.getBoundingClientRect()
    const ownLogoutStyle = ownLogout ? getComputedStyle(ownLogout) : null
    const dialogRect = dialog?.getBoundingClientRect()
    const dialogStyle = dialog ? getComputedStyle(dialog) : null
    return { dialogOpen: !!dialog?.open,
      dialogRect: dialogRect ? { left: dialogRect.left, top: dialogRect.top, right: dialogRect.right, bottom: dialogRect.bottom, width: dialogRect.width, height: dialogRect.height } : null,
      dialogDisplay: dialogStyle?.display || '', dialogVisibility: dialogStyle?.visibility || '', dialogOpacity: dialogStyle?.opacity || '', dialogZIndex: dialogStyle?.zIndex || '',
      logoutHidden: !!ownLogout?.hidden,
      logoutText: ownLogout?.textContent?.trim() || '', menuLogoutPresent: !!document.getElementById('homeLogout'),
      logoutRect: ownLogoutRect ? { left: ownLogoutRect.left, top: ownLogoutRect.top, width: ownLogoutRect.width, height: ownLogoutRect.height } : null,
      logoutDisplay: ownLogoutStyle?.display || '', logoutVisibility: ownLogoutStyle?.visibility || '',
      logoutMinHeight: ownLogoutStyle?.minHeight || '', logoutBoxSizing: ownLogoutStyle?.boxSizing || '', logoutLineHeight: ownLogoutStyle?.lineHeight || '' }
  })()`)
  await nextFrame(win)
  const ownScreenshot = await win.webContents.capturePage()
  fs.writeFileSync(path.join(output, 'red250-profile-self-logout.png'), ownScreenshot.toPNG())
  const result = await win.webContents.executeJavaScript(`(async () => {
    const fixture = window.__red250AccountFixture
    const ownLogout = document.getElementById('rvbPlayerProfileLogout')
    ownLogout.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    const callsAfterOwnClick = fixture.calls.length
    await window.RvBPlayerProfile.open('opponent', { focus: false })
    const dialog = document.getElementById('rvbPlayerProfileDialog')
    const opponentLogout = document.getElementById('rvbPlayerProfileLogout')
    const opponent = { dialogOpen: !!dialog?.open, logoutHidden: !!opponentLogout?.hidden,
      logoutText: opponentLogout?.textContent?.trim() || '' }
    return { opponent, callsAfterOwnClick, requests: fixture.requests }
  })()`)
  result.own = own
  assert.equal(result.own.menuLogoutPresent, false, 'main menu still contains home logout')
  assert.equal(result.own.logoutHidden, false, 'own profile logout is hidden')
  assert.equal(result.own.logoutText, '退出登录')
  assert.ok(result.own.logoutRect && result.own.logoutRect.width > 0 && result.own.logoutRect.height > 0,
    `own profile logout is not rendered: ${JSON.stringify(result.own)}`)
  assert.ok(result.own.logoutRect.height >= 44,
    `own profile logout touch height < 44: ${JSON.stringify(result.own.logoutRect)}`)
  assert.equal(result.callsAfterOwnClick, 1, 'own profile click did not call logout mock exactly once')
  assert.equal(result.opponent.logoutHidden, true, 'other profile exposes logout')
  assert.equal(result.requests.some(request => /\/official\/auth\//.test(request.url)), false,
    `profile smoke reached auth network route: ${JSON.stringify(result.requests)}`)
  await nextFrame(win)
  const screenshot = await win.webContents.capturePage()
  fs.writeFileSync(path.join(output, 'red250-profile-other-no-logout.png'), screenshot.toPNG())
  fs.writeFileSync(path.join(output, 'red250-account-results.json'), JSON.stringify(result, null, 2) + '\n')
  return result
}

async function electronMain() {
  const { app, BrowserWindow, session } = require('electron')
  app.disableHardwareAcceleration()
  const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-red250-ui-entry-'))
  app.setPath('userData', isolatedUserData)
  const { battleFixture, menuFixture } = writeFixtures()
  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => callback({ cancel: true }))
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  try {
    if (phase === 'before') {
      const battle = await renderBattle(win, battleFixture, true)
      console.log(JSON.stringify({ phase, output, battle }, null, 2))
      return
    }
    const battle = await renderBattle(win, battleFixture, false)
    const account = await renderAccountEntries(win, menuFixture)
    console.log(JSON.stringify({ phase, output, battle, account }, null, 2))
  } finally {
    if (!win.isDestroyed()) win.destroy()
    try { fs.rmSync(isolatedUserData, { recursive: true, force: true }) } catch {}
    app.quit()
  }
}

if (process.versions.electron) {
  electronMain().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1 })
} else {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [__filename], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  child.once('error', error => { console.error(error.stack || String(error)); process.exitCode = 1 })
  child.once('exit', code => { process.exitCode = code == null ? 1 : code })
}
