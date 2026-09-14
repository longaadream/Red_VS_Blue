const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const root = path.resolve(__dirname, '../..')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' })
  child.on('error', error => { console.error(error); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow } = require('electron')
  app.disableHardwareAcceleration()
  app.setPath('userData', path.join(root, 'dist/battle-followup-profile'))
  app.whenReady().then(async () => {
    const timer = setTimeout(() => app.exit(1), 30000)
    const output = path.join(root, 'docs/qa/battle-followup')
    fs.mkdirSync(output, { recursive: true })
    const pages = path.join(root, 'data/pages')
    const source = fs.readFileSync(path.join(pages, 'piece-selection.html'), 'utf8')
    const inline = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1]
    const ids = JSON.parse(fs.readFileSync(path.join(root, 'data/pieces/manifest.json'), 'utf8'))
    const resources = Object.fromEntries(ids.map(id => ['data/pieces/' + id + '.json', JSON.parse(fs.readFileSync(path.join(root, 'data/pieces', id + '.json'), 'utf8'))]))
    resources['data/pieces/manifest.json'] = ids
    const bootstrap = `const resources=${JSON.stringify(resources).replace(/</g, '\\u003c')};
      window.fetchPackJson=async name=>resources[name.startsWith('./')?name.slice(2):name];
      localStorage.setItem('rvb_game_profile_identity','{}');
      window.RvBUtils={getServerUrl:()=>'',appendServerParams:p=>p};
      window.RvBColyseus={on:()=>{},connect:()=>{},isConnected:()=>true,request:async()=>({alignment:'dark',faction:'blue'})};`
    const html = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
      .replace('<head>', '<head><base href="' + pathToFileURL(pages + path.sep) + '">')
      .replace('</body>', `<script>${bootstrap}</script><script src="js/deck-presets.js"></script><script>${inline}</script></body>`)
    const fixture = path.join(root, 'dist/battle-followup-selection.html')
    fs.mkdirSync(path.dirname(fixture), { recursive: true }); fs.writeFileSync(fixture, html)
    const win = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
    await win.loadURL(pathToFileURL(fixture).href + '?roomId=test-dark&playerId=alice&alignment=dark')
    await win.webContents.executeJavaScript('init()')
    const result = await win.webContents.executeJavaScript(`(()=>{
      const evil=PIECE_TEMPLATES.filter(p=>p.faction==='evil');
      if(evil.length<8)throw new Error('Missing dark pieces');
      selectedIds=new Set(evil.slice(0,8).map(p=>p.id));
      document.getElementById('deckPresetName').value='暗方测试棋组';savePreset();newPreset();choosePresetCard(0);
      return {alignment:playerAlignment,count:selectedIds.size,preset:document.getElementById('deckPresetName').value};
    })()`)
    assert.deepEqual(result, { alignment: 'dark', count: 8, preset: '暗方测试棋组' })
    const layouts = []
    for (const [width, height] of [[1280,720],[844,390],[390,844]]) {
      win.setContentSize(width,height)
      await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const layout = await win.webContents.executeJavaScript(`(()=>{
        const title=document.querySelector('.deck-builder-title');title.scrollIntoView({block:'nearest'});
        const box=title.getBoundingClientRect();return {display:getComputedStyle(title).display,text:title.textContent,visible:box.width>0&&box.height>0&&box.top>=0&&box.bottom<=innerHeight};
      })()`)
      assert.equal(layout.display, 'block'); assert.equal(layout.text, '棋组构筑'); assert.equal(layout.visible, true)
      fs.writeFileSync(path.join(output, 'dark-' + width + 'x' + height + '.png'), (await win.webContents.capturePage()).toPNG())
      layouts.push({ width,height,...layout })
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ result, layouts }, null, 2))
    console.log('Dark room builder: eight-piece save/reload and three viewport layouts passed.')
    clearTimeout(timer); win.destroy(); app.quit()
  }).catch(error => { console.error(error); app.exit(1) })
}
