// Capture real skill execution frames with the browser clock paused between beats.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const path = require('node:path')
const fs = require('node:fs')
async function main() {
  const media = path.resolve(__dirname, '../media')
  const frames = path.resolve(__dirname, '../../output/homepage-preview/combat-frames')
  fs.mkdirSync(frames, { recursive: true })
  const browser = await chromium.launch({ headless: true, channel: 'msedge' })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    await page.clock.install()
    page.on('pageerror', error => console.log('PAGE ERROR', error.message))
    await page.goto('http://127.0.0.1:4197/battle.html?mode=training&sample=1', { waitUntil: 'networkidle' })
    await page.waitForFunction(() => typeof G !== 'undefined' && G && G.pieces.length >= 6)
    await page.waitForTimeout(2500)
    await page.mouse.move(960, 560)
    await page.mouse.wheel(0, -560)
    await page.waitForTimeout(700)
    await page.addStyleTag({ content: `
      html,body{background:transparent!important}body,body *{visibility:hidden!important}
      #boardStage3d,#boardStage3d canvas,#hpBarLayer3d,#hpBarLayer3d *,.dmg-float,.battle-comic-beat,.battle-comic-beat *{visibility:visible!important}
      #boardStage3d{background:transparent!important}
      .dmg-float{animation:none!important;opacity:1!important;font-size:52px!important;transform:rotate(-10deg)!important}
    ` })
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100))
    const result = await page.evaluate(async () => {
      const caster = G.pieces.find(p => p.templateId === 'red-sasuke')
      const before = G.pieces.map(p => ({ id: p.instanceId, name: p.name, x: p.x, y: p.y, hp: p.currentHp }))
      const Engine = await window.RvBGameEngine.ensure()
      const probe = BattleLegalActions.probeSkillTarget({ snapshot: G, playerId: myPlayerId, pieceId: caster.instanceId, skillId: 'sasuke-chidori', skillsById, engine: Engine })
      if (!probe.preparation) throw new Error('Missing authoritative target preparation: ' + JSON.stringify(probe))
      await doAction({ type: 'useBasicSkill', playerId: myPlayerId, pieceId: caster.instanceId, skillId: 'sasuke-chidori', targetX: 12, targetY: 11, selectionId: probe.preparation.selectionId, stateRevision: probe.preparation.stateRevision })
      return { before, after: G.pieces.map(p => ({ id: p.instanceId, name: p.name, x: p.x, y: p.y, hp: p.currentHp })), events: latestBattlePresentationEvents, status: document.getElementById('statusMsg')?.textContent, pending: pendingSkill }
    })
    const target = result.after.find(piece => piece.id === 'training-blue-3')
    const caster = result.after.find(piece => piece.id === 'training-red-3')
    if (target?.hp !== 8 || caster?.x !== 12 || caster?.y !== 11) throw new Error('Unexpected skill result')
    console.log('Captured actual Chidori result: target HP 8, caster position (12,11)')
    fs.writeFileSync(path.join(media,'combat-capture.json'), JSON.stringify(result,null,2)+'\n')
    let previous = 0
    for (const ms of [1400, 2650]) {
      await page.clock.runFor(ms - previous); previous = ms
      const visible = await page.locator('.dmg-float,.battle-comic-beat').allTextContents()
      console.log(ms, visible)
      await page.screenshot({ path: path.join(frames, 'combat-' + ms + '.png'), omitBackground: true })
      if (ms === 1400) await page.screenshot({ path: path.join(media, 'combat-path.png'), omitBackground: true })
      if (ms === 2650) {
        if (!visible.includes('−4')) throw new Error('Expected native damage floater was not captured')
        await page.screenshot({ path: path.join(media, 'combat-impact.png'), omitBackground: true })
      }
    }
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
