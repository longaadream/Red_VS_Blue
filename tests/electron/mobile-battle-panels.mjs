import fs from 'node:fs'
import path from 'node:path'

// Live battle controls use production handlers. Required-choice layout cases
// temporarily supply an explicit presentation fixture, restored synchronously
// before another event can run; they never submit an authority command.
export async function checkMobileBattlePanels(page, output) {
  const reports = []
  const violations = []
  const idleDeadline=Date.now()+30000
  while (!await page.evaluate('[...document.querySelectorAll(".battle-vignette-layer")].every(el=>el.hidden)')) {
    if(Date.now()>idleDeadline) throw Error('Battle vignette did not finish')
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  // Density variants near the user's Xiaomi 17 Pro Max panel resolution.
  // These are coverage cases, not a claim about its default HyperOS density.
  for (const [width, height, density] of [[740, 360, 1], [844, 390, 1], [932, 430, 1], [1043, 480, 2.5], [869, 400, 3]]) {
    await page.call('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor:density, mobile:true})
    await page.call('Emulation.setTouchEmulationEnabled', {enabled:true})
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    for(const [timerWidth,timerHeight] of (width===740?[[width,height],[568,320]]:[[width,height]])) {
    await page.call('Emulation.setDeviceMetricsOverride',{width:timerWidth,height:timerHeight,deviceScaleFactor:density,mobile:true})
    const timers=await page.evaluate(`(() => {
      const saved=authoritativeTurnTimer,savedPending=authoritativePendingTimer,results=[];
      try {
        for(const state of ['normal','response','burning']) {
          const now=currentAuthorityNow();
          authoritativeTurnTimer={status:'running',deadlineAt:now+75000,burnStartsAt:now+60000,remainingMs:75000,paused:state==='response',burning:state==='burning'};
          authoritativePendingTimer=state==='response'?{status:'running',deadlineAt:now+15000}:null;
          renderTurnTimerStatus();
          const c=document.getElementById('turnClock'),f=document.getElementById('turnClockFrozen');
          const visible=[c,...(state==='response'?[f]:[])].every(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=60&&el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))});
          results.push({state,visible,text:c.textContent,frozen:f.textContent,burning:c.classList.contains('burning')});
        }
        return results;
      }finally{authoritativeTurnTimer=saved;authoritativePendingTimer=savedPending;renderTurnTimerStatus();}
    })()`)
    reports.push({name:'timer-fixture',width:timerWidth,height:timerHeight,density,cases:timers})
    if(timers.some(t=>!t.visible)||!timers.find(t=>t.state==='response').text.includes('响应')||!timers.find(t=>t.state==='burning').burning) violations.push(`timer ${timerWidth}x${timerHeight}: clock hidden, clipped or overlapping HUD`)
    }
    await page.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:density,mobile:true})
    await page.evaluate(`(() => {
      closePieceInfo();closeCardDetail();dispatchBattleIntent({type:'clear-selection'});
      const piece=G.pieces.find(p=>p.ownerPlayerId===myPlayerId && pieceDispSkills(p).some(s=>skillDefOf(skillIdOf(s)).kind!=='passive'));
      if(!piece) throw Error('No live actor with skills');
      return dispatchBattleIntent({type:'select-piece',pieceId:piece.instanceId});
    })()`)
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const dock = await page.evaluate(`(() => {
      const menu=document.getElementById('pieceContextMenu');
      const skills=[...menu.querySelectorAll('.piece-context-skill')];
      return {open:menu.classList.contains('is-open'),details:document.body.classList.contains('character-dock-open'),
        skills:skills.map(el=>{const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {height:r.height,top:r.top,bottom:r.bottom,reachable:el.contains(hit)}})};
    })()`)
    reports.push({name:'quick-skills',width,height,density,...dock})
    if (!dock.open || dock.details || !dock.skills.length || dock.skills.some(r=>r.height<44 || r.top<0 || r.bottom>height || !r.reachable)) violations.push(`quick-skills ${width}x${height}: skills require scrolling or are obstructed`)
    const dockShot=await page.call('Page.captureScreenshot',{format:'png'})
    fs.writeFileSync(path.join(output,`red199-quick-skills-${width}x${height}.png`),Buffer.from(dockShot.data,'base64'))
    await page.evaluate('document.getElementById("mobileHandToggle").click()')
    if (!await page.evaluate('document.body.classList.contains("mobile-hand-expanded") && !document.getElementById("handCards").inert')) violations.push(`hand ${width}x${height}: expansion failed`)
    await page.evaluate('document.getElementById("mobileHandToggle").click()')
    if (!await page.evaluate('document.getElementById("handCards").inert')) violations.push(`hand ${width}x${height}: collapse failed`)
    const forced = await page.evaluate(`(() => {
      const saved=G, savedHand=pendingHandOptionSelection, savedStatus=document.getElementById('statusMsg').textContent;
      try {
        const cardId=Object.keys(cardsById)[0];
        const hand=[0,1,2].map(i=>({instanceId:'layout-choice-'+i,cardId,actionPointCost:0}));
        const result=[];
        for(const selectionMode of ['single','multi']) {
          G={...saved,players:saved.players.map(p=>p.playerId===myPlayerId?{...p,hand}:p),pendingOptionSelection:{playerId:myPlayerId,selectionId:'layout-'+selectionMode,presentation:'hand',selectionMode,minSelections:1,maxSelections:2,options:hand.map(c=>({value:c.instanceId})),canCancel:true}};
          renderHand();onCardClick(hand[0].instanceId,cardId);
          const controls=document.getElementById('handMultiSelectControls');
          const cards=[...document.querySelectorAll('#handCards .card-item')];
          const all=[...cards,document.getElementById('handMultiSelectConfirm'),document.getElementById('handMultiSelectCancel')];
          result.push({selectionMode,visible:!controls.hidden,expanded:!document.getElementById('handCards').inert,selected:pendingHandOptionSelection.selectedValues.length,reachable:all.every(el=>{const r=el.getBoundingClientRect();return r.height>=44&&r.top>=0&&r.bottom<=innerHeight&&el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})});
        }
        return result;
      } finally {G=saved;pendingHandOptionSelection=savedHand;render();setStatusMsg(savedStatus);}
    })()`)
    reports.push({name:'required-hand-fixture',width,height,density,cases:forced})
    if(forced.some(r=>!r.visible||!r.expanded||r.selected!==1||!r.reachable)) violations.push(`required hand ${width}x${height}: cards or confirmation obstructed`)
    await page.evaluate('showTileStatus(G.map.tiles[0].x,G.map.tiles[0].y)')
    const compact=await page.evaluate(`(() => {
      const p=document.getElementById('tileStatusPanel'),s=document.getElementById('tileStatusSummary');
      const r=p.getBoundingClientRect(),b=s.getBoundingClientRect();
      return {height:r.height,top:r.top,left:r.left,right:r.right,bottom:r.bottom,bodyHidden:getComputedStyle(p.querySelector('.ts-body')).display==='none',expanded:p.classList.contains('is-expanded'),x:b.left+b.width/2,y:b.top+b.height/2,reachable:s.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2))};
    })()`)
    if(compact.expanded||!compact.bodyHidden||compact.height>56||compact.height<44||!compact.reachable) violations.push(`tile ${width}x${height}: compact strip obstructed or too large`)
    await page.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:compact.x,y:compact.y}]})
    await page.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
    const expanded=await page.evaluate(`(() => {
      const p=document.getElementById('tileStatusPanel'),c=p.querySelector('.ts-close'),r=p.getBoundingClientRect(),b=c.getBoundingClientRect();
      return {expanded:p.classList.contains('is-expanded'),left:r.left,right:r.right,top:r.top,bottom:r.bottom,x:b.left+b.width/2,y:b.top+b.height/2,closeHeight:b.height,reachable:c.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2))};
    })()`)
    reports.push({name:'tile',width,height,density,compact,expanded})
    if(!expanded.expanded||expanded.left<0||expanded.right>width||expanded.bottom>height-88||expanded.top<58||expanded.closeHeight<44||!expanded.reachable) violations.push(`tile ${width}x${height}: expanded details obstructed or outside board area`)
    const tileShot=await page.call('Page.captureScreenshot',{format:'png'})
    fs.writeFileSync(path.join(output,`red199-tile-expanded-${width}x${height}.png`),Buffer.from(tileShot.data,'base64'))
    await page.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:expanded.x,y:expanded.y}]})
    await page.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
    if(!await page.evaluate('document.getElementById("tileStatusPanel").getAttribute("aria-hidden")==="true"')) violations.push(`tile ${width}x${height}: touch close failed`)
    await page.evaluate('showTileStatus(G.map.tiles[0].x,G.map.tiles[0].y);setTileStatusExpanded(true);showTileStatus(G.map.tiles[1].x,G.map.tiles[1].y)')
    if(!await page.evaluate('!document.getElementById("tileStatusPanel").classList.contains("is-expanded")')) violations.push(`tile ${width}x${height}: new tile did not collapse`)
    const tileCompactShot=await page.call('Page.captureScreenshot',{format:'png'})
    fs.writeFileSync(path.join(output,`red199-tile-compact-${width}x${height}.png`),Buffer.from(tileCompactShot.data,'base64'))
    await page.evaluate('closeTileStatus()')
    const manyEffects=await page.evaluate(`(() => {
      const saved=G,tile=G.map.tiles[0];
      try {
        G={...saved,extensions:{...saved.extensions,tileEffects:Array.from({length:12},(_,i)=>({id:'layout-effect-'+i,x:tile.x,y:tile.y,tileType:'lava'}))}};
        showTileStatus(tile.x,tile.y);setTileStatusExpanded(true);
        const p=document.getElementById('tileStatusPanel'),body=p.querySelector('.ts-body'),r=p.getBoundingClientRect();
        const icons=document.querySelectorAll('#tileStatusSummaryEffects img').length;
        body.scrollTop=body.scrollHeight;
        return {icons,total:p.querySelectorAll('.ts-effect').length,bottom:r.bottom,scrollable:body.scrollTop>0||p.querySelector('.ts-details').scrollHeight>p.querySelector('.ts-details').clientHeight};
      }finally{G=saved;closeTileStatus();}
    })()`)
    if(manyEffects.icons!==3||manyEffects.total!==12||manyEffects.bottom>height-88||!manyEffects.scrollable) violations.push(`tile effects ${width}x${height}: compact icons or expanded scrolling failed`)
    const cases = [
      {name:'piece', open:'showPieceInfo(G.pieces.find(piece => piece.ownerPlayerId === myPlayerId).instanceId)', panel:'#pieceInfoModal .pi-layout', close:'#pieceInfoModal .pi-close'},
      // Some valid rosters consume their opening card automatically. In that
      // case inspect a real profile catalog entry without inventing a hand.
      {name:'card', open:'(() => { const card = G.players.find(player => player.playerId === myPlayerId).hand[0]; const id = card?.cardId || Object.keys(cardsById).sort().find(id => cardsById[id].keywords?.length); if (!id) throw Error("No profile card to inspect"); showCardDetail(card?.instanceId || "layout-catalog-preview",id) })()', panel:'#cardDetailModal .cd-layout', close:'#cardDetailModal .cd-close'},
    ]
    for (const item of cases) {
      await page.evaluate(item.open)
      await page.evaluate('new Promise(resolve => requestAnimationFrame(resolve))')
      const report = await page.evaluate(`(() => {
        const panel = document.querySelector(${JSON.stringify(item.panel)});
        const close = document.querySelector(${JSON.stringify(item.close)});
        function bounds(el) { const r=el.getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height} }
        const r=close.getBoundingClientRect();
        const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        const actions=[...panel.querySelectorAll('.character-cast,.keyword-badge')].filter(el => el.getClientRects().length && !el.disabled).map(bounds);
        return {panel:bounds(panel),close:bounds(close),closeReachable:close.contains(hit),actions};
      })()`)
      reports.push({name:item.name,width,height,density,...report})
      const screenshot = await page.call('Page.captureScreenshot',{format:'png'})
      fs.writeFileSync(path.join(output,`red199-${item.name}-${width}x${height}${density>1?'@'+density+'x':''}.png`),Buffer.from(screenshot.data,'base64'))
      if (report.panel.left < 0 || report.panel.top < 0 || report.panel.right > width || report.panel.bottom > height) violations.push(`${item.name} ${width}x${height}: panel outside viewport`)
      if (report.close.width < 44 || report.close.height < 44 || !report.closeReachable) violations.push(`${item.name} ${width}x${height}: close is too small or obstructed`)
      if (report.actions.some(r=>r.height < 44)) violations.push(`${item.name} ${width}x${height}: skill/keyword target below 44px`)
      // Close via browser touch input at the observed DOM bounds.
      const r=report.close
      await page.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:r.left+r.width/2,y:r.top+r.height/2}]})
      await page.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
      const closed=await page.evaluate(`document.querySelector(${JSON.stringify(item.panel)}).getClientRects().length === 0`)
      if (!closed) violations.push(`${item.name} ${width}x${height}: touch close failed`)
      // Clean up through the production handler to inspect remaining failures.
      await page.evaluate('closePieceInfo();closeCardDetail()')
    }
  }
  fs.writeFileSync(path.join(output,'red199-panel-layout.json'),JSON.stringify({reports,violations},null,2))
  if (violations.length) throw Error(violations.join('\n'))
}
