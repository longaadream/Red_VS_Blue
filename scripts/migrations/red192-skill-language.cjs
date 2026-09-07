/* One-off reviewed description migration. Never changes executable skill code. */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const explicit = {
  'rafaam-curse-ward': '每回合限1次：本棋子在你的回合受到伤害时，免疫此次伤害，并将1张诅咒交给对手，记录的伤害为此次伤害加本棋子攻击力的50%。对手可消耗1行动点弃置诅咒；若仍持有，在对手的回合结束时，使其随机1个友方棋子受到记录的真实伤害。',
  'hashirama-edo-regen': '你的回合结束时，若本棋子的生命值低于最大生命值的50%，恢复2点生命。',
  'blizzard': '选择地图上1个地格，形成以该格为中心的7×7暴风雪区域。对方的下一个回合结束时，对区域内所有敌方棋子造成等同于本棋子施放时攻击力150%的法术伤害，并使其获得冰冻，持续1回合。随后暴风雪消散。',
  'blizzard-damage': '对暴风雪区域内所有敌方棋子造成施放时记录的法术伤害，并使其获得冰冻，持续1回合。',
  'aizen-black-coffin': '灵压。对本棋子5格内1个敌方棋子造成等同于本棋子攻击力150%的法术伤害，并使其获得定身，持续1回合。目标的下一个回合结束时，再次对其造成等量伤害。',
  'aizen-kyoka-suiguetsu': '秘密选择本棋子4格内1个友方棋子。对方的下一个回合中，该棋子成为单体技能目标时，可将目标转移至本棋子3格内另1个敌方棋子。',
  'aizen-shunpo': '灵压。选择本棋子5格内1个敌方棋子，将本棋子传送至该目标2格内1个空地格，你获得2点临时行动点。',
  'arthas-frostmourne': '对本棋子1格内1个敌方棋子造成等同于本棋子攻击力200%的物理伤害。若击杀目标，你获得2充能。',
  'arthas-icebound-fortitude': '持续2回合：本棋子受到的伤害减少50%；受到实际伤害后，使伤害来源的敌方棋子获得冰冻，持续1回合。',
  'arthas-lich-covenant': '使本棋子3格内1个友方棋子获得巫妖誓约。该棋子死亡后满血复活，然后攻击力提高50%，并重置所有技能冷却。',
  'biotic-grenade': '选择本棋子4格内1个地格，以该格为左上角，对2×2区域内的友方棋子恢复4点生命，对敌方棋子造成1点物理伤害，并使其获得禁疗，持续1回合。',
  'blackwidow-lethal-toxin': '在本棋子所在的地格放置毒素，然后将本棋子传送至5格内1个空地格。敌方棋子触发毒素时，受到4点真实伤害。',
  'blood-echo': '每当友方棋子失去圣盾时，你获得1张【圣光充能】。',
  'blood-echo-trigger': '友方棋子失去圣盾时，你获得1张【圣光充能】。',
  'divine-blessing': '使所有友方棋子下一次造成的伤害+2。场上每有1个持有圣盾的棋子，该次伤害额外+1。',
  'elune-guidance': '每当你使用圣光手牌时，获得1层月华，最多2层。月华达到2层时，使生命值最低的友方棋子恢复5点生命。',
  'elune-guidance-trigger': '你使用圣光手牌时，获得1层月华。月华达到2层时，使生命值最低的友方棋子恢复5点生命。',
  'elune-protection-trigger': '友方棋子将受到致命伤害时，免疫此次伤害，并恢复5点生命。',
  'elune-protection': '本棋子被召唤时，若你尚未持有艾露恩守护，则获得1次艾露恩守护。友方棋子将受到致命伤害时，消耗守护，免疫此次伤害，并恢复5点生命。守护由全队共享，不依赖本棋子存活。',
  'fel-blessing': '使地图上1个友方棋子攻击力+2，然后使其受到2点真实伤害。',
  'freeze-prevent': '冰冻期间，不能主动走格或使用技能。',
  'frostbolt': '对本棋子5格内1个敌方棋子造成等同于本棋子攻击力的法术伤害，并使其获得冰冻，持续1回合。',
  'grant-lucky-coin': '游戏开始时，你获得1张【幸运币】。',
  'grimmjow-destruction-instinct': '每次攻击后，本棋子受到1点真实伤害。',
  'grimmjow-hunting-instinct': '敌方棋子行动后，若其位于本棋子4格内，可将本棋子移动至2格内1个空地格。若随后与该敌方棋子相邻，则攻击其2次，每次造成等同于本棋子攻击力75%的物理伤害。',
  'hardy-block': '持续2回合：本棋子受到伤害时，攻击力增加等同于此次伤害50%的数值。',
  'hardy-block-trigger': '本棋子受到伤害时，攻击力增加等同于此次伤害50%的数值。',
  'hashirama-edo-sage-buddha': '将本棋子传送至以本棋子为中心的5×5范围内1个地格，重置其他技能冷却，你获得1张【木遁·真数千手】和1张【仙术·大自然愈合】。',
  'hashirama-edo-wood-spike': '对本棋子4格内1个敌方棋子造成等同于本棋子攻击力的物理伤害，并使其获得沉默，持续1回合。',
  'hidan-blood-oath': '使本棋子4格内1个目标获得血誓诅咒，持续3回合。本棋子受到伤害时，对被诅咒目标造成等量真实伤害。',
  'hidan-sacrifice': '本棋子受到4点真实伤害。若血誓诅咒已生效，对被诅咒目标造成4点真实伤害，再造成等同于本棋子已损失生命值1/3的真实伤害。',
  'holy-light-descend': '选择本棋子6格内1个地格。对该格中的友方棋子恢复9点生命，对敌方棋子造成9点法术伤害；距离该格1格时，数值为7；距离该格2至3格时，数值为4。',
  'ichigo-zangetsu': '对本棋子相邻的1个敌方棋子造成等同于本棋子攻击力的物理伤害。',
  'illidan-eye-beam': '对本棋子4格内1个敌方棋子造成等同于本棋子攻击力的法术伤害，并使本棋子恢复等量生命。',
  'light-of-the-light': '使本棋子7格内1个友方棋子恢复5点生命。',
  'nano-boost': '使本棋子10格内1个其他友方棋子防御力+3、移动力+1，造成的伤害+1。',
  'naruto-rasengan': '对本棋子2格内1个敌方棋子造成等同于本棋子攻击力200%的法术伤害，并使其获得沉默，持续1回合。',
  'naruto-sage-mode': '进入打坐状态，准备进度为6。打坐期间，不能主动走格或使用技能。你的回合开始时，准备进度减少1，每个存活的友方影分身额外减少1。准备进度归零时，结束打坐，你获得3行动点和1充能。',
  'naruto-shadow-clone': '选择本棋子5格内1个空地格，并秘密选择一项：召唤1个影分身；或将本棋子传送至目标格，并在原地留下1个影分身。影分身受到1次伤害后消散，不能行动，被击杀时不提供充能。',
  'naruto-vanguard': '当阵容中有本棋子时，本棋子首先上场。',
  'obito-ally-teleport': '选择本棋子7格内1个其他友方棋子，将其传送至本棋子7格内1个空的可行走地格。',
  'obito-grudge': '友方棋子受到伤害时，本棋子获得1层怨念，最多3层。每层怨念使攻击力+2。你的回合结束时，清空怨念。',
  'obito-space-time': '万花筒。选择地图上1个敌方棋子，将其强制移出战场。每局限用1次。',
  'reap': '本棋子造成实际伤害后，恢复等同于实际伤害50%的生命。',
  'reap-heal': '使本棋子恢复等同于本次实际伤害50%的生命。',
  'rocket-punch': '选择同一行或同一列的方向，冲刺最多5格，在遇到的首个棋子或障碍前停下。若该棋子为敌方棋子，对其造成等同于本棋子攻击力250%的物理伤害。',
  'shadow-step': '标记本棋子7格内1个空地格。你的下一个回合开始时，将本棋子传送至该地格。',
  'shadow-step-teleport': '你的回合开始时，将本棋子传送至预设地格。',
  'shield-of-light': '使本棋子7格内1个友方棋子获得圣盾。若目标是本棋子，你恢复1行动点。',
  'shishio-infinite-blade': '对本棋子2格内1个敌方棋子造成真实伤害。结算后，你可使本棋子受到1点真实伤害并再次发动，无需额外行动点。伤害倍率依次为本棋子攻击力的100%、150%、200%，每击杀1个棋子提高一级。',
  'sleep-dart': '弹射物。选择同一行或同一列的方向，发射麻醉镖。使路径上首个命中的敌方棋子获得睡眠，持续2回合。',
  'sleep-prevent': '睡眠期间，不能主动走格或使用技能。',
  'sleep-remove': '受到伤害后，移除睡眠。',
  'sonic-free-move-passive': '你的回合开始时，本棋子获得1次免费普通移动。',
  'soul-fracture': '游戏开始时，在本局游戏中每当一个棋子死亡，获得一张灵魂残片。',
  'tails-armor-assembly': '选择2个不同模块，创造1张护甲手牌，消耗2行动点可对本棋子或1个友方棋子使用。恢复模块：持有者的回合结束时，恢复3点生命；攻击模块：攻击力+3；高速模块：持有者每回合获得1次免费普通移动；硬化模块：防御力+2。护甲可叠加，持续本局游戏。',
  'tails-mechanical-support': '使本棋子7格内1个友方棋子恢复5点生命，然后可选择移除其1个效果。动能4：治疗量+2。动能8：目标的下一次普通移动免费。',
  'tails-twin-flight': '选择本棋子4格内1个其他友方棋子。选择本棋子7格内1个合法地格作为本棋子的落点，再选择本棋子7格内、与前一落点相邻的合法地格作为友方棋子的落点。预留这两个落点，两者获得免疫与不可操作，持续2回合。在接下来的第二个你的回合结束时，将两者分别传送至预留落点。',
  'tirion-divine-glory': '游戏开始时，本棋子获得圣盾。本棋子失去圣盾时，攻击力+1。',
  'ulquiorra-resurreccion': '本棋子累计造成或受到3次伤害后，在你的下一个回合开始时归刃：攻击力+1、移动力+1，并获得【黑虚闪】。',
  'venom-corrosion': '本棋子改变敌方棋子的位置时，使其获得定身，持续1回合。',
  'venom-host-transfer': '选择本棋子7格内1个其他棋子，与其换位。',
  'watcher-form': '你的回合开始时，选择获得1张【平静】或【暴怒】。【平静】提供护盾，【暴怒】提高伤害。',
};
function normalize(source) {
  return source.replace(/魔法伤害/g, '法术伤害').replace(/移速|移动值|移动范围/g, '移动力')
    .replace(/失去当前生命值50%/g, '受到等同于其当前生命值50%的真实伤害')
    .replace(/波风水门|水门|基尔加丹|格力姆乔|蓝染|索尼克|毒液|维伦/g, '本棋子')
    .replace(/本棋子自己的回合结束时/g, '你的回合结束时').replace(/一名/g, '1个').replace(/五格/g, '5格')
    .replace(/你的下1个回合/g, '你的下一个回合').replace(/对方下回合/g, '对方的下一个回合')
    .replace(/获得两(?:点)?临时行动点/g, '你获得2临时行动点').replace(/包括自己/g, '包括本棋子')
    .replace(/自身/g, '本棋子').replace(/敌方角色|敌军|敌人/g, '敌方棋子').replace(/友方角色|友军/g, '友方棋子')
    .replace(/角色/g, '棋子').replace(/(\d+)名/g, '$1个').replace(/一个/g, '1个')
    .replace(/(\d+)[xX*](\d+)/g, '$1×$2').replace(/回复/g, '恢复').replace(/冻结/g, '冰冻')
    .replace(/等同于攻击力/g, '等同于本棋子攻击力').replace(/等同攻击力/g, '等同于本棋子攻击力')
    .replace(/造成(\d+)%攻击力的/g, '造成等同于本棋子攻击力$1%的').replace(/造成攻击力(\d+)%的/g, '造成等同于本棋子攻击力$1%的')
    .replace(/己方下回合开始/g, '你的下一个回合开始时').replace(/下个己方回合开始时/g, '你的下一个回合开始时')
    .replace(/每个己方回合开始时/g, '你的回合开始时').replace(/己方回合结束时/g, '你的回合结束时')
    .replace(/己方回合/g, '你的回合').replace(/点临时行动点/g, '临时行动点').replace(/\bHP\b/g, '生命值')
    .replace(/下1个回合/g, '下一个回合');
}
function preview(source, oldDescription, newDescription) {
  const tree = ts.createSourceFile('preview.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  function strings(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      let value = node.text === oldDescription ? newDescription : normalize(node.text);
      if (value !== node.text) edits.push({ start: node.getStart(tree), end: node.end, value: JSON.stringify(value) });
    } else ts.forEachChild(node, strings);
  }
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree).replace(/['"]/g, '') === 'description') {
      if (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer)) {
        if (node.initializer.text !== newDescription) edits.push({ start: node.initializer.getStart(tree), end: node.initializer.end, value: JSON.stringify(newDescription) });
      } else strings(node.initializer);
    }
    else ts.forEachChild(node, visit);
  }
  visit(tree);
  for (const edit of edits.sort((a,b) => b.start-a.start)) source = source.slice(0,edit.start) + edit.value + source.slice(edit.end);
  return source;
}
const rows = [];
const reportPath = 'docs/qa/RED-192-skill-language-audit.json';
const previousRows = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')).entries : [];
for (const name of fs.readdirSync('data/skills').filter(name => name.endsWith('.json') && name !== 'manifest.json').sort()) {
  const file = path.join('data/skills', name), source = fs.readFileSync(file,'utf8'), skill = JSON.parse(source);
  const before = skill.description;
  skill.description = explicit[skill.id] || normalize(before);
  if (!/[。！？]$/.test(skill.description)) skill.description += '。';
  if (skill.targetText) skill.targetText = normalize(skill.targetText);
  if (skill.previewCode) {
    skill.previewCode = preview(skill.previewCode, before, skill.description);
    if (skill.id === 'rocket-punch') skill.previewCode = skill.previewCode.replace('向直线方向冲刺最多5格，对首个路径敌方棋子造成', '选择直线方向，冲刺最多5格，在首个棋子或障碍前停下。若该棋子为敌方棋子，对其造成');
    if (skill.id === 'blizzard') skill.previewCode = skill.previewCode.replace('在全场1个地格周围召唤7×7暴风雪区域。敌方回合结束时，区域内敌方棋子受到', '选择地图上1个地格，形成以该格为中心的7×7暴风雪区域。对方的下一个回合结束时，区域内敌方棋子受到').replace('点法术伤害，并冰冻1回合。', '点法术伤害，并获得冰冻，持续1回合。随后暴风雪消散。');
  }
  const changed = JSON.stringify(skill) !== JSON.stringify(JSON.parse(source));
  const original = previousRows.find(row => row.id === skill.id);
  rows.push({ id: skill.id, name: skill.name, before: original?.before ?? before, after: skill.description, changed: changed || Boolean(original?.changed), executableCodeChanged: false });
  if (process.argv.includes('--write') && changed) fs.writeFileSync(file, JSON.stringify(skill,null,2)+'\n');
}
if (process.argv.includes('--write')) {
  const report = 'docs/qa/RED-192-skill-language-audit.json';
  fs.writeFileSync(report, JSON.stringify({ schema: 'rvb-skill-language-review/v1', description: '完整技能清单，含辅助/遗留技能；文案迁移不修改code。已确认的独立机制修复另有提交差异与测试。', entries: rows },null,2)+'\n');
}
console.log(JSON.stringify({ reviewed:rows.length, changed:rows.filter(row=>row.changed).length, write:process.argv.includes('--write') }));
