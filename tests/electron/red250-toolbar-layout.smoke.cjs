'use strict'

// Production markup/CSS, isolated display fixtures; no game or account actions.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const root = path.resolve(__dirname, '../..')
const output = path.join(root, 'docs/qa/RED250')

async function main() {
  const { app, BrowserWindow, session } = require('electron')
  app.disableHardwareAcceleration()
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-toolbar-layout-')))
  const page = fs.readFileSync(path.join(root, 'data/pages/battle.html'), 'utf8')
  const styles = [...page.matchAll(/<style[^>]*>[\s\S]*?<\/style>|<link[^>]*rel=["']stylesheet["'][^>]*>/gi)].map(([tag]) => {
    if (tag.startsWith('<style')) return tag
    const href = tag.match(/href=["']([^"']+)/)?.[1]
    return href && !/^https?:/.test(href) ? `<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'data/pages', href)).href}">` : ''
  }).join('\n')
  const body = page.slice(page.indexOf('<body'), page.lastIndexOf('</body>') + 7).replace(/<script\b[\s\S]*?<\/script>/gi, '')
  const fixture = path.join(root, 'dist/red250-toolbar-fixture.html')
  fs.writeFileSync(fixture, `<!doctype html><meta charset="utf-8">${styles}${body}`)
  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true }))
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true } })
  const results = []
  try {
    for (const [width, height] of [[1280, 720], [844, 390], [667, 375], [600, 800]]) {
      win.setContentSize(width, height)
      for (const mode of ['training', 'network']) {
        await win.loadFile(fixture)
        await win.webContents.executeJavaScript(`(() => {
          document.querySelectorAll('body > :not(.topbar):not(#targetOverlay):not(script):not(style)').forEach(e => e.remove());
          document.querySelectorAll('.overlay').forEach(e => e.classList.remove('show'));
          document.getElementById('trainingSetupOverlay')?.classList.remove('show');
          for (const id of ${JSON.stringify(mode === 'training' ? ['btnSwitchPov', 'btnResetCD'] : ['btnSurrender', 'spectatingToggle', 'spectatorInvite'])}) {
            const e = document.getElementById(id); e.hidden = false; e.style.display = 'inline-flex';
          }
          const b = document.createElement('button'); b.className = 'social-toggle'; b.textContent = '便笺'; b.setAttribute('aria-label', '桌边便笺'); document.querySelector('.topbar').append(b);
          document.querySelectorAll('dialog[open]').forEach(e => e.close());
        })()`)
        await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
        const record = await win.webContents.executeJavaScript(`(() => {
          const bar = document.querySelector('.topbar'), s = getComputedStyle(bar), r = bar.getBoundingClientRect();
          return {wrap:s.flexWrap, overflowX:s.overflowX, overflowY:s.overflowY, width:r.width, height:r.height, scrollWidth:bar.scrollWidth, clientWidth:bar.clientWidth,
            buttons:[...bar.querySelectorAll('button')].filter(b=>getComputedStyle(b).display!=='none').map(b=>{ const q=b.getBoundingClientRect(); return {id:b.id||b.className,label:b.getAttribute('aria-label')||b.textContent.trim(),x:q.x,y:q.y,width:q.width,height:q.height,hit:b.contains(document.elementFromPoint(q.x+q.width/2,q.y+q.height/2))}; })};
        })()`)
        assert.equal(record.wrap, 'wrap')
        assert.equal(record.overflowX, 'visible')
        assert.equal(record.overflowY, 'visible')
        assert.ok(record.scrollWidth <= record.clientWidth + 1, JSON.stringify(record))
        for (const b of record.buttons) {
          assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= width + 1 && b.y + b.height <= height, JSON.stringify(b))
          assert.ok(b.width >= 42 && b.height >= 42, JSON.stringify(b))
          assert.ok(b.hit, JSON.stringify(b))
        }
        fs.writeFileSync(path.join(output, `toolbar-${mode}-${width}x${height}.png`), (await win.webContents.capturePage()).toPNG())
        await win.webContents.executeJavaScript(`(() => {
          document.body.classList.add('pending-response-waiting');
          document.getElementById('targetOverlay').classList.add('show');
          document.getElementById('targetPromptText').textContent = '你的行动触发了对方响应，请等待对方完成选择';
          document.getElementById('targetSelectionControls').classList.remove('show');
        })()`)
        const waiting = await win.webContents.executeJavaScript(`(() => {
          const p = document.getElementById('targetPromptText').getBoundingClientRect();
          return {prompt:{left:p.left,right:p.right,top:p.top,bottom:p.bottom},buttons:[...document.querySelectorAll('.topbar button')].filter(b=>getComputedStyle(b).display!=='none').map(b=>{const r=b.getBoundingClientRect();return {id:b.id,x:r.x,y:r.y,hit:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),clear:!(p.left<r.right && p.right>r.left && p.top<r.bottom && p.bottom>r.top)};})};
        })()`)
        assert.ok(waiting.buttons.every(b=>b.hit && b.clear), `waiting prompt overlaps toolbar: ${mode} ${width}x${height} ${JSON.stringify(waiting)}`)
        record.waitingPromptClear = waiting
        if (mode === 'network' && width === 844) fs.writeFileSync(path.join(output, 'toolbar-waiting-844x390.png'), (await win.webContents.capturePage()).toPNG())
        results.push({mode,viewportWidth:width,viewportHeight:height,...record})
      }
    }
    fs.writeFileSync(path.join(output, 'toolbar-layout-geometry.json'), JSON.stringify({fixture:true,notHumanAcceptance:true,results}, null, 2))
    console.log(JSON.stringify({scenarios:results.length,buttons:results.reduce((n,r)=>n+r.buttons.length,0)}))
  } finally { win.destroy(); app.quit() }
}

if (process.versions.electron) main().catch(e => { console.error(e); require('electron').app.exit(1) })
else {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [__filename], {cwd:root, env, stdio:'inherit', windowsHide:true})
  child.once('error', e => {console.error(e); process.exitCode=1})
  child.once('exit', code => {process.exitCode=code ?? 1})
}
