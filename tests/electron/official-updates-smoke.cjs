const { app, BrowserWindow, ipcMain, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const root = process.env.RVB_UPDATE_SMOKE_ROOT
const output = process.env.RVB_UPDATE_SMOKE_OUTPUT
app.setPath('userData', process.env.RVB_UPDATE_SMOKE_USER_DATA)
// Reproduce the real client's game-only direct policy.
app.commandLine.appendSwitch('no-proxy-server')
if (process.env.RVB_UPDATE_SMOKE_PROXY) process.env.RVB_UPDATE_PROXY = process.env.RVB_UPDATE_SMOKE_PROXY
app.whenReady().then(async () => {
  const { NsisUpdater } = require(path.join(root, 'electron-client/dist/update-runtime.cjs'))
  const runtime = new NsisUpdater({ provider: 'github', owner: 'longaadream', repo: 'Red_VS_Blue' })
  assert.equal(typeof runtime.checkForUpdates, 'function')
  let state = { automatic: true, clientVersion: '0.1.0', resource: { phase: 'current', message: '官方资源更新已应用', version: '0.0.123' }, client: { phase: 'current', message: '客户端已是当前稳定版本' } }
  const calls = []
  ipcMain.handle('official-update-status', () => state)
  ipcMain.handle('official-update-automatic', (_event, enabled) => { calls.push('setting'); state.automatic = enabled; return state })
  ipcMain.handle('official-update-check', () => { calls.push('check'); state.client = { phase: 'downloaded', message: '客户端更新已下载，返回主菜单后可重启安装', version: '0.2.0' }; return state })
  ipcMain.handle('official-update-install', () => { calls.push('install-request'); return { cancelled: true } })
  const win = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(root, 'electron-client/dist/preload.js') } })
  // Real menu markup, CSS reset and tabletop theme; gameplay scripts are omitted.
  const menu = fs.readFileSync(path.join(root, 'data/pages/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'data/pages/')).href + '">')
  const menuFile = path.join(process.env.RVB_UPDATE_SMOKE_USER_DATA, 'menu.html')
  fs.writeFileSync(menuFile, menu)
  await win.loadFile(menuFile)
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'data/pages/js/official-updates.js'), 'utf8'))
  await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.official-update-entry').click();
    await new Promise(r => setTimeout(r, 100));
    if (!document.querySelector('dialog').open) throw Error('panel missing');
    document.querySelector('[data-automatic]').click();
    await new Promise(r => setTimeout(r, 100));
    document.querySelector('[data-check]').click();
    await new Promise(r => setTimeout(r, 100));
    if (document.querySelector('[data-install]').hidden) throw Error('install button missing');
    document.querySelector('[data-install]').click();
    await new Promise(r => setTimeout(r, 100));
  })()`)
  assert.deepEqual(calls, ['setting', 'check', 'install-request'])
  assert.equal(state.automatic, false)
  const layout = await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('.official-update-entry').getBoundingClientRect();
    const dialog = document.querySelector('dialog').getBoundingClientRect();
    const check = document.querySelector('[data-check]').getBoundingClientRect();
    const close = document.querySelector('[data-close]').getBoundingClientRect();
    return { buttonWidth:button.width, buttonHeight:button.height, x:dialog.x, y:dialog.y, width:dialog.width, height:dialog.height, viewportWidth:innerWidth, viewportHeight:innerHeight, checkY:check.y, closeY:close.y };
  })()`)
  assert.equal(layout.buttonWidth, 36)
  assert.equal(layout.buttonHeight, 36)
  assert.ok(Math.abs(layout.x - (layout.viewportWidth-layout.width)/2) < 2)
  assert.ok(Math.abs(layout.y - (layout.viewportHeight-layout.height)/2) < 2)
  assert.equal(layout.checkY, layout.closeY)
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  fs.writeFileSync(path.join(output, 'official-updates.png'), (await win.webContents.capturePage()).toPNG())
  // Exercise the exact renderer confirmation call used after profile activation.
  const { assertOfficialUpdateIpcAllowed } = require(path.join(root, 'electron-client/dist/official-update-ipc.js'))
  ipcMain.handle('pack-list', () => {
    assertOfficialUpdateIpcAllowed('pack-list', true)
    return { state: { stable: { resolvedProfileHash: 'a'.repeat(64) } }, server: { healthy: true, profile: { resolvedProfileHash: 'a'.repeat(64) } } }
  })
  const handshake = await win.webContents.executeJavaScript('window.electronAPI.packList()')
  assert.equal(handshake.server.healthy, true)
  const result = { runtimeBundle: 'loaded real NsisUpdater', renderer: 'real themed menu, sandboxed preload, settings/check/restart-request pass', layout, actualInstallation: false, publicResource: null }
  const { prepareOfficialUpdateNetwork } = require(path.join(root, 'electron-client/dist/official-update-fetch.js'))
  const updateNetwork = await prepareOfficialUpdateNetwork()
  assert.equal(runtime.netSession, updateNetwork)
  result.gameProxy = await session.defaultSession.resolveProxy('https://api.github.com')
  result.updateProxy = await updateNetwork.resolveProxy('https://api.github.com')
  result.networkConfiguration = process.env.RVB_UPDATE_PROXY ? 'explicit launcher proxy' : 'system'
  assert.equal(result.gameProxy, 'DIRECT')
  if (process.env.RVB_UPDATE_SMOKE_PROXY) assert.notEqual(result.updateProxy, 'DIRECT')
  if (process.env.RVB_UPDATE_SMOKE_NETWORK === '1') {
    const { OfficialResourceUpdates } = require(path.join(root, 'electron-client/dist/official-resource-updates.js'))
    const pins = JSON.parse(fs.readFileSync(path.join(root, 'config/content-script-publishers.json'))).keyIds
    const { officialUpdateFetch } = require(path.join(root, 'electron-client/dist/official-update-fetch.js'))
    const updater = new OfficialResourceUpdates(officialUpdateFetch, '0.1.0', pins, {
      stable: async () => ({ kind: 'bundled-base', resolvedProfileHash: '0'.repeat(64), version: '0.1.0', compatibility: { engineAbi: 'rvb-engine/v1', contentAbi: 'rvb-content/v1' } }),
      canApply: async () => false,
      apply: async () => { throw new Error('This read-only smoke must never install') },
      applied: () => { throw new Error('Must not apply') },
    })
    result.publicResource = await updater.check()
    assert.equal(result.publicResource.phase, 'waiting', JSON.stringify(result.publicResource))
  }
  fs.writeFileSync(path.join(output, result.publicResource ? 'result-network.json' : 'result.json'), JSON.stringify(result, null, 2))
  win.destroy(); app.exit(0)
}).catch(error => { fs.writeFileSync(path.join(output, 'error.txt'), String(error.stack || error)); app.exit(1) })
