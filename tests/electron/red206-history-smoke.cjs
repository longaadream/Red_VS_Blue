/* Headless DOM/layout checks against the production battle history and pending response. */
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
  app.setPath('userData', path.join(root, 'dist/red206-history-profile'))
  app.whenReady().then(async () => {

    fs.mkdirSync(output, { recursive: true })
    const pages = path.join(root, 'data/pages')
    const battle = fs.readFileSync(path.join(pages, 'battle.html'), 'utf8')
    const styles = [...battle.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map(match => match[0]).join('\n')
    const css = [...battle.matchAll(/<link[^>]*href="([^"]+\.css)"[^>]*>/g)].map(match => match[1])
      .filter(href => !/^(https?:)?\/\//.test(href))
      .map(href => '<link rel="stylesheet" href="' + pathToFileURL(path.join(pages, href)) + '">').join('\n')
    const fixture = path.join(root, 'dist', 'red206-history-fixture.html')
    fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8">' + styles + css +
      '<style>body{background:#8a755c}#board{position:fixed;inset:0;transform:translateZ(0)}#target{position:absolute;left:45%;top:65%;padding:24px}#floats{position:absolute;inset:0;pointer-events:none}#optionPickerOverlay{position:fixed;inset:0;background:#182028d9;z-index:999999;display:grid;place-items:center;color:white}</style>' +
      '<div id="board"><button id="target">选择目标</button><div id="floats"></div><aside id="actionHistoryDock" class="action-history-dock" hidden></aside></div><div id="optionPickerOverlay">响应选择弹窗</div>')
    const win = new BrowserWindow({ show: false, width: 1280, height: 720, useContentSize: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    const timer = setTimeout(() => { console.error('History smoke timeout'); app.exit(1) }, 45000)
    await win.loadFile(fixture)
    for (const name of ['battle-action-identity', 'battle-action-history', 'battle-action-vignette'])
      await win.webContents.executeJavaScript(fs.readFileSync(path.join(pages, 'js/battle-ui/' + name + '.js'), 'utf8'))
    await win.webContents.executeJavaScript(`
      window.m={board:{width:6,height:4}, pieces:[{id:'caster',name:'对方蓝染',x:1,y:1}],players:[],turn:{isViewerTurn:false},
        interaction:{pendingResponse:{selectionId:'a',isForViewer:true,isOffTurn:true}},selection:{mode:'target'},
        skillSummariesById:{shot:{id:'shot',name:'触发响应的技能'}},
        presentationEvents:[{eventId:'a:0',rootEventId:'a:0',actionId:'a',sequence:0,kind:'skill',skillId:'shot',label:'触发响应的技能',sourcePieceId:'caster',result:{pending:true},targetCell:{x:2,y:1}}]};
      window.historyUi=BattleActionHistory.create();historyUi.mount({element:document.getElementById('actionHistoryDock')});historyUi.update(m);
      window.vignette=BattleActionVignette.create();vignette.mount({boardContainer:document.getElementById('board'),floatLayer:document.getElementById('floats')});vignette.update(m);
      window.targetClicks=0;document.getElementById('target').onclick=()=>targetClicks++;void 0;
    `)
    const results=[]
    for (const [width,height] of [[1280,720],[844,390]]) {
      win.setContentSize(width,height)
      await new Promise(resolve=>setTimeout(resolve,2200))
      const check=await win.webContents.executeJavaScript(`(()=>{
        const dock=document.getElementById('actionHistoryDock'),button=dock.querySelector('button'),rect=button.getBoundingClientRect();
        const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
        if(!button.contains(hit))throw Error('History covered by modal');
        if(!dock.classList.contains('is-user-expanded'))button.click();
        if(!dock.classList.contains('is-user-expanded'))throw Error('Cannot expand in target mode');
        const banner=document.querySelector('.battle-vignette-status'),style=getComputedStyle(banner);
        if(style.opacity!=='1'||style.animationName!=='none')throw Error('Pending banner faded');
        document.getElementById('optionPickerOverlay').style.display='none';
        const target=document.getElementById('target'),r=target.getBoundingClientRect(),targetHit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        if(targetHit!==target)throw Error('Held action blocks target');targetHit.click();
        document.getElementById('optionPickerOverlay').style.display='grid';
        return {width:innerWidth,height:innerHeight,portaled:dock.parentNode===document.body,zIndex:getComputedStyle(dock).zIndex,highlight:getComputedStyle(button).backgroundColor,phase:document.querySelector('.battle-vignette-layer').dataset.phase,targetClicks};
      })()`)
      assert.equal(check.portaled,true);assert.equal(check.phase,'hold');assert.ok(check.targetClicks>0)
      results.push(check)
      fs.writeFileSync(path.join(output,'history-'+width+'x'+height+'.png'),(await win.webContents.capturePage()).toPNG())
    }
    fs.writeFileSync(path.join(output,'history-results.json'),JSON.stringify(results,null,2)+'\n')
    clearTimeout(timer);win.destroy();console.log(JSON.stringify(results));app.quit()
  }).catch(error=>{console.error(error);app.exit(1)})
}
