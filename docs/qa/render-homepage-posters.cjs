// Compose captured game frames without redrawing character or board artwork.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
  const media = path.resolve(__dirname, '../media')
  const browser = await chromium.launch({ headless: true, channel: 'msedge' })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 })
    await page.goto(pathToFileURL(path.join(media, 'posters.html')).href)
    await page.evaluate(() => document.fonts.ready)
    const images = await page.locator('img').evaluateAll(items => items.map(item => ({
      source: item.getAttribute('src'), loaded: item.complete && item.naturalWidth > 0,
    })))
    if (images.some(item => !item.loaded)) throw new Error('Missing original screenshot: ' + JSON.stringify(images))
    for (const name of ['hero', 'feature']) {
      await page.locator('#' + name).screenshot({ path: path.join(media, name + '.png') })
    }
    console.log(JSON.stringify({ screenshotSources: images, output: ['hero.png', 'feature.png'] }))
  } finally {
    await browser.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
