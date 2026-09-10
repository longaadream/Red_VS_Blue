// Run against this task's ADB-forwarded, debuggable UI acceptance WebView.
import fs from 'node:fs'
import assert from 'node:assert/strict'

const pages=await(await fetch('http://127.0.0.1:19243/json/list')).json()
const target=pages.find(p=>p.url.startsWith('https://localhost/'))
assert(target,'Forward the acceptance WebView to port 19243 first')
const ws=new WebSocket(target.webSocketDebuggerUrl),calls=new Map()
let sequence=0
await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})})
ws.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.id){calls.get(data.id)?.(data);calls.delete(data.id)}})
function call(method,params={}) {return new Promise((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{calls.delete(id);reject(Error('CDP timeout: '+method))},15000)
  calls.set(id,data=>{clearTimeout(timer);if(data.error)reject(Error(data.error.message));else resolve(data.result)})
  ws.send(JSON.stringify({id,method,params}))
})}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
async function until(expression){const end=Date.now()+30000;while(Date.now()<end){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,200))}throw Error('Timed out: '+expression)}
async function touch(rect) {
  await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rect.x,y:rect.y}]})
  await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
}
try {
  await call('Page.navigate',{url:'https://localhost/battle.html?mode=training'})
  await until('!!document.querySelector("#trainingFirstPieces input") && document.getElementById("trainingSetupOverlay").classList.contains("show")')
  const report=await evaluate(`(() => {
    const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,x:r.left+r.width/2,y:r.top+r.height/2}};
    const start=document.querySelector('.training-setup-actions .primary'),title=document.querySelector('.training-setup-title'),sheet=document.querySelector('.training-setup-sheet');
    const r=rect(start);
    return {viewport:[innerWidth,innerHeight],title:rect(title),sheet:rect(sheet),start:r,reachable:start.contains(document.elementFromPoint(r.x,r.y))};
  })()`)
  console.log(JSON.stringify(report))
  fs.writeFileSync('dist/multiplayer-qa/android-training-layout.json',JSON.stringify(report,null,2))
  assert(report.title.top>=0,'Training title is clipped')
  assert(report.sheet.top>=0&&report.sheet.bottom<=report.viewport[1],'Training sheet exceeds viewport')
  assert(report.start.height>=44&&report.start.bottom<=report.viewport[1]&&report.reachable,'Start button is clipped or obstructed')
  const screenshot=await call('Page.captureScreenshot',{format:'png'})
  fs.writeFileSync(`dist/multiplayer-qa/android-training-${report.viewport.join('x')}.png`,Buffer.from(screenshot.data,'base64'))
  const list=await evaluate(`(() => {const e=document.getElementById('trainingFirstPieces'),r=e.getBoundingClientRect();return {x:r.left+r.width/2,top:r.top,bottom:r.bottom,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,lastBottom:e.lastElementChild.getBoundingClientRect().bottom}})()`)
  console.log(JSON.stringify({roster:list}))
  if(list.scrollHeight>list.clientHeight) {
    await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:list.x,y:list.bottom-12}]})
    for(let i=1;i<=6;i++) await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:list.x,y:list.bottom-12-(list.bottom-list.top-24)*i/6}]})
    await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
    await until('document.getElementById("trainingFirstPieces").scrollTop>0')
  } else {
    assert(list.lastBottom<=list.bottom,'Non-scrolling roster clips its last option')
  }
  await evaluate('new Promise(resolve=>{let last=-1,stable=0;const timer=setInterval(()=>{const y=document.getElementById("trainingFirstPieces").scrollTop;stable=y===last?stable+1:0;last=y;if(stable>=3){clearInterval(timer);resolve()}},100)})')
  await touch(report.start)
  await until('!!G && document.getElementById("loadingOverlay").style.display==="none" && !document.getElementById("trainingSetupOverlay").classList.contains("show")')
  console.log(JSON.stringify({ok:true,battle:await evaluate('({map:G.map.id,pieces:G.pieces.length})')}))
  if(process.argv.includes('--battle-dock')) {
    const viewport=await evaluate('({width:innerWidth,height:innerHeight,screenWidth:screen.width,screenHeight:screen.height})')
    console.log(JSON.stringify({fullscreen:viewport}))
    assert(Math.abs(viewport.width-viewport.screenWidth)<2&&Math.abs(viewport.height-viewport.screenHeight)<2,'WebView does not fill the Android screen')
    await until('[...document.querySelectorAll(".battle-vignette-layer")].every(el=>el.hidden)')
    const actor=await evaluate(`(() => {const p=G.pieces.find(p=>p.ownerPlayerId===myPlayerId),r=battlePresentation.projectCell(p.x,p.y);return {id:p.instanceId,x:r.clientX,y:r.clientY}})()`)
    await touch(actor)
    await until('!!selectedPieceId && document.getElementById("pieceContextMenu").classList.contains("is-open")')
    assert.equal(await evaluate('selectedPieceId'),actor.id)
    const board=await evaluate(`(() => {const r=document.getElementById('boardStage3d').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,height:r.height}})()`)
    const points=(distance,offset=0)=>[{id:0,x:board.x-distance+offset,y:board.y},{id:1,x:board.x+distance+offset,y:board.y}]
    await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points(20)})
    for(let i=1;i<=6;i++) await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:points(20+i*6,i*3)})
    await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
    assert.equal(await evaluate('selectedPieceId'),actor.id,'Map gestures changed the selected piece')
    const moved=await evaluate(`(() => {const p=G.pieces.find(p=>p.instanceId===selectedPieceId);return battlePresentation.projectCell(p.x,p.y)})()`)
    assert(Math.hypot(moved.clientX-actor.x,moved.clientY-actor.y)>1,'Map gesture did not move the camera')
    const visible=()=>evaluate('document.getElementById("pieceContextMenu").getBoundingClientRect().height>0 && getComputedStyle(document.getElementById("pieceContextMenu")).display!=="none"')
    assert(await visible(),'Map gestures dismissed the skill dock')
    async function hit(selector) {
      const r=await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,height:r.height,reachable:e.contains(document.elementFromPoint(x,y))}})()`)
      assert(r.height>=44&&r.reachable,'Control obstructed: '+selector);return r
    }
    const beforeFold=await evaluate('BattleRenderer3D.getPerformanceDiagnostics().renderCount')
    await touch(await hit('#mobileDockToggle'))
    await until('document.body.classList.contains("mobile-dock-collapsed")')
    assert.equal(await evaluate('selectedPieceId'),actor.id)
    assert(!await visible(),'Folded skills still cover the board')
    await until(`document.getElementById('boardStage3d').getBoundingClientRect().height>${board.height+50}`)
    await until(`BattleRenderer3D.getPerformanceDiagnostics().renderCount>${beforeFold} && BattleRenderer3D.getPerformanceDiagnostics().lastDrawCalls>0`)
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    for(const selector of ['#mobileDockToggle','#trainingToolsToggle','.battle-vignette-speed-control','.btn-end']) await hit(selector)
    const folded=await call('Page.captureScreenshot',{format:'png'})
    fs.writeFileSync('dist/multiplayer-qa/android-dock-folded.png',Buffer.from(folded.data,'base64'))
    await touch(await hit('#mobileDockToggle'))
    await until('!document.body.classList.contains("mobile-dock-collapsed") && document.getElementById("pieceContextMenu").getBoundingClientRect().height>0')
    await touch(await hit('#mobileHandToggle'))
    await until('document.body.classList.contains("mobile-hand-expanded")')
    await touch(await hit('#mobileDockToggle'))
    await until('document.getElementById("handCards").inert && document.body.classList.contains("mobile-dock-collapsed")')
    await touch(await hit('#mobileDockToggle'))
    await until('!document.body.classList.contains("mobile-dock-collapsed")')
    await touch(await hit('#btnResetBoardView'))
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const opened=await call('Page.captureScreenshot',{format:'png'})
    fs.writeFileSync('dist/multiplayer-qa/android-dock-open.png',Buffer.from(opened.data,'base64'))
    console.log(JSON.stringify({dock:true,selected:actor.id,gesture:true,fold:true,reopen:true,hand:true,renderer:await evaluate('BattleRenderer3D.getPerformanceDiagnostics()')}))
  }

  if(process.argv.includes('--hand-lobby')) {
    // Read-only presentation fixture: never submit card/rule commands.
    await evaluate(`window.__qaSavedHand=G.players.find(p=>p.playerId===myPlayerId).hand;window.__qaSavedGame=G;(() => {const id=Object.keys(cardsById).find(id=>cardsById[id].name.length>8)||Object.keys(cardsById)[0];G={...G,players:G.players.map(p=>p.playerId===myPlayerId?{...p,hand:[{instanceId:'qa-long-name',cardId:id,actionPointCost:0}]}:p)};renderHand();})()`)
    async function hit(selector){return evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,top:r.top,bottom:r.bottom,width:r.width,height:r.height,reachable:e.contains(document.elementFromPoint(x,y))}})()`)}
    await touch(await hit('#mobileHandToggle'))
    await until('document.body.classList.contains("mobile-hand-expanded")')
    const card=await hit('#handCards .card-item'),status=await hit('#statusMsg')
    assert(status.bottom<card.top,'Status covers the hand')
    assert(await evaluate('parseFloat(getComputedStyle(document.querySelector("#handCards .card-name-banner")).fontSize)<=12'),'Card name is too large')
    await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:card.x,y:card.y}]})
    await until('document.getElementById("cardDetailModal").style.display==="flex"')
    await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
    const preview=await call('Page.captureScreenshot',{format:'png'})
    fs.writeFileSync('dist/multiplayer-qa/android-v4-card-preview.png',Buffer.from(preview.data,'base64'))
    await evaluate('G=window.__qaSavedGame;delete window.__qaSavedGame;delete window.__qaSavedHand;closeCardDetail();renderHand()')
    await call('Page.navigate',{url:'https://localhost/official.html'})
    await until('!!document.getElementById("connectionButton") && document.getElementById("message").textContent.includes("请先设置")')
    assert(await evaluate('document.getElementById("server").value===""'),'APK defaults to its own asset server')
    for(const selector of ['#accountButton','#connectionButton','#loginPrompt']) {
      const r=await hit(selector);assert(r.height>=44&&r.reachable,'Official control obstructed: '+selector)
    }
    assert(await evaluate('document.querySelector(".game-shell").getBoundingClientRect().bottom<=innerHeight+1'),'Lobby exceeds screen')
    const lobby=await call('Page.captureScreenshot',{format:'png'})
    fs.writeFileSync('dist/multiplayer-qa/android-v4-official.png',Buffer.from(lobby.data,'base64'))
    await touch(await hit('#connectionButton'));await until('document.getElementById("connection").open')
    for(const selector of ['#server','#connect','#connection .dialog-close']) assert((await hit(selector)).reachable,'Connection control obstructed: '+selector)
    await touch(await hit('#connection .dialog-close'));await until('!document.getElementById("connection").open')
    await touch(await hit('#accountButton'));await until('document.getElementById("accountDialog").open')
    await evaluate('document.querySelector("#authForm button").scrollIntoView({block:"nearest"})')
    assert((await hit('#authForm button')).reachable,'Auth submit cannot be reached')
    assert((await hit('#accountDialog .dialog-close')).reachable,'Auth close cannot be reached')
    console.log(JSON.stringify({handLongPress:true,statusAboveHand:true,officialLayout:true,unconfiguredServer:true,dialogs:true}))
  }

  if(process.argv.includes('--home')) {
    await call('Page.navigate',{url:'https://localhost/index.html'})
    await until('!!document.getElementById("tab-training") && typeof selectMenuMode==="function"')
    async function homeHit(selector){const r=await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,bottom:r.bottom,reachable:e.contains(document.elementFromPoint(x,y))}})()`);assert(r.reachable,'Home control obstructed: '+selector);return r}
    for(const selector of ['#tab-online','#tab-training','#tab-codex','.utility-bar button:first-child']) await homeHit(selector)
    const home=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync('dist/multiplayer-qa/android-v4-home.png',Buffer.from(home.data,'base64'))
    await touch(await homeHit('#tab-training'));await until('!document.getElementById("mode-training").hidden')
    await touch(await homeHit('#mode-training button[onclick="goToTraining()"]'))
    await until('location.pathname.endsWith("battle.html") && !!document.getElementById("trainingSetupOverlay")')
    console.log(JSON.stringify({formalHome:true,homeTrainingTouch:true}))
  }
} finally {ws.close()}
