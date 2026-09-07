/* Presentation adapters only. The opponent adapter consumes public DOM count, never hand data. */
(function(){
 'use strict';
 const iconRoot='tabletop-battle/assets/ink-icons/';
 const additions={
  'momentum-core':'动能','free-normal-move-every-turn':'音速 / 高速模块','preserve-momentum':'超级形态',
  'periodic-heal':'恢复模块','tails-flight-reservation':'双尾飞行预留',immune:'免疫',inoperable:'不可操作',
  'chaos-spear-theft':'混沌之矛','shadow-ride-sweep-side':'骑射横扫侧射','mangekyo-witness':'万花筒',
  'ulquiorra-resurreccion-progress':'归刃进度'
 };
 const registry=window.BattleEffectIcons;
 if(registry){
  const byType=registry.resolveStatusType,byStatus=registry.resolveStatus;
  function restyle(meta,type){
   // Never reveal hidden bookkeeping, or change visibility / priorities / gameplay metadata.
   if(!meta||meta.visibility==='hidden'||!additions[type])return meta;
   return Object.assign({},meta,{iconId:type,assetPath:iconRoot+type+'.svg',label:additions[type]});
  }
  registry.resolveStatusType=function(type){return restyle(byType(type),String(type||''));};
  registry.resolveStatus=function(status){return restyle(byStatus(status),typeof status==='string'?status:String(status&&(status.type||status.id||status.name)||''));};
 }
 window.BattleSkinStatusIcons=Object.freeze(Object.keys(additions));
 const hand=document.getElementById('opponentHandStack');
 if(hand){
  document.body.appendChild(hand);
  function arrangeBacks(){
   const match=(hand.getAttribute('aria-label')||'').match(/(\d+)张手牌/);
   const count=match?Number(match[1]):0;
   // Native label exposes only public count. Render up to 30 backs plus the exact count badge.
   const shown=Math.min(30,count),backs=[...hand.querySelectorAll('i')];
   while(backs.length<shown){const back=document.createElement('i');back.setAttribute('aria-hidden','true');hand.prepend(back);backs.push(back);}
   while(backs.length>shown)backs.pop().remove();
   backs.forEach((back,i)=>{back.style.setProperty('--fan-x',String((i-(shown-1)/2)*Math.min(35,230/Math.max(1,shown-1)))+'px');back.style.setProperty('--fan-angle',String((i-(shown-1)/2)*Math.min(5,26/Math.max(1,shown-1)))+'deg');back.style.setProperty('--fan-y',String(-18+Math.abs(i-(shown-1)/2)*1.5)+'px');});
   const badge=hand.querySelector('strong');if(badge&&badge.textContent!==String(count))badge.textContent=String(count);
   hand.classList.toggle('is-empty',count===0);
  }
  new MutationObserver(arrangeBacks).observe(hand,{childList:true,attributes:true,attributeFilter:['aria-label']});
  arrangeBacks();
 }
 // Layout changes operate on the already-public native tile panel, never on concealed map data.
 const nativeShowTile=window.showTileStatus;
 if(typeof nativeShowTile==='function')window.showTileStatus=function(x,y){
  const result=nativeShowTile(x,y),panel=document.getElementById('tileStatusPanel');
  const terrain=document.getElementById('tileStatusTerrain'),count=document.getElementById('tileStatusEffectCount');
  const parts=terrain.textContent.split(' · '),type=parts[1]||'unknown';
  const terrainIcons={floor:'terrain-floor',wall:'terrain-wall',cover:'terrain-cover',spawn:'terrain-spawn',hole:'terrain-hole',trap:'terrain-trap',lava:'burn',spring:'terrain-spring',chargepad:'verb-charge-points'};
  terrain.title=terrain.textContent;terrain.textContent=parts[0];terrain.style.setProperty('--terrain-icon','url("'+iconRoot+(terrainIcons[type]||'fallback')+'.svg")');
  const effects=[...document.querySelectorAll('#tileStatusContent .ts-effect')];
  count.textContent=effects.length?effects.length+' 个效果':'无持续效果';
  document.getElementById('tileStatusCoords').textContent='('+x+', '+y+')';
  document.getElementById('tileStatusExpand').hidden=effects.length===0;
  panel.classList.toggle('has-effects',effects.length>0);
  let chips=panel.querySelector('.skin-tile-chips');if(!chips){chips=document.createElement('div');chips.className='skin-tile-chips';panel.querySelector('.ts-body').insertBefore(chips,document.getElementById('tileStatusDetails'));}
  chips.replaceChildren();effects.slice(0,4).forEach(effect=>{
   const chip=document.createElement('button'),name=effect.querySelector('.ts-effect-name').textContent;
   chip.type='button';chip.title=name;chip.setAttribute('aria-label','查看地格效果：'+name);
   const img=effect.querySelector('img').cloneNode();img.alt='';chip.append(img);
   chip.addEventListener('click',()=>{window.setTileStatusExpanded(true);document.getElementById('tileStatusExpand').focus();});chips.append(chip);
  });
  if(effects.length>4){const more=document.createElement('span');more.textContent='+'+(effects.length-4);chips.append(more);}
  return result;
 };
 // Icon-only toolbar retains native aria-labels; titles expose names to pointer users as well.
 ['.topbar button','#btnResetBoardView','#trainingToolsToggle','.piece-context-info'].forEach(selector=>{
  document.querySelectorAll(selector).forEach(button=>{if(!button.title)button.title=button.getAttribute('aria-label')||button.textContent.trim();});
 });
 const trainingButton=document.getElementById('trainingToolsToggle');if(trainingButton){trainingButton.setAttribute('aria-label','训练工具');trainingButton.title='训练工具';}

})();
