import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { EmbeddedPostgresController } from '../../electron-client/embedded-postgres.ts'
import { findFreePort } from '../../electron-client/local-port.ts'
import { createOfficialServer } from '../../lib/server/official/server.ts'
import { checkMobileBattlePanels } from './mobile-battle-panels.mjs'

const root = path.resolve(import.meta.dirname, '../..'), output = path.join(root, 'dist/multiplayer-qa')
fs.mkdirSync(output, { recursive: true })
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-official-browser-'))
const executable = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync)
if (!executable) throw new Error('Chrome or Edge is required for the actual browser smoke')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label, timeout = 45000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await delay(250) }
  throw new Error('Timed out: ' + label)
}
async function cdp(url) {
  const ws = new WebSocket(url), calls = new Map(); let sequence = 0
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { calls.delete(id); reject(new Error('CDP timeout: ' + method)) }, 20000)
      calls.set(id, data => { clearTimeout(timer); if (data.error) reject(new Error(data.error.message)); else resolve(data.result) })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data)
    if (data.id) { calls.get(data.id)?.(data); calls.delete(data.id) }
    if (data.method === 'Page.javascriptDialogOpening') void call('Page.handleJavaScriptDialog', { accept: true })
  })
  return { call, close: () => ws.close(), evaluate: async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description)
    return result.result.value
  } }
}
let app, browser, chrome, setupProcess
const pages = []
const pg = new EmbeddedPostgresController({ runtimeRoot: path.join(root, '_client-postgres/pgsql'), stateRoot: path.join(state, 'pg'), findFreePort, portHint: 38941, protectSecret: x => Buffer.from(x), unprotectSecret: x => x.toString() })
try {
  const db = await pg.start(), mails = new Map()
  app = await createOfficialServer({ databaseUrl: db.url, mail: async (to, purpose, code) => mails.set(to + ':' + purpose, code), pagesRoot: path.join(root, 'data/pages') })
  const port = await findFreePort(38942), debugPort = await findFreePort(19242), origin = `http://127.0.0.1:${port}`
  await app.start(port)
  const password = 'Smoke-test-password-123!'
  const users = []
  for (const index of [0, 1]) {
    const email = `browser-${index}@example.test`
    await app.accounts.requestCode('verify', { email, password, name: `浏览器玩家${index + 1}` })
    await app.accounts.redeem('verify', { email, code: mails.get(email + ':verify') })
    users.push({ email })
  }
  chrome = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${path.join(state, 'browser')}`, `--remote-debugging-port=${debugPort}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  let version
  await until(async () => { try { version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(r => r.json()); return !!version.webSocketDebuggerUrl } catch { return false } }, 'browser startup')
  browser = await cdp(version.webSocketDebuggerUrl)
  const built = path.join(root, 'dist/official-server/win-x64')
  let setupUrl = ''
  setupProcess = spawn(path.join(built, 'node.exe'), [path.join(built, 'server.mjs')], { cwd:built, env:{...process.env, RVB_OFFICIAL_STATE_ROOT:path.join(state,'setup'), RVB_OFFICIAL_NO_BROWSER:'1'}, windowsHide:true, stdio:['ignore','pipe','pipe'] })
  setupProcess.stdout.on('data', data => { const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+\/#([a-f0-9]+)/); if(match) setupUrl = match[0] })
  await until(() => !!setupUrl, 'first run SMTP setup')
  const setupOrigin = new URL(setupUrl).origin
  for (const asset of ['/css/tabletop/tabletop.css','/css/tabletop/online.css','/images/tabletop/table-wood.svg','/images/tabletop/ZCOOLKuaiLe-Regular.ttf']) if (!(await fetch(setupOrigin + asset)).ok) throw Error('Setup art unavailable: ' + asset)
  if ((await fetch(setupOrigin + '/official-config.json')).status !== 403) throw Error('Setup exposes a non-allowlisted path')
  if ((await fetch(setupOrigin + '/save', {method:'POST',headers:{Origin:setupOrigin,'X-Setup-Token':'invalid'}})).status !== 403) throw Error('Setup accepts an invalid token')
  const setupTarget = await browser.call('Target.createTarget', {url:setupUrl})
  const setupListing = await fetch('http://127.0.0.1:' + debugPort + '/json/list').then(r=>r.json())
  const setupPage = await cdp(setupListing.find(item=>item.id === setupTarget.targetId).webSocketDebuggerUrl)
  await setupPage.call('Emulation.setDeviceMetricsOverride', {width:1200,height:800,deviceScaleFactor:1,mobile:false})
  await until(() => setupPage.evaluate('!!document.getElementById("provider")'), 'QQ setup UI')
  await setupPage.evaluate('document.fonts.ready.then(() => true)')
  const setupShot = await setupPage.call('Page.captureScreenshot', {format:'png'});fs.writeFileSync(path.join(output,'red196-mail-setup.png'),Buffer.from(setupShot.data,'base64'))
  setupPage.close();await browser.call('Target.closeTarget',{targetId:setupTarget.targetId});setupProcess.kill()
  for (const user of users) {
    const context = await browser.call('Target.createBrowserContext')
    const target = await browser.call('Target.createTarget', { url: origin + '/official.html', browserContextId: context.browserContextId })
    const listing = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r => r.json())
    const page = await cdp(listing.find(item => item.id === target.targetId).webSocketDebuggerUrl); pages.push(page)
    await page.call('Page.enable')
    await page.call('Emulation.setDeviceMetricsOverride', { width:1200,height:800,deviceScaleFactor:1,mobile:false })
    await until(() => page.evaluate('!!document.getElementById("authForm") && document.getElementById("message").textContent.includes("已连接")'), 'official login page')
    await page.evaluate('document.getElementById("loginPrompt").click()')
    if (user === users[0]) {
      await page.evaluate('document.fonts.ready.then(() => true)')
      const login = await page.call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, 'red196-official-login.png'), Buffer.from(login.data, 'base64'))
    }
    await page.evaluate(`document.getElementById('email').value=${JSON.stringify(user.email)};document.getElementById('password').value=${JSON.stringify(password)};document.querySelector('#authForm button').click()`)
    await until(() => page.evaluate('document.getElementById("profile").hidden === false && !document.getElementById("join").disabled'), 'account login')
    if (user === users[0]) await page.evaluate('localStorage.setItem("rvb_game_profile_identity",JSON.stringify({runnerRevision:"stale-cached-client"}))')
    await page.evaluate('document.getElementById("join").click()')
  }
  for (const page of pages) {
    await until(() => page.evaluate('document.getElementById("enter").hidden === false'), 'matchmaking')
    await page.evaluate('document.getElementById("enter").click()')
    await until(() => page.evaluate('document.querySelectorAll(".ranked-map-card").length === 4'), 'real ranked veto')
  }
  await pages[0].evaluate('document.fonts.ready.then(() => true)')
  const vetoShot = await pages[0].call('Page.captureScreenshot', {format:'png'}); fs.writeFileSync(path.join(output,'red196-ranked-veto.png'),Buffer.from(vetoShot.data,'base64'))
  for (const [index, page] of pages.entries()) {
    await page.evaluate(`document.querySelectorAll('.choose-map')[${index}].click();document.getElementById('confirmBan').click()`)
  }
  await until(() => pages[0].evaluate('!document.getElementById("mapStage").hidden'), 'server map draw')
  const mapShot = await pages[0].call('Page.captureScreenshot', {format:'png'}); fs.writeFileSync(path.join(output,'red196-ranked-map.png'),Buffer.from(mapShot.data,'base64'))
  for (const page of pages) {
    await until(() => page.evaluate('!document.getElementById("chooseRoster").hidden'), 'map revealed')
    await page.evaluate('document.getElementById("chooseRoster").click()')
    await until(() => page.evaluate('location.pathname.endsWith("piece-selection.html") && !!document.getElementById("rankedRosterClock") && !document.getElementById("alignmentLightBtn").disabled'), 'ranked roster page')
    await page.evaluate(`document.getElementById('${page === pages[0] ? 'alignmentDarkBtn' : 'alignmentLightBtn'}').click()`)
    await until(() => page.evaluate('!alignmentLoading && document.querySelectorAll(".piece-card").length >= 8'), 'faction pieces')
    await page.evaluate(`while(document.querySelectorAll('.piece-card.selected').length<8){const next=document.querySelector('.piece-card:not(.selected)');if(!next)break;next.click()}`)
    await until(() => page.evaluate('!document.getElementById("confirmBtn").disabled'), 'legal roster')
    if (page === pages[0]) {
      await page.evaluate('document.getElementById("rankedViewMap").click()')
      await until(() => page.evaluate('location.pathname.endsWith("ranked-match.html") && !!document.getElementById("chooseRoster") && !document.getElementById("chooseRoster").hidden'), 'draft saved before map review')
      await page.evaluate('document.getElementById("chooseRoster").click()')
      await until(() => page.evaluate('location.pathname.endsWith("piece-selection.html") && document.querySelectorAll(".piece-card.selected").length === 8 && !document.getElementById("confirmBtn").disabled && document.getElementById("selectedCount").textContent.includes("8 / 8")'), 'restored full draft can lock without edits')
    }
    if (page === pages[0]) { const shot = await page.call('Page.captureScreenshot', {format:'png'}); fs.writeFileSync(path.join(output,'red196-ranked-roster.png'),Buffer.from(shot.data,'base64')) }
    await page.evaluate('document.getElementById("confirmBtn").click()')
  }
  for (const page of pages) await until(() => page.evaluate('location.pathname.endsWith("battle.html") && typeof G!=="undefined" && !!G && typeof colyseusConnected!=="undefined" && colyseusConnected'), 'live battle', 60000)
  // Actual Colyseus battle and production DOM at phone sizes (desktop Chromium,
  // not an Android performance/installation claim).
  for (const [width, height] of [[740, 360], [844, 390], [932, 430]]) {
    await pages[0].call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
    await pages[0].call('Emulation.setTouchEmulationEnabled', { enabled: true })
    await pages[0].evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await pages[0].evaluate('resetBoardView()')
    await until(() => pages[0].evaluate('document.getElementById("turnAnnounce").getAnimations().every(animation => animation.playState === "finished")'), 'turn announcement complete')
    const geometry = await pages[0].evaluate(`(() => {
      const rect = document.getElementById('boardStage3d').getBoundingClientRect();
      const points = [0, G.map.width - 1].flatMap(x => [0, G.map.height - 1].map(y => BattleRenderer3D.projectCell(x, y, .6)));
      const buttons = [...document.querySelectorAll('.board-camera-controls button')].map(button => { const r = button.getBoundingClientRect(); return {width:r.width,height:r.height} });
      return { board: {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height}, points, buttons };
    })()`)
    if (geometry.board.top < 58 || geometry.board.bottom > height - 88 || geometry.board.height < 180) throw Error('Battle overlaps phone HUD: ' + JSON.stringify(geometry))
    for (const p of geometry.points) if (p.clientX < geometry.board.left || p.clientX > geometry.board.right || p.clientY < geometry.board.top || p.clientY > geometry.board.bottom) throw Error('Phone board is cropped: ' + JSON.stringify(geometry))
    if (geometry.buttons.some(b => b.width < 44 || b.height < 44)) throw Error('Phone camera control is too small')
    if (geometry.buttons.length !== 1) throw Error('Phone camera should only show full-board reset; zoom uses gestures')
    const shot = await pages[0].call('Page.captureScreenshot', {format: 'png'})
    fs.writeFileSync(path.join(output, `red199-battle-${width}x${height}.png`), Buffer.from(shot.data, 'base64'))
  }
  // Submit the current authority offer using real DOM selection and canvas touch.
  const deployPage = await pages[0].evaluate('progressiveDeploymentOwned(G)') ? pages[0] : pages[1]
  await deployPage.call('Emulation.setDeviceMetricsOverride', {width:844,height:390,deviceScaleFactor:1,mobile:true})
  await deployPage.call('Emulation.setTouchEmulationEnabled', {enabled:true})
  await deployPage.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await until(() => deployPage.evaluate('!!document.querySelector(".deployment-choice") && !pendingActionFeedback'), 'deployment offer ready')
  await deployPage.evaluate('document.querySelector(".deployment-choice").click()')
  const deployCell = await deployPage.evaluate(`(() => {
    const cell = G.deployment?.legalPositions?.[0];
    return G.deployment?.status === 'awaiting-reserve-deploy' && cell ? BattleRenderer3D.projectCell(cell.x,cell.y) : null;
  })()`)
  if (deployCell) {
    await deployPage.call('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x:deployCell.clientX,y:deployCell.clientY}]})
    await deployPage.call('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]})
  }
  await until(() => deployPage.evaluate('!pendingActionFeedback && G.deployment?.status !== "awaiting-reserve-deploy"'), 'touch deployment acknowledged')
  await deployPage.evaluate('resetBoardView()')
  const deployedShot = await deployPage.call('Page.captureScreenshot',{format:'png'})
  fs.writeFileSync(path.join(output,'red199-battle-deployed.png'),Buffer.from(deployedShot.data,'base64'))
  await checkMobileBattlePanels(deployPage, output)
  await deployPage.call('Emulation.setTouchEmulationEnabled', {enabled:false})
  await deployPage.call('Emulation.setDeviceMetricsOverride', {width:1200,height:800,deviceScaleFactor:1,mobile:false})
  await pages[0].call('Emulation.setTouchEmulationEnabled', { enabled: false })
  await pages[0].call('Emulation.setDeviceMetricsOverride', {width:1200,height:800,deviceScaleFactor:1,mobile:false})
  // Dark roster remains authoritative after logout/relogin, even though the entry defaults to light.
  await pages[0].call('Page.navigate', { url: origin + '/official.html' })
  await until(() => pages[0].evaluate('!!document.getElementById("profile") && !document.getElementById("profile").hidden'), 'return to account')
  await pages[0].evaluate('document.getElementById("logout").click()')
  await until(() => pages[0].evaluate('!document.getElementById("auth").hidden'), 'logout')
  await pages[0].evaluate('document.getElementById("loginPrompt").click()')
  await pages[0].evaluate(`document.getElementById('email').value=${JSON.stringify(users[0].email)};document.getElementById('password').value=${JSON.stringify(password)};document.querySelector('#authForm button').click()`)
  // refresh() reveals the match before run()'s finally re-enables controls.
  // Clicking during that interval is a disabled-button no-op.
  await until(() => pages[0].evaluate('!document.getElementById("profile").hidden && !document.getElementById("enter").hidden && !document.getElementById("enter").disabled'), 'login during battle')
  await pages[0].evaluate('document.getElementById("enter").click()')
  await until(() => pages[0].evaluate('location.pathname.endsWith("battle.html") && typeof G!=="undefined" && !!G && typeof colyseusConnected!=="undefined" && colyseusConnected'), 'dark roster reentry', 60000)
  const screenshot = await pages[0].call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, 'red196-official-battle.png'), Buffer.from(screenshot.data, 'base64'))
  await pages[0].evaluate('document.getElementById("btnSurrender").click()')
  await pages[0].evaluate(`document.querySelector('[onclick="doSurrender()"]').click()`)
  await until(async () => (await app.pool.query(`SELECT 1 FROM official_matches WHERE status='settled'`)).rowCount === 1, 'actual page action and Elo settlement')
  const endedId = (await app.pool.query(`SELECT id FROM official_matches WHERE status='settled'`)).rows[0].id
  await until(async () => !(await fetch(origin + '/rooms').then(r => r.json())).rooms.some(room => room.id === endedId), 'ended match removed from playable lobby')
  if ((await fetch(origin + '/rooms/' + endedId).then(r => r.json())).room.status !== 'finished') throw Error('Terminal room detail was lost')
  for (const page of pages) { await page.call('Page.navigate', { url: origin + '/official.html' }); await until(() => page.evaluate('!!document.getElementById("profile") && !document.getElementById("profile").hidden && document.getElementById("record").textContent.includes("1 场")'), 'settled account UI') }
  await pages[0].evaluate("document.querySelector('[data-rank-tab=board]').click()")
  if (!await pages[0].evaluate('!document.getElementById("rank-board").hidden && !document.getElementById("join").hidden')) throw new Error('Matchmaking dock disappears when viewing leaderboard')
  const board = await pages[0].call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, 'red196-official-board.png'), Buffer.from(board.data, 'base64'))
  await pages[0].evaluate("document.querySelector('[data-rank-tab=prepare]').click()")
  const result = await pages[0].call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, 'red196-official-result.png'), Buffer.from(result.data, 'base64'))
  await pages[0].call('Emulation.setDeviceMetricsOverride', { width:390,height:844,deviceScaleFactor:1,mobile:true })
  if (!await pages[0].evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth')) throw new Error('Official page overflows mobile viewport')
  const mobile = await pages[0].call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.join(output, 'red196-official-mobile.png'), Buffer.from(mobile.data, 'base64'))
  await pages[0].call('Emulation.setDeviceMetricsOverride', { width:1200,height:800,deviceScaleFactor:1,mobile:false })
  await pages[0].call('Page.navigate', { url: origin + '/multiplayer.html' })
  await until(() => pages[0].evaluate('!!document.querySelector("body[data-art-page=multiplayer] .game-nav")'), 'casual entry theme')
  await pages[0].evaluate('document.fonts.ready.then(() => true)')
  const casual = await pages[0].call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, 'red196-multiplayer-entry.png'), Buffer.from(casual.data, 'base64'))
  await pages[0].call('Page.navigate', { url: origin + '/lobby.html' })
  await until(() => pages[0].evaluate('!!document.getElementById("roomSearch")'), 'room browser layout')
  await pages[0].evaluate('document.fonts.ready.then(() => true)')
  await until(() => pages[0].evaluate('!!window.RvBIdentity?.getIdentity()'), 'new browser local identity')
  // Deterministic UI fixtures exercise catalog navigation; they are not advertised live rooms.
  await pages[0].evaluate(`(() => {
    const me = RvBIdentity.getIdentity().id;
    const fixtures = [
      {id:'layout-full',name:'测试场景 · 等待中的1v1',mapId:'open-expanse',mode:'1v1',status:'waiting',visibility:'public',maxPlayers:2,players:[{id:me,alignment:'dark'},{id:'fixture-other'}]},
      {id:'layout-team',name:'测试场景 · 2v2招募队友',mapId:'team-crossroads',mode:'2v2',status:'waiting',visibility:'public',maxPlayers:4,players:[{id:'fixture-host'}]},
      {id:'layout-live',name:'测试场景 · 进行中的对局',mapId:'open-expanse',mode:'1v1',status:'in-progress',visibility:'public',maxPlayers:2,players:[{id:'fixture-a'},{id:'fixture-b'}],spectatingEnabled:true,spectatorCount:3},
      {id:'layout-private',name:'Never expose private room',visibility:'private',status:'waiting',players:[]},
      {id:'layout-finished',name:'已结束的旧服务器房间',visibility:'public',status:'finished',players:[{id:me}]}
    ];
    renderRooms(fixtures);
    if(document.querySelectorAll('.room-row').length !== 3) throw Error('Public catalog visibility regression');
    const restore = document.querySelector('.room-row [data-room-id="layout-full"]');
    if(restore.disabled || restore.textContent !== '返回') throw Error('Existing member cannot return to a full waiting room');
    fixtures[0].status='finished';renderRooms(fixtures);
    if(document.querySelector('[data-room-id="layout-full"]') || document.getElementById('selectedRoomName').textContent.includes('等待中的1v1')) throw Error('Finished selected room remains actionable in the lobby');
    fixtures[0].status='waiting';renderRooms(fixtures);
    document.getElementById('modeFilter').value='2v2'; filterLobbyRooms();
    if(document.querySelectorAll('.room-row').length !== 1 || !document.getElementById('selectedRoomName').textContent.includes('2v2')) throw Error('Mode selection/details failed');
    document.getElementById('modeFilter').value='all'; document.getElementById('stateFilter').value='watch'; filterLobbyRooms();
    if(document.querySelectorAll('.room-row').length !== 1 || !document.querySelector('.room-row .btn-spectate')) throw Error('Watch filter failed');
    document.getElementById('stateFilter').value='all'; document.getElementById('roomSearch').value='不存在';filterLobbyRooms();
    if(document.querySelectorAll('.room-row').length !== 0) throw Error('Search filter failed');
    document.getElementById('roomSearch').value='';renderRooms(fixtures);
  })()`)
  await pages[0].evaluate(`(async () => {
    const original = lobbyRequest;
    lobbyRequest = async () => ({id:'layout-invite',status:'waiting'});
    try {
      document.getElementById('inviteDialog').showModal(); document.getElementById('inviteInput').value='ABCDEF123456';
      await joinByCode(false);
      if(document.getElementById('inviteDialog').open || document.getElementById('factionSheet').style.display !== 'flex') throw Error('Invite modal blocks faction selection');
      closeFactionSheet();
    } finally { lobbyRequest = original }
  })()`)
  const lobby = await pages[0].call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, 'red196-room-browser.png'), Buffer.from(lobby.data, 'base64'))
  const ratings = await app.ranked.leaderboard()
  if (ratings.map(p => p.rating).sort().join(',') !== '1016,984') throw new Error('Unexpected Elo ratings')
  console.log(JSON.stringify({ ok: true, browser: path.basename(executable), flow: 'login -> queue -> secret veto -> map draw -> original roster -> progressive deployment -> actual battle surrender -> Elo/history', ratings, realEmailDelivery: false }))
} catch (error) {
  for (const [index, page] of pages.entries()) {
    try { console.error('page-state', index, await page.evaluate('({url:location.href,text:document.body.innerText.slice(-6000)})')) } catch {}
  }
  throw error
} finally {
  setupProcess?.kill()
  try { await browser?.call('Browser.close') } catch {}
  pages.forEach(page => page.close()); browser?.close(); chrome?.kill()
  await app?.close(); await pg.stop()
}
