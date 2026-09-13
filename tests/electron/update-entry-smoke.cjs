const assert = require('node:assert/strict')
const fs = require('node:fs')
const { chromium } = require(process.env.RVB_PLAYWRIGHT_MODULE || 'playwright')

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
        await button.click()
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
    const menu = fs.readFileSync('data/pages/index.html', 'utf8')
    assert.ok(menu.includes("sessionStorage.setItem('rvb_maintenance_section', 'resources')"))
    assert.ok(!menu.includes('android-maintenance.html#'))
    assert.ok(!menu.includes("textContent = '更新与资源'"))
    const maintenance = fs.readFileSync('data/pages/android-maintenance.html', 'utf8')
    assert.ok(maintenance.includes('id="updates"')); assert.ok(maintenance.includes('id="resources"'))
    assert.ok(maintenance.includes("sessionStorage.removeItem('rvb_maintenance_section')"))
    console.log('PASS: Android and Windows shared entry; immediate Windows dialog; browser hidden; resource navigation')
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
