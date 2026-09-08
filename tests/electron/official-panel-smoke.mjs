import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { saveConfig, unprotectWindowsSecret } from '../../lib/server/official/windows-config.ts'
import { findFreePort } from '../../electron-client/local-port.ts'

const root = process.cwd(), built = path.join(root, 'dist/official-server/win-x64'), output = path.join(root, 'dist/multiplayer-qa')
fs.mkdirSync(output, { recursive: true })
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-panel-browser-')), port = await findFreePort(38972), debugPort = await findFreePort(19272)
saveConfig(path.join(state, 'official-config.json'), { port, maxMatches: 10, smtp: { host: 'smtp.example.test', port: 465, user: 'test@example.test', from: 'test@example.test', password: 'isolated-test-no-real-smtp' } })
const env = { ...process.env, RVB_OFFICIAL_STATE_ROOT: state, RVB_OFFICIAL_NO_BROWSER: '1' }
const hook = "data:text/javascript,process.channel?.unref();process.on('message',()=>{process.emit('SIGINT')})"
const server = spawn(path.join(built, 'node.exe'), ['--import', hook, path.join(built, 'server.mjs')], { cwd: built, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
const exited = once(server, 'exit'); let log = '', browser, chrome; const pages = []
server.stdout.on('data', x => { log += x }); server.stderr.on('data', x => { log += x })
async function until(check, label) { const end = Date.now() + 60000; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 200)) } throw new Error('Timeout: ' + label) }
async function cdp(url) {
  const ws = new WebSocket(url), calls = new Map(); let id = 0
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  const call = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id, timer = setTimeout(() => { calls.delete(key); reject(new Error('CDP timeout: ' + method)) }, 15000); calls.set(key, data => { clearTimeout(timer); if (data.error) reject(new Error(data.error.message)); else resolve(data.result) }); ws.send(JSON.stringify({ id: key, method, params })) })
  ws.addEventListener('message', event => { const data = JSON.parse(event.data); if (calls.has(data.id)) { calls.get(data.id)(data); calls.delete(data.id) } })
  return { call, close: () => ws.close(), evaluate: async expression => { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value } }
}
try {
  await until(() => fs.existsSync(path.join(state, 'panel-url.protected')), 'packaged panel ready')
  const url = unprotectWindowsSecret(fs.readFileSync(path.join(state, 'panel-url.protected')))
  if (log.includes(new URL(url).hash.slice(1))) throw new Error('Capability leaked to console')
  const lock = fs.readFileSync(path.join(state, 'official.lock'), 'utf8')
  const opener = spawn(path.join(built, 'node.exe'), [path.join(built, 'server.mjs'), '--panel'], { cwd: built, env, windowsHide: true, stdio: 'ignore' })
  if ((await once(opener, 'exit'))[0] !== 0 || fs.readFileSync(path.join(state, 'official.lock'), 'utf8') !== lock) throw new Error('Reopen restarted server or failed')
  for (const asset of ['/control-panel/index.html', '/api/snapshot', '/panel.js']) if ((await fetch(`http://127.0.0.1:${port}${asset}`)).ok) throw new Error('Player listener exposes admin asset/API')
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${path.join(state, 'browser')}`, `--remote-debugging-port=${debugPort}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  let version
  await until(async () => { try { version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(r => r.json()); return !!version.webSocketDebuggerUrl } catch { return false } }, 'Chrome ready')
  browser = await cdp(version.webSocketDebuggerUrl)
  const target = await browser.call('Target.createTarget', { url }), listing = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r => r.json())
  const page = await cdp(listing.find(x => x.id === target.targetId).webSocketDebuggerUrl); pages.push(page)
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await until(() => page.evaluate('document.getElementById("active")?.textContent === "0"'), 'live overview')
  if (!await page.evaluate('location.hash === "" && document.getElementById("connection").textContent.includes("运行中")')) throw new Error('Missing status or fragment not erased')
  await page.evaluate('document.fonts.ready.then(() => true)')
  fs.writeFileSync(path.join(output, 'red196-control-panel.png'), Buffer.from((await page.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await page.evaluate('document.querySelector("[data-view=accounts]").click()')
  await until(() => page.evaluate('document.getElementById("account-rows").textContent.includes("暂无记录")'), 'empty accounts')
  await page.evaluate('document.querySelector("[data-view=operations]").click();document.getElementById("maintenance").click()')
  await until(() => page.evaluate('document.getElementById("confirm").open'), 'confirmation')
  await page.evaluate('document.querySelector("button[value=cancel]").click()')
  if (!await page.evaluate('document.getElementById("maintenance-state").textContent.includes("开放")')) throw new Error('Cancel changed maintenance')
  await page.evaluate('document.getElementById("maintenance").click();document.getElementById("confirm-ok").click()')
  await until(() => page.evaluate('document.getElementById("maintenance-state").textContent.includes("已开启")'), 'maintenance persisted')
  await page.evaluate('document.getElementById("season-id").value="browser-season";document.getElementById("new-season").click();document.getElementById("confirm-ok").click()')
  await until(() => page.evaluate('document.getElementById("season-label").textContent === "browser-season"'), 'season changed')
  await page.evaluate('document.querySelector("[data-view=mail]").click();document.getElementById("mail-check").click()')
  await until(() => page.evaluate('document.getElementById("notice").textContent.includes("认证失败") && !document.getElementById("mail-check").disabled'), 'mail error recovery')
  await page.evaluate('document.querySelector("[data-view=audit]").click()')
  await until(() => page.evaluate('document.getElementById("audit-rows").textContent.includes("browser-season")'), 'audit persisted')
  await page.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  if (!await page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth')) throw new Error('Panel overflow at 390px')
  await page.evaluate('document.querySelector("[data-view=operations]").click();document.getElementById("stop").click();document.getElementById("confirm-ok").click()')
  await until(() => page.evaluate('document.getElementById("connection").textContent.includes("已接受")'), 'stop accepted')
  await until(() => server.exitCode !== null, 'graceful process exit')
  if ((await exited)[0] !== 0 || fs.existsSync(path.join(state, 'postgres/data/postmaster.pid')) || fs.existsSync(path.join(state, 'panel-url.protected'))) throw new Error('Shutdown left database or capability file alive')
  console.info('[panel-smoke] PASS: actual Windows package, DPAPI reopen, isolated admin origin, Chrome UI, confirmation/cancel, maintenance/season/audit, SMTP error, 390px, graceful stop and PG exit. No real mail sent.')
} finally {
  for (const page of pages) page.close()
  if (browser) { await browser.call('Browser.close').catch(() => {}); browser.close() } else chrome?.kill()
  if (server.exitCode === null && server.connected) { server.send('stop'); await exited }
  fs.writeFileSync(path.join(output, 'red196-panel-startup.txt'), log)
}
