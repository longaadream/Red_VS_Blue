import fs from 'node:fs'
import assert from 'node:assert/strict'
const targets=await(await fetch('http://127.0.0.1:19243/json/list')).json()
const target=targets.find(p=>p.url.startsWith('https://localhost'))
assert(target,'Forward the actual acceptance WebView to 19243')
const ws=new WebSocket(target.webSocketDebuggerUrl),pending=new Map();let seq=0
await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})})
ws.addEventListener('message',e=>{const data=JSON.parse(e.data);if(data.id){pending.get(data.id)?.(data);pending.delete(data.id)}})
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method))},90000);pending.set(id,d=>{clearTimeout(timer);if(d.error)reject(Error(d.error.message));else resolve(d.result)});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
async function until(expression){const end=Date.now()+45000;while(Date.now()<end){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,150))}throw Error('Timed out: '+expression)}
async function touch(selector){const r=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,h:r.height,hit:e.contains(document.elementFromPoint(x,y))}})()`);assert(r.h>=44&&r.hit,'Control clipped '+selector);await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:r.x,y:r.y}]});await new Promise(r=>setTimeout(r,80));await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})}

try {
 await call('Page.navigate',{url:'https://localhost/pieces.html'});
 await until('!!document.querySelector("#card-jaina")');
 await touch('#card-jaina');
 await until('[...document.querySelectorAll("#card-jaina .skill-desc")].every(e=>e.textContent!=="加载中…")');
 const piece=await evaluate(`(()=>{const c=document.querySelector('#card-jaina'),s=c.querySelector('.skills-panel'),r=c.getBoundingClientRect();return {viewport:[innerWidth,innerHeight],top:r.top,bottom:r.bottom,skills:[s.clientHeight,s.scrollHeight],shown:[...s.querySelectorAll('.skill-row')].filter(e=>getComputedStyle(e).display!=='none').length}})()`);
 assert(piece.top>=0&&piece.bottom<=piece.viewport[1]);assert.equal(piece.shown,3);assert(piece.skills[1]<=piece.skills[0]+2,'Jaina skills need scrolling');
 await evaluate('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
 fs.writeFileSync('dist/multiplayer-qa/android-library-piece.png',Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
 await touch('#card-jaina .library-close');
 await until('!document.querySelector("#card-jaina").classList.contains("expanded")');
 assert(await evaluate('[...document.querySelectorAll("#card-jaina .library-tabs,#card-jaina .library-close,#card-jaina .library-pages")].every(e=>e.getBoundingClientRect().height===0)'),'Closed details leave controls in list');
 await call('Page.navigate',{url:'https://localhost/piece-selection.html?mode=deck-builder'});
 await until('document.querySelectorAll("#pieceGrid .piece-card").length>0');
 const deck=await evaluate(`(()=>{const r=document.querySelector('.section').getBoundingClientRect(),f=document.querySelector('.confirm-bar').getBoundingClientRect();return {height:innerHeight,gridHeight:r.height,bottom:r.bottom,footerTop:f.top,footerBottom:f.bottom,wholeScroll:document.documentElement.scrollHeight}})()`);
 assert(deck.gridHeight>=240&&deck.bottom<=deck.footerTop+2&&deck.footerBottom<=deck.height+2);
 await evaluate('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
 fs.writeFileSync('dist/multiplayer-qa/android-library-deck.png',Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
 await call('Page.navigate',{url:'https://localhost/tutorial.html'});
 await until('document.querySelectorAll(".lesson-pages button").length===6');
 for(let i=1;i<=6;i++){
  await touch('.lesson-pages button:nth-child('+i+')');
  await until('document.querySelector(".lesson-pages button:nth-child('+i+')").getAttribute("aria-current")==="true"');
  const lesson=await evaluate(`(()=>{const cards=[...document.querySelectorAll('.lesson-card')].filter(e=>!e.hidden),c=cards[0],r=c.getBoundingClientRect();return {count:cards.length,top:r.top,bottom:r.bottom,height:innerHeight,scroll:c.scrollHeight,client:c.clientHeight}})()`);
  assert.equal(lesson.count,1);assert(lesson.top>=0&&lesson.bottom<=lesson.height);assert(lesson.scroll<=lesson.client+2,'Lesson '+i+' needs scrolling');
 }
 await touch('.lesson-pages button:first-child');
 await until('document.querySelector(".lesson-pages button:first-child").getAttribute("aria-current")==="true"');
 await evaluate('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
 fs.writeFileSync('dist/multiplayer-qa/android-library-tutorial.png',Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
 console.log(JSON.stringify({piece,deck,tutorialPages:6,passed:true}));
}finally{ws.close()}
