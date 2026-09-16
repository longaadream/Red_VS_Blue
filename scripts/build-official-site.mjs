import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const root=path.resolve(import.meta.dirname,'..');
const out=path.join(root,'output/official-site-preview');
fs.mkdirSync(out,{recursive:true});
fs.cpSync(path.join(root,'website'),out,{recursive:true});
const snapshot=path.join(root,'output/release-018-bundle/resource-source');
if(!fs.existsSync(snapshot))throw Error('Missing reviewed 1.0.5 resource snapshot; do not silently use another version');
fs.copyFileSync(path.join(root,'data/pages/js/battle-audio.js'),path.join(out,'assets/battle-audio.js'));
fs.copyFileSync(path.join(root,'data/pages/js/battle-impact.js'),path.join(out,'assets/battle-impact.js'));
fs.copyFileSync(path.join(root,'data/pages/js/button-audio.js'),path.join(out,'assets/button-audio.js'));
const context={};vm.runInNewContext(fs.readFileSync(path.join(root,'data/pages/js/deck-presets.js'),'utf8'),context);
vm.runInNewContext(fs.readFileSync(path.join(root,'data/pages/js/gallery-content.js'),'utf8'),context);
const ids=JSON.parse(fs.readFileSync(path.join(snapshot,'data/pieces/manifest.json'),'utf8'));
const readData=(kind,id)=>JSON.parse(fs.readFileSync(path.join(snapshot,'data',kind,id+'.json'),'utf8'));
const keywords=JSON.parse(fs.readFileSync(path.join(snapshot,'data/skill-keywords.json'),'utf8'));
const keywordMap=new Map(keywords.flatMap(k=>[[k.name,k],[k.id,k]]));
function skillView(entry) {
 const s=readData('skills',typeof entry==='string'?entry:entry.skillId||entry.id);
 const trigger=entry.triggeredBy?readData('skills',entry.triggeredBy):null;
 return {id:s.id,name:s.name,description:s.description,kind:s.kind,type:s.type,keywords:s.keywords||[],actionPointCost:s.actionPointCost||0,chargeCost:s.chargeCost||0,cooldownTurns:s.cooldownTurns||0,triggeredBy:trigger?.name||null};
}
function copyImage(relative,id,folder) {
 if(!relative || !/\.(png|jpe?g|webp|svg)$/i.test(relative))return null;
 relative=relative.replaceAll('\\','/');
 if(path.isAbsolute(relative)||relative.split('/').includes('..'))throw Error('Unsafe image path: '+relative);
 const source=[path.join(snapshot,'images',relative),path.join(root,'public',relative),path.join(root,'data/pages/images',relative)].find(f=>fs.existsSync(f));
 if(!source)throw Error('Missing image for '+id+': '+relative);
 const image='assets/'+folder+'/'+id+path.extname(relative);
 fs.mkdirSync(path.dirname(path.join(out,image)),{recursive:true});fs.copyFileSync(source,path.join(out,image));return image;
}
fs.mkdirSync(path.join(out,'assets/pieces'),{recursive:true});
const pieces=ids.map(id=>readData('pieces',id)).filter(context.RvBGalleryContent.isGalleryPiece).map(p=>{
 const skills=(p.skills||[]).map(skillView),transformedSkills=(p.transformedSkills||[]).map(skillView);
 const relatedCards=(p.relatedCards||[]).map(id=>{
  const c=readData('cards',id);
  return {id:c.id,name:c.name,description:c.description,type:c.type,actionPointCost:c.actionPointCost||0,chargeCost:c.chargeCost||0,cooldownTurns:c.cooldownTurns??c.cooldown??0,keywords:c.keywords||[],targetText:c.targetText||'',image:copyImage(c.image?'card-art/'+c.image:null,c.id,'cards')};
 });
 const names=new Set([...skills,...transformedSkills,...relatedCards].flatMap(s=>s.keywords));
 const pieceKeywords=[...names].map(name=>{
  const k=keywordMap.get(name);
  if(!k)throw Error('Missing keyword definition: '+name+' for '+p.id);
  return {id:k.id,name:k.name,shortDescription:k.shortDescription||'',longDescription:k.longDescription||''};
 });
 return {id:p.id,name:p.name,faction:p.faction,stats:p.stats,role:context.RvBDeckPresets.roleFor(p),image:copyImage(p.image,p.id,'pieces'),skills,transformedSkills,relatedCards,keywords:pieceKeywords};
});
fs.writeFileSync(path.join(out,'atlas.json'),JSON.stringify({label:'资源 1.0.5 · 配套客户端 0.1.8',pieces},null,2));
console.log('Built '+out+' with '+pieces.length+' pieces; public download manifest preserved.');
