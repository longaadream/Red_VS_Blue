/* Fixed initial QA fixture. All subsequent interactions use the real training/engine path. */
document.title='暖暗漫画桌游 · 紧凑对战界面';
const marker=document.createElement('div');marker.className='skin-preview-marker';marker.innerHTML='美术样本 · 真实训练流程 <a href="/battle.html?mode=training">自行配置</a> <a href="/battle.html?mode=training&sample=1">重摆样本</a>';document.body.append(marker);
if(new URLSearchParams(location.search).get('sample')==='1'){
 let started=false;
 const observer=new MutationObserver(startWhenReady);observer.observe(document.getElementById('trainingSetupOverlay'),{attributes:true,attributeFilter:['style','class']});
 async function startWhenReady(){
  if(started||getComputedStyle(document.getElementById('trainingSetupOverlay')).display==='none'||typeof PIECES_BY_ID==='undefined'||!PIECES_BY_ID.arthas)return;
  started=true;observer.disconnect();
  try{
   document.getElementById('trainingSetupOverlay').classList.remove('show');
   await initTraining('open-expanse',{firstPlayerId:'training-red',firstFaction:'red',secondFaction:'blue',firstTemplateIds:['arthas','shadow','red-sasuke'],secondTemplateIds:['anduin','sonic','blue-naruto']});
   if(!G)throw Error('Native training initialization did not return a battle');
   const positions=[[6,6],[9,6],[12,6],[6,10],[9,10],[12,10]];
   G.pieces.forEach((piece,i)=>{if(positions[i]){piece.x=positions[i][0];piece.y=positions[i][1];}});
   G.pieces[0].currentHp=Math.max(1,G.pieces[0].currentHp-3);
   const cardIds=['holy-smite','holy-heal','holy-charge','lucky-coin','soul-fragment'];
   G.players.forEach((player)=>{player.hand=cardIds.map((cardId,i)=>({instanceId:'skin-'+player.playerId+'-'+i,cardId,ownerPlayerId:player.playerId,name:cardsById[cardId].name}));});
   // Optional visible-effects fixture tests the compact panel, not effect resolution rules.
   if(new URLSearchParams(location.search).get('tilepreview')==='1'){
    G.extensions=G.extensions||{};G.extensions.tileEffects=G.extensions.tileEffects||[];
    ['blizzard','amaterasu','tails-flight-reservation'].forEach((tileType,i)=>G.extensions.tileEffects.push({id:'skin-tile-'+i,tileType,x:7,y:7,sourceId:'skin-tile-preview'}));
   }
   selectedPieceId=G.pieces[0].instanceId;render();showTileStatus(7,7);
   setStatusMsg('美术验收场景：固定起始摆位与手牌，操作使用现有训练规则');
  }catch(error){console.error('[skin showcase]',error);document.getElementById('trainingSetupOverlay').classList.add('show');}
 }
 startWhenReady();
}
