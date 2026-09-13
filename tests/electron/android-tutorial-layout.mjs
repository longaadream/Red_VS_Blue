// Installed APK WebView: use RVB_ADVENTURE_QA_LOCAL=1 for its native Android host.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
const output='output/pve-roguelike/android-ui'
fs.mkdirSync(output,{recursive:true})
const targets=await(await fetch('http://127.0.0.1:19243/json/list')).json()
const target=targets.find(p=>p.url.startsWith('https://localhost'))
assert(target,'Forward the installed acceptance APK WebView to 19243')
const ws=new WebSocket(target.webSocketDebuggerUrl),pending=new Map();let sequence=0
await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})})
ws.addEventListener('message',e=>{const data=JSON.parse(e.data);if(data.id)pending.get(data.id)?.(data)})
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},60000);pending.set(id,data=>{clearTimeout(timer);pending.delete(id);if(data.error)reject(Error(data.error.message));else resolve(data.result)});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value}
async function until(expression){const end=Date.now()+60000;while(Date.now()<end){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,150))}throw Error('Timed out: '+expression)}
async function touch(selector){const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,height:r.height,hit:e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))}})()`);assert(point.height>=44&&point.hit,'Touch target clipped: '+selector+' '+JSON.stringify(point));await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y}]});await new Promise(r=>setTimeout(r,80));await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await new Promise(r=>setTimeout(r,500))}

try {
  await call('Page.navigate', {url:'https://localhost/battle.html?mode=tutorial&lesson=first-victory'})
  await until("!!window.__RVB_TUTORIAL__ && document.getElementById('loadingOverlay').style.display==='none'")
  const checks=[]
  for (const [width,height] of [[640,360],[800,360],[914,411]]) {
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true})
    const layout=await evaluate(`(()=>{
      const d=document.getElementById('tutorialLessonDialog');d.scrollTop=0;
      const text=d.querySelector('.tutorial-dialog__text'),button=d.querySelector('button.is-primary');
      const r=d.getBoundingClientRect(),b=button.getBoundingClientRect(),t=text.getBoundingClientRect();
      return {width:innerWidth,height:innerHeight,dialog:r.toJSON(),textHeight:t.height,textScrollHeight:text.scrollHeight,
        buttonHeight:b.height,buttonVisible:b.top>=r.top&&b.bottom<=r.bottom&&button.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)),
        textVisible:t.top<r.bottom&&t.bottom>r.top,overflow:document.documentElement.scrollWidth>innerWidth+1};
    })()`)
    assert(!layout.overflow && layout.dialog.right<=width && layout.dialog.bottom<=height-85,JSON.stringify(layout))
    assert(layout.buttonHeight>=44 && layout.buttonVisible,'Tutorial action hidden: '+JSON.stringify(layout))
    assert(layout.textHeight>=18 && layout.textHeight>=layout.textScrollHeight-2 && layout.textVisible,'Tutorial copy collapsed: '+JSON.stringify(layout))
    await touch('.tutorial-dialog__toggle')
    const collapsed=await evaluate("(()=>{const d=document.getElementById('tutorialLessonDialog');return {height:d.getBoundingClientRect().height,collapsed:d.classList.contains('is-collapsed'),expanded:d.querySelector('.tutorial-dialog__toggle').getAttribute('aria-expanded')}})()")
    assert(collapsed.collapsed && collapsed.height<=80 && collapsed.expanded==='false',JSON.stringify(collapsed))
    await touch('.tutorial-dialog__toggle')
    checks.push(layout)
  }
  await call('Emulation.clearDeviceMetricsOverride')
  const gap=await evaluate("(()=>{const bar=document.querySelector('.phase-bar').getBoundingClientRect();for(let x=Math.max(65,bar.left);x<bar.right;x+=8){const hit=document.elementFromPoint(x,25);if(hit?.closest('.board-wrap'))return {x,y:25,tag:hit.tagName}}return null})()")
  assert(gap,'Top HUD gaps must hit the board')
  await touch('#tutorialLessonDialog button.is-primary')
  await until("__RVB_TUTORIAL__.snapshot().openingStep==='select'")
  const point=await evaluate("(()=>{const p=G.pieces.find(p=>p.templateId==='uther');const r=BattleRenderer3D.projectCell(p.x,p.y);return{x:r.clientX,y:r.clientY}})()")
  await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]})
  await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
  await until("selectedPieceId===G.pieces.find(p=>p.templateId==='uther').instanceId")
  const adb=path.join(process.env.LOCALAPPDATA,'Android/Sdk/platform-tools/adb.exe')
  execFileSync(adb,['shell','screencap','-p','/sdcard/tutorial-touch.png'],{windowsHide:true})
  execFileSync(adb,['pull','/sdcard/tutorial-touch.png',output+'/tutorial-touch-native.png'],{windowsHide:true})
  await touch('.tutorial-dialog__toggle')
  execFileSync(adb,['shell','screencap','-p','/sdcard/tutorial-collapsed.png'],{windowsHide:true})
  execFileSync(adb,['pull','/sdcard/tutorial-collapsed.png',output+'/tutorial-collapsed-native.png'],{windowsHide:true})
  console.log(JSON.stringify({checks,touchSelectedPiece:true,tutorial:await evaluate('__RVB_TUTORIAL__.snapshot()')}))
} finally { await call('Emulation.clearDeviceMetricsOverride').catch(()=>{});ws.close() }
