const roster = document.getElementById('roster');
const search = document.getElementById('search');
const faction = document.getElementById('faction');
let pieces = [];
function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function image(src, alt, cls) {
  const img = el('img', undefined, cls);
  img.src = src; img.alt = alt; img.loading = 'lazy';
  return img;
}
function cost(item) {
  return '行动 ' + item.actionPointCost + ' · 充能 ' + item.chargeCost + ' · 冷却 ' + item.cooldownTurns + ' 回合';
}
function skillsSection(title, skills) {
  const section = el('section', undefined, 'atlas-section');
  section.append(el('h4', title, 'atlas-section-title'));
  for (const skill of skills) {
    const item = el('div', undefined, 'atlas-skill');
    item.append(el('h5', skill.name));
    if (skill.triggeredBy) item.append(el('p', '由「' + skill.triggeredBy + '」解锁', 'cost'));
    item.append(el('div', skill.kind === 'passive' ? '被动' : cost(skill), 'cost'), el('p', skill.description));
    section.append(item);
  }
  return section;
}
function render() {
  const q = search.value.trim().toLocaleLowerCase();
  const list = pieces.filter(p => {
    const content = [...p.skills, ...(p.transformedSkills || []), ...(p.relatedCards || []), ...(p.keywords || [])];
    const text = [p.name, p.role, ...content.map(s => [s.name, s.description, s.shortDescription, s.longDescription].join(' '))].join(' ').toLocaleLowerCase();
    return (faction.value === 'all' || p.faction === faction.value) && text.includes(q);
  });
  roster.replaceChildren();
  document.getElementById('count').textContent = list.length + ' 位棋子';
  if (!list.length) { roster.append(el('p', '没有找到匹配的棋子，试试其他关键词。', 'empty')); return; }
  for (const p of list) {
    const card = el('article', undefined, 'piece'), head = el('div', undefined, 'piece-head');
    if (p.image) head.append(image(p.image, p.name));
    const title = el('div'); title.append(el('h3', p.name), el('div', p.role, 'role')); head.append(title);
    card.append(head, el('p', ({good:'光方', evil:'暗方', neutral:'中立'})[p.faction] || p.faction, 'note'));
    const s = p.stats;
    card.append(el('div', '生命 ' + s.maxHp + ' · 攻击 ' + s.attack + ' · 防御 ' + s.defense + ' · 移动 ' + s.moveRange, 'stats'));
    const details = el('details');
    details.append(el('summary', '技能 · 关键词' + (p.relatedCards?.length ? ' · 相关卡牌' : '')));
    details.append(skillsSection('技能', p.skills));
    if (p.transformedSkills?.length) details.append(skillsSection('可解锁技能', p.transformedSkills));
    const keywords = el('section', undefined, 'atlas-section');
    keywords.append(el('h4', '关键词', 'atlas-section-title'));
    if (!p.keywords?.length) keywords.append(el('p', '无专属关键词', 'note'));
    for (const keyword of p.keywords || []) {
      keywords.append(el('h5', keyword.name), el('p', keyword.shortDescription));
      if (keyword.longDescription && keyword.longDescription !== keyword.shortDescription) keywords.append(el('p', keyword.longDescription, 'keyword-detail'));
    }
    details.append(keywords);
    if (p.relatedCards?.length) {
      const related = el('section', undefined, 'atlas-section');
      related.append(el('h4', '相关卡牌', 'atlas-section-title'));
      for (const c of p.relatedCards) {
        const hand = el('article', undefined, 'atlas-hand-card');
        if (c.image) hand.append(image(c.image, '', 'atlas-card-art'));
        const body = el('div', undefined, 'atlas-card-body');
        body.append(el('h5', c.name), el('div', (({active:'主动', reactive:'触发', passive:'持续'})[c.type] || '主动') + ' · ' + cost(c), 'cost'));
        if (c.targetText) body.append(el('p', '目标：' + c.targetText, 'note'));
        body.append(el('p', c.description)); hand.append(body); related.append(hand);
      }
      details.append(related);
    }
    card.append(details); roster.append(card);
  }
}
fetch('atlas.json').then(r => { if (!r.ok) throw Error('数据不可用'); return r.json(); }).then(data => {
  pieces = data.pieces;
  document.getElementById('atlas-version').textContent = data.label + ' · ' + pieces.length + ' 位棋子 · 从资源数据生成';
  render();
}).catch(() => { document.getElementById('atlas-version').textContent = '图鉴加载失败，请刷新重试。'; });
search.addEventListener('input', render);
faction.addEventListener('change', render);
