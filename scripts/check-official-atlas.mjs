// Validate the generated delivery against its resource snapshot, not hardcoded counts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const source=path.join(root,'output/release-018-bundle/resource-source/data');
const output=path.join(root,'output/official-site-preview');
const read=(base,file)=>JSON.parse(fs.readFileSync(path.join(base,file),'utf8'));
const atlas=read(output,'atlas.json');
const definitions=read(source,'pieces/manifest.json').map(id=>read(source,'pieces/'+id+'.json'));
const expected=definitions.filter(p=>!p.id.startsWith('pve-')&&(!Array.isArray(p.availability?.modes)||p.availability.modes.includes('pvp')));
assert.deepEqual(atlas.pieces.map(p=>p.id),expected.map(p=>p.id));
const keywords=read(source,'skill-keywords.json');
for(const p of atlas.pieces){
 const def=expected.find(d=>d.id===p.id);
 assert.deepEqual(p.relatedCards.map(c=>c.id),def.relatedCards||[]);
 assert.deepEqual(p.transformedSkills.map(s=>s.id),(def.transformedSkills||[]).map(s=>s.skillId||s.id));
 const all=[...p.skills,...p.transformedSkills,...p.relatedCards];
 for(const item of all){
  assert.ok(!('code' in item),'Executable rules must not be exported to the website');
  for(const name of item.keywords){
   const definition=keywords.find(k=>k.name===name||k.id===name);
   const actual=p.keywords.find(k=>k.id===definition?.id);
   assert.ok(actual,'Missing keyword '+name+' in '+p.id);
   assert.equal(actual.longDescription,definition.longDescription||'');
  }
 }
 for(const c of p.relatedCards){assert.equal(c.description,read(source,'cards/'+c.id+'.json').description);if(c.image)assert.ok(fs.existsSync(path.join(output,c.image)));}
 assert.ok(fs.existsSync(path.join(output,p.image)));
}
assert.ok(atlas.pieces.find(p=>p.id==='shadow').skills.find(s=>s.id==='shadow-chaos-control').description.includes('5×5'));
console.log('Atlas checked: '+atlas.pieces.length+' public pieces; all keywords, unlocked skills, related cards and images present.');
