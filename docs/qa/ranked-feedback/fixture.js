;(function(){
 const saved={url:location.origin,token:'local-ui-fixture',account:{id:'qa-player',name:'界面验收玩家'}};
 const maps=['回风曲径','双桥','环形废墟','长廊'].map((name,i)=>({id:'map-'+i,name,width:12,height:8,tiles:Array.from({length:96},(_,j)=>({x:j%12,y:Math.floor(j/12),type:j%7===0?'wall':j%11===0?'cover':'floor'}))}));
 let state={phase:location.pathname.includes('piece-selection')?'roster':'veto',serverNow:Date.now(),deadlineAt:Date.now()+120000,mapId:'map-1',maps,players:[{...saved.account,seat:'red',alignment:null,pieces:[],revision:0},{id:'opponent',name:'对手',seat:'blue'}]};
 async function api(route,body){if(route.includes('/pregame/')){if(body?.action==='ban'){state.players[0].banSubmitted=true;state.players[0].ban=body.mapId;state.phase='roster'}if(body?.action==='draft'){Object.assign(state.players[0],{alignment:body.alignment,pieces:body.pieces,revision:state.players[0].revision+1})}if(body?.action==='lock')state.players[0].locked=true;return {...state,serverNow:Date.now()}}if(route.endsWith('/info'))return {kind:'rvb-official-v1',announcement:'本地界面验收样例 · 不连接排位服务器'};if(route.endsWith('/me'))return {account:saved.account,matchId:'qa-match',season:{name:'测试赛季'},rating:{rating:1000,games:0,wins:0},history:[]};if(route.endsWith('/leaderboard'))return {players:[]};return {}}
 if(window.RvBRanked){window.RvBRanked.session=()=>saved;window.RvBRanked.api=api}
 if(window.RvBUtils){window.RvBUtils.readOfficialSession=()=>saved;window.RvBUtils.saveRemoteServerUrl=()=>{};window.RvBUtils.switchServerMode=()=>{}}
 const realFetch=window.fetch.bind(window);window.fetch=(url,opts)=>String(url).includes('/official/')?api(String(url),opts?.body?JSON.parse(opts.body):undefined).then(x=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}})):realFetch(url,opts);
 localStorage.setItem('rvb_official_url',location.origin);
})()
