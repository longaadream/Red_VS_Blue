// Local documentation screenshots; reuse the existing RED-186 training fixture.
// Run the existing docs/qa/RED-186/serve.cjs on RVB_SKIN_PORT=4197 first.
// PLAYWRIGHT_MODULE may point to a separately installed Playwright package.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const fs = require('node:fs')
const path = require('node:path')

async function main() {
  const output = path.resolve(__dirname, '../media')
  fs.mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ headless: true, channel: 'msedge' })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
    const failures = []
    page.on('pageerror', error => failures.push(error.message))
    for (const [name, route] of [
      ['menu', 'index.html'],
      ['battle', 'battle.html?mode=training&sample=1'],
    ]) {
      await page.goto('http://127.0.0.1:4197/' + route, { waitUntil: 'networkidle' })
      await page.evaluate(() => document.fonts.ready)
      if (name === 'battle') {
        await page.waitForFunction(() => typeof G !== 'undefined' && G && G.pieces.length >= 6, { timeout: 30000 })
        // Let the native turn transition finish before taking the still.
        await page.waitForTimeout(2500)
      }
      await page.screenshot({ path: path.join(output, name + '.png') })
      console.log(name, await page.title())
    }
    console.log(JSON.stringify({ pageErrors: failures }))
    if (failures.length) process.exitCode = 1
  } finally {
    await browser.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
