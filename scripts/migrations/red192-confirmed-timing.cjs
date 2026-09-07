/* Narrow migration for timing choices explicitly confirmed during language review. */
const fs = require('node:fs');
function change(file, edits) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [field, before, after] of edits) {
    if (!data[field].includes(before)) throw new Error(file + ': expected text missing: ' + before);
    data[field] = data[field].replace(before, after);
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
change('data/skills/blizzard-damage.json', [['code', 'currentDuration: 2', 'currentDuration: 1']]);
change('data/skills/tails-twin-flight.json', [
  ['code', "flightId:flightId,currentDuration:-1,relatedRules:", "flightId:flightId,currentDuration:2,relatedRules:"],
  ['code', "p.statusTags.push({id:flightId+'-immune-'", "addStatusEffectById(p.instanceId,{id:flightId+'-immune-'"],
  ['code', "'rule-tails-flight-immune-target']},{id:flightId+'-inoperable-'", "'rule-tails-flight-immune-target']});addStatusEffectById(p.instanceId,{id:flightId+'-inoperable-'"],
]);
change('data/rules/rule-tails-flight-resolve.json', [
  ['skillCode', "tag.turns=(tag.turns||0)-1;if(tag.turns>0)return {success:true,message:'双尾飞行预留还需'+tag.turns+'回合'};", "if(tag.appliedTurn===battle.turn.turnNumber||tag.currentDuration>1)return {success:true,message:'双尾飞行等待后续己方回合结束'};"],
  ['skillCode', "p.statusTags=(p.statusTags||[]).filter(function(t){return t.flightId!==tag.flightId&&t.type!=='immune'&&t.type!=='inoperable';});p.rules=(p.rules||[]).filter(function(r){return r.id!=='rule-tails-flight-resolve'&&r.id!=='rule-tails-flight-immune'&&r.id!=='rule-tails-flight-inoperable';});", "(p.statusTags||[]).filter(function(t){return t.flightId===tag.flightId;}).forEach(function(t){removeStatusEffectById(p.instanceId,t.id);});"],
]);
console.log('Confirmed Blizzard and Twin Flight timing changes applied.');
