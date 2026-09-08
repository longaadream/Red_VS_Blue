import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { EmbeddedPostgresController } from '../../electron-client/embedded-postgres.ts'
import { findFreePort } from '../../electron-client/local-port.ts'
import { createOfficialServer } from '../../lib/server/official/server.ts'

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
let app, browser, chrome
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
  for (const user of users) {
    const context = await browser.call('Target.createBrowserContext')
    const target = await browser.call('Target.createTarget', { url: origin + '/official.html', browserContextId: context.browserContextId })
    const listing = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r => r.json())
    const page = await cdp(listing.find(item => item.id === target.targetId).webSocketDebuggerUrl); pages.push(page)
    await page.call('Page.enable')
    await page.call('Emulation.setDeviceMetricsOverride', { width:1200,height:1400,deviceScaleFactor:1,mobile:false })
    await until(() => page.evaluate('!!document.getElementById("authForm") && document.getElementById("message").textContent.includes("已连接")'), 'official login page')
    await page.evaluate(`document.getElementById('email').value=${JSON.stringify(user.email)};document.getElementById('password').value=${JSON.stringify(password)};document.querySelector('#authForm button').click()`)
    await until(() => page.evaluate('document.getElementById("profile").hidden === false'), 'account login')
    if (user === users[0]) await page.evaluate('document.getElementById("alignment").value="dark"')
    await page.evaluate('document.getElementById("join").click()')
  }
  for (const page of pages) {
    await until(() => page.evaluate('document.getElementById("enter").hidden === false'), 'matchmaking')
    await page.evaluate('document.getElementById("enter").click()')
    await until(() => page.evaluate('!!document.getElementById("readyBtn") && !document.getElementById("readyBtn").disabled'), 'room admission')
    await page.evaluate('document.getElementById("readyBtn").click()')
  }
  for (const page of pages) {
    await until(() => page.evaluate('location.pathname.endsWith("piece-selection.html") && document.querySelectorAll(".piece-card").length >= 8'), 'roster page')
    await page.evaluate(`while(document.querySelectorAll('.piece-card.selected').length<8){const next=document.querySelector('.piece-card:not(.selected)');if(!next)break;next.click()}`)
    await until(() => page.evaluate('!document.getElementById("confirmBtn").disabled'), 'legal roster')
    await page.evaluate('document.getElementById("confirmBtn").click()')
  }
  for (const page of pages) await until(() => page.evaluate('location.pathname.endsWith("battle.html") && typeof G!=="undefined" && !!G && typeof colyseusConnected!=="undefined" && colyseusConnected'), 'live battle', 60000)
  // Dark roster remains authoritative after logout/relogin, even though the entry defaults to light.
  await pages[0].call('Page.navigate', { url: origin + '/official.html' })
  await until(() => pages[0].evaluate('!!document.getElementById("profile") && !document.getElementById("profile").hidden'), 'return to account')
  await pages[0].evaluate('document.getElementById("logout").click()')
  await until(() => pages[0].evaluate('!document.getElementById("auth").hidden'), 'logout')
  await pages[0].evaluate(`document.getElementById('email').value=${JSON.stringify(users[0].email)};document.getElementById('password').value=${JSON.stringify(password)};document.querySelector('#authForm button').click()`)
  await until(() => pages[0].evaluate('!document.getElementById("profile").hidden && !document.getElementById("enter").hidden'), 'login during battle')
  await pages[0].evaluate('document.getElementById("enter").click()')
  await until(() => pages[0].evaluate('location.pathname.endsWith("battle.html") && typeof G!=="undefined" && !!G && typeof colyseusConnected!=="undefined" && colyseusConnected'), 'dark roster reentry', 60000)
  const screenshot = await pages[0].call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, 'red196-official-battle.png'), Buffer.from(screenshot.data, 'base64'))
  await pages[0].evaluate('document.getElementById("btnSurrender").click()')
  await pages[0].evaluate(`document.querySelector('[onclick="doSurrender()"]').click()`)
  await until(async () => (await app.pool.query(`SELECT 1 FROM official_matches WHERE status='settled'`)).rowCount === 1, 'actual page action and Elo settlement')
  for (const page of pages) { await page.call('Page.navigate', { url: origin + '/official.html' }); await until(() => page.evaluate('!!document.getElementById("profile") && !document.getElementById("profile").hidden && document.getElementById("record").textContent.includes("1 场")'), 'settled account UI') }
  const result = await pages[0].call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, 'red196-official-result.png'), Buffer.from(result.data, 'base64'))
  const ratings = await app.ranked.leaderboard()
  if (ratings.map(p => p.rating).sort().join(',') !== '1016,984') throw new Error('Unexpected Elo ratings')
  console.log(JSON.stringify({ ok: true, browser: path.basename(executable), flow: 'login -> queue -> room -> roster -> actual battle surrender -> Elo/history', ratings, realEmailDelivery: false }))
} catch (error) {
  for (const [index, page] of pages.entries()) {
    try { console.error('page-state', index, await page.evaluate('({url:location.href,text:document.body.innerText.slice(-6000)})')) } catch {}
  }
  throw error
} finally {
  try { await browser?.call('Browser.close') } catch {}
  pages.forEach(page => page.close()); browser?.close(); chrome?.kill()
  await app?.close(); await pg.stop()
}
