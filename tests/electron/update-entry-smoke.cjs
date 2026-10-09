const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium } = require(process.env.RVB_PLAYWRIGHT_MODULE || 'playwright')

const compatibilityPresentation = fs.readFileSync('data/pages/js/compatibility-presentation.js', 'utf8')
const profileFixture = `({ schemaVersion: 'rvb-game-profile-identity/v1', engineAbi: 'rvb-engine/v1', runnerRevision: 'rvb-battle-runner/v1', resolvedProfileHash: '${'a'.repeat(64)}', authorityContentHash: '${'b'.repeat(64)}' })`

async function serveActualPage(page, pageName) {
  const html = fs.readFileSync('data/pages/' + pageName, 'utf8')
  await page.route('https://rvb.test/**', route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/' + pageName) return route.fulfill({ contentType: 'text/html', body: html })
    if (pathname === '/js/compatibility-presentation.js') return route.fulfill({ contentType: 'application/javascript', body: compatibilityPresentation })
    if (pathname.endsWith('.js')) return route.fulfill({ contentType: 'application/javascript', body: '' })
    return route.fulfill({ status: 404, body: '' })
  })
}

function installOverlayFixture(page, kind) {
  const source = `(() => {
    const profile = ${profileFixture}
    const identity = { id: 'qa-player', displayName: 'QA 玩家' }
    const listeners = {}
    const mismatch = () => { const error = new Error('ABI 不兼容'); error.code = 'ENGINE_ABI_MISMATCH'; return error }
    window.alert = message => { window.__alerts = (window.__alerts || []).concat(String(message)) }
    window.RvBIdentity = { getIdentity: () => identity, ensureIdentity: async () => identity }
    window.RvBUtils = {
      getServerUrl: () => ${kind === 'lobby' ? "'https://server.test'" : "''"},
      getServerModeForUrl: () => 'remote',
      saveServerConfig: () => {},
      appendServerParams: params => params,
      getConnectionConfig: () => ({ url: 'https://server.test', mode: 'remote' }),
    }
    if (${kind === 'index'}) {
      window.RvBLanDiscover = { startLanScan: () => ({ cancel: () => {} }) }
      window.RvBColyseus = {
        requestAt: async (_url, method) => method === 'system.health' ? { ok: true, protocol: 'rvb-colyseus' } : { rooms: [] },
        requestCatalogIdentityAt: async () => { throw mismatch() },
      }
    } else {
      window.RvBColyseus = {
        on: (name, listener) => { listeners[name] = listener },
        connect: () => { if (listeners.connect) listeners.connect() },
        isConnected: () => true,
        request: async method => {
          if (method === 'maps.list') return { maps: [{ id: 'qa-map', name: 'QA 地图' }] }
          if (method === 'rooms.list') return { rooms: [] }
          throw mismatch()
        },
        requestCatalogIdentityAt: async () => ({ profileIdentity: profile }),
      }
    }
  })()`
  return page.addInitScript({ content: source })
}

async function main() {
  const browser = await chromium.launch({ headless: true, channel: process.env.RVB_BROWSER_CHANNEL || 'msedge' })
  try {
    for (const platform of ['android', 'windows', 'browser']) {
      const page = await browser.newPage({ viewport: { width: 1264, height: 760 } })
      await page.route('https://rvb.test/**', route => route.fulfill({ contentType: 'text/html', body: '<header class="header"><button id="userPill">玩家</button></header>' }))
      await page.goto('https://rvb.test/index.html')
      await page.evaluate(platform => {
        window.Capacitor = { isNativePlatform: () => platform === 'android' }
        window.loadPage = url => { window.clickedTarget = url }
        if (platform === 'windows') window.electronAPI = {
          getOfficialUpdateStatus: () => new Promise(() => {}),
          onOfficialUpdateStatus: () => () => {},
        }
      }, platform)
      await page.addScriptTag({ content: fs.readFileSync('data/pages/js/official-updates.js', 'utf8') })
      const button = page.locator('.official-update-entry')
      assert.equal(await button.count(), platform === 'browser' ? 0 : 1, platform + ' update entry')
      if (platform !== 'browser') {
        assert.equal(await button.getAttribute('aria-label'), '官方更新')
        assert.equal(await button.evaluate(el => el.previousElementSibling.id), 'userPill')
        const bounds = await button.boundingBox()
        assert.equal(bounds.width, 36); assert.equal(bounds.height, 36)
        if (platform === 'windows') {
          assert.equal(await page.locator('dialog').evaluate(el => el.open), true, 'startup check opens first')
          assert.equal(await page.locator('[data-recovery]').count(), 1, 'resource recovery remains reachable')
        } else await button.click()
        if (platform === 'android') {
          const target = await page.evaluate(() => window.clickedTarget)
          assert.equal(target, 'android-maintenance.html')
          assert.equal(await page.evaluate(() => sessionStorage.getItem('rvb_maintenance_section')), 'updates')
          // The Android activity uses an exact URL gate; fragments/queries
          // would display the page but deny every native maintenance method.
          const activity = fs.readFileSync('android/app/src/uiAcceptance/java/com/redvsblue/client/UiAcceptanceActivity.java', 'utf8')
          const trusted = activity.match(/"(https:\/\/localhost\/android-maintenance\.html)"\.equals\(url\)/)?.[1]
          assert.ok(trusted); assert.equal(new URL(target, 'https://localhost/index.html').href, trusted)
          assert.equal(await button.getAttribute('aria-haspopup'), null)
          assert.equal(await page.locator('dialog').count(), 0)
        } else assert.equal(await page.locator('dialog').evaluate(el => el.open), true)
      }
      await page.close()
    }
    const recovery = await browser.newPage();
    await recovery.route('https://rvb.test/**', route => route.fulfill({ contentType: 'text/html', body: '<header class="header"></header>' }));
    await recovery.goto('https://rvb.test/index.html');
    await recovery.evaluate(() => {
      let ready = false;
      let current = false;
      const status = () => ({ startupPending: !window.entered, canEnter: ready && current, clientVersion: 'test', resource: { phase: current ? 'current' : 'error', message: 'resource' }, client: { phase: 'current', message: 'client' } });
      window.electronAPI = {
        getOfficialUpdateStatus: async () => status(),
        onOfficialUpdateStatus: () => () => {},
        checkOfficialUpdates: async () => {},
        getMode: async () => ({ ready, localAuthorityRecovery: { status: 'failed' } }),
        ensureLocalAuthority: async () => { ready = true; current = true; return { ok: true }; },
        enterAfterUpdateCheck: async () => { window.entered = true; return { ...status(), startupPending: false }; },
      };
    });
    await recovery.addScriptTag({ content: fs.readFileSync('data/pages/js/official-updates.js', 'utf8') });
    await recovery.locator('[data-local-retry]').waitFor({ state: 'visible' });
    assert.equal(await recovery.locator('[data-close]').isDisabled(), true);
    assert.equal(await recovery.locator('[data-check]').textContent(), '重试更新检查');
    await recovery.locator('[data-local-retry]').click();
    await recovery.locator('[data-close]:enabled').waitFor();
    await recovery.locator('[data-close]').click();
    assert.equal(await recovery.evaluate(() => window.entered), true);
    assert.equal(await recovery.locator('dialog').evaluate(el => el.open), false);
    await recovery.close();
    const menu = fs.readFileSync('data/pages/index.html', 'utf8')
    assert.ok(menu.includes("sessionStorage.setItem('rvb_maintenance_section', 'resources')"))
    assert.ok(!menu.includes('android-maintenance.html#'))
    assert.ok(!menu.includes("textContent = '更新与资源'"))
    const maintenance = fs.readFileSync('data/pages/android-maintenance.html', 'utf8')
    assert.ok(maintenance.includes('id="updates"')); assert.ok(maintenance.includes('id="resources"'))
    assert.ok(maintenance.includes("sessionStorage.removeItem('rvb_maintenance_section')"))
    const requested = await browser.newPage({ viewport: { width: 1264, height: 760 } })
    await requested.route('https://rvb.test/**', route => route.fulfill({ contentType: 'text/html', body: '<header class="header"></header>' }))
    await requested.goto('https://rvb.test/index.html')
    await requested.evaluate(() => {
      const status = () => ({ startupPending: false, canEnter: true, clientVersion: 'test', automatic: false, source: 'github', sourceLocked: false, resource: { phase: 'current', message: 'resource' }, client: { phase: 'current', message: 'client' } })
      window.emitStatus = () => window.statusListener(status())
      window.electronAPI = {
        getOfficialUpdateStatus: async () => status(),
        onOfficialUpdateStatus: listener => { window.statusListener = listener; return () => {} },
        getMode: async () => ({ ready: true, localAuthorityRecovery: { status: 'ready' } }),
      }
      sessionStorage.setItem('rvb_compatibility_update_entry', 'client')
    })
    await requested.addScriptTag({ content: fs.readFileSync('data/pages/js/compatibility-presentation.js', 'utf8') })
    await requested.addScriptTag({ content: fs.readFileSync('data/pages/js/official-updates.js', 'utf8') })
    await requested.locator('dialog').waitFor({ state: 'visible' })
    assert.equal(await requested.locator('[data-compatibility]').textContent(), '联机检查发现客户端版本不兼容，请检查客户端更新。')
    await requested.locator('[data-close]').evaluate(button => { button.click(); window.emitStatus() })
    assert.equal(await requested.locator('dialog').evaluate(el => el.open), false, 'compatibility entry can close')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(await requested.locator('dialog').evaluate(el => el.open), false, 'closed compatibility entry stays closed after status updates')
    await requested.close()
    const lanOverlay = await browser.newPage({ viewport: { width: 1264, height: 760 } })
    await serveActualPage(lanOverlay, 'index.html')
    await installOverlayFixture(lanOverlay, 'index')
    await lanOverlay.goto('https://rvb.test/index.html')
    await lanOverlay.evaluate(() => window.showJoinSheet())
    assert.equal(await lanOverlay.locator('#lanOverlay').evaluate(el => el.classList.contains('show')), true, 'LAN sheet opens')
    await lanOverlay.evaluate(() => window.connectLanServer('https://lan.test'))
    const lanEntry = lanOverlay.locator('#lanCompatibilityRecovery [data-compatibility-entry="client"]')
    await lanEntry.waitFor({ state: 'visible' })
    assert.equal(await lanEntry.isVisible(), true, 'LAN compatibility entry remains visible inside overlay')
    await lanOverlay.evaluate(() => history.replaceState({}, '', '/source.html'))
    await lanEntry.click()
    await lanOverlay.waitForURL('**/index.html')
    assert.equal(await lanOverlay.evaluate(() => sessionStorage.getItem('rvb_compatibility_update_entry')), 'client', 'LAN entry is clickable')
    await lanOverlay.close()

    const createOverlay = await browser.newPage({ viewport: { width: 1264, height: 760 } })
    await serveActualPage(createOverlay, 'lobby.html')
    await installOverlayFixture(createOverlay, 'lobby')
    await createOverlay.goto('https://rvb.test/lobby.html?create=1')
    await createOverlay.evaluate(() => window.openCreateSheet())
    assert.equal(await createOverlay.locator('#createSheet').evaluate(el => el.style.display), 'flex', 'create sheet opens')
    await createOverlay.evaluate(() => window.doCreateRoom())
    const createEntry = createOverlay.locator('#createCompatibilityRecovery [data-compatibility-entry="client"]')
    await createEntry.waitFor({ state: 'visible' })
    assert.equal(await createEntry.isVisible(), true, 'create compatibility entry remains visible inside sheet')
    await createEntry.click()
    await createOverlay.waitForURL('**/index.html')
    assert.equal(await createOverlay.evaluate(() => sessionStorage.getItem('rvb_compatibility_update_entry')), 'client', 'create entry is clickable')
    await createOverlay.close()
    console.log('PASS: Android and Windows shared entry; immediate Windows dialog; browser hidden; resource navigation; LAN/create overlay entries')
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
