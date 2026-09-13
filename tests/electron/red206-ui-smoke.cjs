/* Headless DOM/layout checks against the production tutorial CSS and character dock. */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const root = path.resolve(__dirname, '../..')
const output = path.join(root, 'docs/qa/RED-206-ui')
if (!process.versions.electron) {
  const { spawn } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' })
  child.on('error', error => { console.error(error); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow } = require('electron')
  app.disableHardwareAcceleration()
  app.setPath('userData', path.join(root, 'dist/red206-ui-profile'))
  app.whenReady().then(async () => {
    fs.mkdirSync(path.join(output, 'images'), { recursive: true })
    for (const id of ['aizen', 'itachi']) fs.copyFileSync(path.join(root, 'public', id + '.jpg'), path.join(output, 'images', id + '.jpg'))
    const pages = path.join(root, 'data/pages')
    const battle = fs.readFileSync(path.join(pages, 'battle.html'), 'utf8')
    const styles = [...battle.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map(match => match[0]).join('\n')
    const css = [...battle.matchAll(/<link[^>]*href="([^"]+\.css)"[^>]*>/g)].map(match => match[1])
      .filter(href => !/^(https?:)?\/\//.test(href))
      .map(href => `<link rel="stylesheet" href="${pathToFileURL(path.join(pages, href))}">`).join('\n')
    const fixture = path.join(root, 'dist', 'red206-ui-fixture.html')
    fs.writeFileSync(fixture, `<!doctype html><meta charset="utf-8"><base href="${pathToFileURL(output + path.sep)}">${styles}${css}
      <link rel="stylesheet" href="${pathToFileURL(path.join(pages, 'css/tutorial.css'))}">
      <style>body{background:#8a755c}#pieceInfoModal{display:none}</style>
      <div id="pieceInfoModal"><div class="pi-layout"><div class="pi-sheet"><div class="pi-header"><div class="pi-title"><div id="pieceInfoName" class="pi-name"></div></div></div><div id="pieceInfoContent"></div></div><div id="pieceKeywordPanel"></div></div></div>`)
    const win = new BrowserWindow({ show: false, width: 1280, height: 720, useContentSize: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    const timer = setTimeout(() => { console.error('UI smoke timeout'); app.exit(1) }, 45000)
    await win.loadFile(fixture)
    await win.webContents.executeJavaScript(`
      window.selectedPieceId=null;window.currentPieceInfoId=null;window.currentPieceInfoSource='board';window.myPlayerId='me';
      window.pendingSkill=null;window.pendingCardAction=null;window.targetSubmissionPending=false;window.pendingActionFeedback=false;window.G={};
      window.PIECES_BY_ID={aizen:{image:'aizen.jpg'},itachi:{image:'itachi.jpg'}};
      window.pieceInfoDisplaySkills=()=>[];
      window.renderPieceInfoRecord=p=>{document.getElementById('pieceInfoName').textContent=p.name;document.getElementById('pieceInfoModal').style.display='flex'};
      window.renderDeploymentPieceInfoError=window.renderPieceInfoRecord;
      for(const name of ['renderPieceContextMenu','showPieceInfo','closePieceInfo','render','setStatusMsg','handlePieceInfoModalKeydown'])window[name]=()=>{};void 0;
    `)
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(pages, 'tabletop-battle/character-dock.js'), 'utf8'))
    const portrait = await win.webContents.executeJavaScript(`(async()=>{
      renderPieceInfoRecord({templateId:'aizen',name:'对方蓝染',ownerPlayerId:'other'});
      currentPieceInfoSource='deployment';renderPieceInfoRecord({templateId:'itachi',name:'部署候选：宇智波鼬'});
      const img=document.querySelector('.character-portrait');await img.decode();
      return {src:img.getAttribute('src'),alt:img.alt,hidden:img.hidden,width:img.naturalWidth};
    })()`)
    assert.equal(portrait.src, 'images/itachi.jpg'); assert.equal(portrait.hidden, false); assert.ok(portrait.width > 0)
    fs.writeFileSync(path.join(output, 'deployment-portrait.png'), (await win.webContents.capturePage()).toPNG())
    const missing = await win.webContents.executeJavaScript(`renderDeploymentPieceInfoError({templateId:'missing',name:'候选资料缺失'});({hidden:document.querySelector('.character-portrait').hidden,src:document.querySelector('.character-portrait').getAttribute('src')})`)
    assert.equal(missing.hidden, true); assert.equal(missing.src, null)
    await win.webContents.executeJavaScript(`document.getElementById('pieceInfoModal').style.display='none';document.body.classList.remove('character-dock-open');window.RvBTutorialLessons={all:[],observe:()=>[]};void 0;`)
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(pages, 'js/tutorial/tutorial-lesson-runtime.js'), 'utf8'))
    await win.webContents.executeJavaScript(`window.guide=RvBTutorialLessonRuntime.create({number:1,title:'基础操作',intro:'先点击亮起的乌瑟尔。选中棋子后，可以看到他的生命和可用技能。这里只是查看，还不会消耗行动点。',help:'继续练习',player:{playerId:'me'}},{getState:()=>({turn:{phase:'action'}}),setCue:()=>{},exit:()=>{},restart:()=>{},next:()=>{}});void 0;`)
    const layouts = []
    for (const [width,height] of [[1280,720],[844,390]]) {
      win.setContentSize(width,height)
      await win.webContents.executeJavaScript(`(()=>{const el=document.getElementById('tutorialLessonDialog');el.querySelector('.tutorial-dialog__text').textContent='先点击亮起的乌瑟尔。选中棋子后，可以看到他的生命和可用技能。这里只是查看，还不会消耗行动点。';el.scrollTop=0;el.focus()})()`)
      await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
      const layout = await win.webContents.executeJavaScript(`(()=>{const el=document.getElementById('tutorialLessonDialog'),box=el.getBoundingClientRect();return {top:box.top,bottom:box.bottom,viewport:innerHeight,scrollbar:getComputedStyle(el).scrollbarWidth,webkit:getComputedStyle(el,'::-webkit-scrollbar').display,tabIndex:el.tabIndex}})()`)
      assert.ok(layout.top >= 0 && layout.bottom <= layout.viewport)
      assert.equal(layout.scrollbar,'none'); assert.equal(layout.webkit,'none'); assert.equal(layout.tabIndex,0)
      fs.writeFileSync(path.join(output, 'tutorial-standard-'+width+'x'+height+'.png'),(await win.webContents.capturePage()).toPNG())
      await win.webContents.executeJavaScript(`(()=>{const el=document.getElementById('tutorialLessonDialog');el.querySelector('.tutorial-dialog__text').textContent='长说明仍然可以用键盘和触摸阅读。'.repeat(50);el.focus()})()`)
      // Hidden windows do not receive OS keyboard input. Native focus scrolling
      // still verifies that the last keyboard-focusable action is reachable.
      const scroll = await win.webContents.executeJavaScript(`(()=>{const el=document.getElementById('tutorialLessonDialog'),buttons=el.querySelectorAll('button'),last=buttons[buttons.length-1];last.focus();const box=el.getBoundingClientRect(),button=last.getBoundingClientRect();return {top:el.scrollTop,max:el.scrollHeight-el.clientHeight,actionVisible:button.top>=box.top&&button.bottom<=box.bottom,focused:document.activeElement===last}})()`)
      assert.ok(scroll.max > 0 && scroll.top > 0 && scroll.actionVisible && scroll.focused,JSON.stringify(scroll))
      await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
      fs.writeFileSync(path.join(output, 'tutorial-'+width+'x'+height+'.png'),(await win.webContents.capturePage()).toPNG())
      layouts.push({width,height,...layout,scroll})
    }
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({portrait,missing,layouts},null,2)+'\n')
    console.log('RED-206 UI smoke passed: portrait switching, missing image, desktop/short-screen hidden scrollbar and focus accessibility.')
    clearTimeout(timer);win.destroy();app.quit()
  }).catch(error=>{console.error(error);app.exit(1)})
}
