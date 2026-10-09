/* Local capability stays in memory; reopening the launcher creates a fresh tab. */
const token = location.hash.slice(1) || sessionStorage.getItem('rvb-admin-session') || ''
if (token) sessionStorage.setItem('rvb-admin-session', token);
history.replaceState(null, '', '/');
const $ = id => document.getElementById(id);
let view = 'overview', snapshot, offset = 0, query = '', busy = false, stopped = false, generation = 0;
let communityOffset = 0, communityQuery = '', communityStatus = 'all';
const names = { 'map-pool': '修改排位地图池', maintenance: '匹配维护', ban: '封禁账号', unban: '解封账号', season: '切换赛季', stop: '停止服务', kick: '踢下线', 'rank-disable': '限制排位资格', 'rank-enable': '恢复排位资格', 'cooldown-clear': '解除匹配冷却', 'queue-clear': '清空匹配队列', capacity: '修改并发上限', announcement: '更新公告', 'void-match': '作废异常对局', 'smtp-save': '修改SMTP', 'backup-create': '创建备份', 'backup-check': '校验备份', 'backup-restore': '恢复备份', 'community-hide': '隐藏社区内容', 'community-restore': '恢复社区内容', 'community-restore-post': '恢复帖子', 'community-restore-reply': '恢复回复' };
const date = value => value ? new Date(value).toLocaleString('zh-CN') : '尚无记录';
function notice(text) { $('notice').textContent = text; }
function clearStaleConnectionNotice() {
  const current = $('notice').textContent;
  if (/尚未连接服务器|连接或读取失败|连接失败|缺少本机管理会话|管理会话失效/.test(current)) notice('');
}
async function api(route, body) {
  const response = await fetch('/api/' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(body?.action?.startsWith('backup-') ? 300000 : 30000) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '服务暂时不可用'); return result;
}
function details(id, pairs) { $(id).replaceChildren(...pairs.flatMap(([key, value]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = key; dd.textContent = String(value); return [dt, dd]; })); }
function cell(text, sub) { const td = document.createElement('td'); td.textContent = String(text ?? '—'); if (sub) { const small = document.createElement('small'); small.textContent = sub; td.append(small); } return td; }
function rows(id, entries, columns) { if (entries.length) $(id).replaceChildren(...entries); else { const tr = document.createElement('tr'), td = cell('暂无记录'); td.colSpan = columns; tr.append(td); $(id).replaceChildren(tr); } }
function capability(name) { return snapshot?.capabilities?.[name] === true; }
function featureNotice(id, text, visible = true) {
  const element = $(id); if (!element) return;
  element.hidden = !visible; element.textContent = visible ? text : '';
}
function mapPoolReason(reason) {
  const messages = {
    'ranked-map-pool-format-invalid': '当前排位地图池配置格式无效，请重新选择并保存。',
    'ranked-map-pool-contains-duplicate-map': '当前排位地图池包含重复地图，请重新选择并保存。',
    'ranked-map-pool-contains-unavailable-map': '当前启用的地图在资源包中不可用，排位匹配已暂停。请重新选择并保存地图池。',
    'ranked-map-pool-requires-at-least-3-maps': '排位地图池至少需要3张可用地图，请选择并保存地图。',
  };
  if (messages[reason]) return messages[reason];
  return reason && !/^[a-z0-9][a-z0-9-]*$/.test(reason) ? reason : '当前排位地图池不可用，请重新选择并保存。';
}
function mapCatalogReason(reason) {
  const messages = {
    'reserved-for-2v2': '仅限 2v2 模式，不能加入排位地图池。',
    'not-available-for-pvp': '当前地图不可用于 PVP 排位。',
    'fewer-than-16-deployment-cells': '部署格少于16个，不能用于排位。',
    'invalid-schema': '地图配置无效，不能用于排位。',
  };
  if (messages[reason]) return messages[reason];
  return reason && !/^[a-z0-9][a-z0-9-]*$/.test(reason) ? reason : '当前资源不可用于排位。';
}
function renderMapPool() {
  const s = snapshot, rankedMaps = s?.rankedMaps, options = $('map-pool-options');
  if (!options) return;
  const hasCatalog = Array.isArray(rankedMaps?.catalog);
  const supported = capability('rankedMapCatalog') && hasCatalog;
  featureNotice('map-pool-upgrade', '当前服务器不支持资源包地图目录。请升级服务器后再管理排位地图；其他管理功能仍可使用。', !supported);
  const catalog = hasCatalog ? rankedMaps.catalog : [];
  const enabled = new Set(Array.isArray(rankedMaps?.enabledIds) ? rankedMaps.enabledIds : (s?.settings?.ranked_maps || []));
  const invalid = new Set(Array.isArray(rankedMaps?.invalidIds) ? rankedMaps.invalidIds : []);
  const unavailable = catalog.filter(map => map && map.eligible === false);
  const blocked = Boolean(rankedMaps?.blocked || invalid.size || unavailable.some(map => enabled.has(map.id)));
  featureNotice('map-pool-warning', blocked ? mapPoolReason(rankedMaps?.reason) : '', blocked);
  const state = $('map-pool-state');
  if (state) { state.textContent = !supported ? '需要升级' : blocked ? '已阻止匹配' : catalog.length ? `${enabled.size} 张已启用` : '无地图目录'; state.dataset.state = blocked ? 'blocked' : supported && catalog.length ? 'ready' : ''; }
  // Preserve an administrator's in-progress selection while the five-second
  // snapshot poll continues. The explicit save below clears this marker.
  if ($('map-pool-form')?.dataset.edited) return;
  if (!supported) { options.replaceChildren(); const text = document.createElement('p'); text.className = 'muted'; text.textContent = '此服务器未提供地图目录。'; options.append(text); return; }
  if (!catalog.length) { options.replaceChildren(); const text = document.createElement('p'); text.className = 'muted'; text.textContent = '当前资源包没有可识别的地图。'; options.append(text); return; }
  const entries = catalog.map(map => {
    const label = document.createElement('label'); label.className = 'map-option';
    const unavailableReason = mapCatalogReason(map.reason);
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = String(map.id); input.checked = enabled.has(map.id); input.disabled = map.eligible === false; input.title = map.eligible === false ? unavailableReason : '由管理员选择是否加入排位地图池';
    const body = document.createElement('span'); body.className = 'map-option-body';
    const name = document.createElement('span'); name.className = 'map-option-name'; name.textContent = String(map.name || map.id); body.append(name);
    const meta = document.createElement('span'); meta.className = 'map-option-meta';
    const unavailable = map.eligible === false, selected = enabled.has(map.id), missing = invalid.has(map.id);
    meta.textContent = unavailable ? unavailableReason : missing ? '已启用但当前资源中不存在' : selected ? '已加入排位池' : '未启用（新地图默认关闭）';
    const state = document.createElement('span'); state.className = 'map-option-state' + (unavailable || missing ? ' invalid' : selected ? '' : ' off'); state.textContent = unavailable || missing ? '不可用' : selected ? '启用' : '关闭'; meta.append(' ', state); body.append(meta); label.append(input, body); return label;
  });
  for (const id of invalid) if (!catalog.some(map => map.id === id)) {
    const label = document.createElement('label'); label.className = 'map-option'; const input = document.createElement('input'); input.type = 'checkbox'; input.value = id; input.checked = true; input.disabled = true; const body = document.createElement('span'); body.className = 'map-option-body'; const name = document.createElement('span'); name.className = 'map-option-name'; name.textContent = id; const meta = document.createElement('span'); meta.className = 'map-option-meta'; meta.textContent = '已启用但当前资源中不存在'; const state = document.createElement('span'); state.className = 'map-option-state invalid'; state.textContent = '需移除'; meta.append(' ', state); body.append(name, meta); label.append(input, body); entries.push(label);
  }
  options.replaceChildren(...entries);
}
function renderSnapshot() {
  const s = snapshot; $('active').textContent = s.counts.active; $('queued').textContent = s.counts.queued; $('connections').textContent = s.connections; $('account-count').textContent = s.counts.accounts;
  $('capacity').textContent = '并发上限 ' + s.health.maxMatches + ' 局'; $('season-label').textContent = s.settings.season_id;
  const mapBlocked = Boolean(s.rankedMaps?.blocked);
  $('connection').textContent = !s.health.settlementHealthy ? '排位结算异常 · 请检查终端' : mapBlocked ? '排位地图池异常 · 已暂停新匹配' : s.settings.maintenance ? '维护中 · 已有对局继续' : '运行中 · 接受新匹配';
  const playerLink = $('player-link'); if (s.playerUrl) { playerLink.hidden = false; playerLink.href = s.playerUrl; } else { playerLink.hidden = true; playerLink.removeAttribute('href'); }
  details('runtime', [['已运行', Math.floor(s.runtime.uptimeSeconds / 60) + ' 分钟'], ['服务内存', s.runtime.memoryMiB + ' MiB'], ['数据库', '已连接 · PostgreSQL'], ['数据库连接池', s.runtime.poolActive + ' 使用中 / ' + s.runtime.poolWaiting + ' 等待'], ['排位结算', s.health.settlementHealthy ? '正常' : '异常，请检查服务终端'], ['累计结算', s.counts.settled + ' 局']]);
  const m = s.mail; details('mail-details', [['SMTP 服务器', m.host + ':' + m.port], ['连接检查', m.connected === null ? '本次启动尚未检查' : m.connected ? '连接与认证通过' : '失败，请检查配置'], ['检查时间', date(m.checkedAt)], ['提交 SMTP 成功', m.sent + ' 封（不代表已送达收件箱）'], ['发送失败', m.failed + ' 封'], ['最近成功', date(m.lastSentAt)], ['最近失败', date(m.lastFailedAt)]]);
  $('maintenance-state').textContent = mapBlocked ? '地图池存在不可用地图，已阻止新排位匹配。保存修复后的地图池后才会恢复。' : s.settings.maintenance ? '已开启维护，不再分配新对局。' : '匹配开放中。'; $('maintenance').textContent = s.settings.maintenance ? '恢复匹配…' : '开启维护…';
  $('updated').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');
  clearStaleConnectionNotice();
  renderMapPool();
}
async function loadView(ticket) {
  if (view === 'settings') {
    if (document.activeElement !== $('capacity-input')) $('capacity-input').value = snapshot.health.maxMatches;
    if (document.activeElement !== $('announcement-input') && !$('announcement-input').dataset.edited) $('announcement-input').value = snapshot.settings.announcement || '';
  }
  if (view === 'mail' || view === 'backups') {
    const result = await api('config'); if (ticket !== generation) return;
    if (view === 'mail' && !$('smtp-form').dataset.loaded) { for (const field of ['host', 'port', 'user', 'from']) $('smtp-' + field).value = result.smtp[field]; $('smtp-form').dataset.loaded = 'true'; }
    if (view === 'backups') rows('backup-rows', result.backups.map(b => { const tr = document.createElement('tr'), td = document.createElement('td'); td.append(actionButton('backup-check', b.id, '验证备份中每个文件的完整性。'), actionButton('backup-restore', b.id, '将账号和战绩恢复到 ' + date(b.createdAt) + '。之后新增的数据将从当前数据库移出；执行前会自动备份当前数据。')); tr.append(cell(date(b.createdAt), b.id), cell(b.invalid ? '清单损坏' : (b.bytes / 1048576).toFixed(1) + ' MiB'), td); return tr; }), 3);
  }
  if (view === 'accounts') {
    const result = await api('accounts?q=' + encodeURIComponent(query) + '&offset=' + offset); if (ticket !== generation) return;
    rows('account-rows', result.rows.map(a => { const tr = document.createElement('tr'), action = document.createElement('button'), td = document.createElement('td'); action.textContent = a.banned ? '解封…' : '封禁…'; action.onclick = () => confirmAction(a.banned ? 'unban' : 'ban', a.id, (a.banned ? '允许此账号重新登录与匹配：' : '撤销此账号登录并取消排队：') + a.name + '（' + a.id + '）'); td.append(action, actionButton('kick', a.id, '撤销全部登录并立即断开此玩家的对局连接；重新登录后仍可重连。'), actionButton(a.ranked_disabled ? 'rank-enable' : 'rank-disable', a.id, '只调整后续匹配资格，已开始的比赛正常进行。')); if (a.cooldown_until) td.append(actionButton('cooldown-clear', a.id, '解除此账号的匹配冷却，保留掉线记录。')); tr.append(cell(a.name, a.id), cell(a.email), cell(a.rating + ' / ' + a.games), cell(a.banned ? '已封禁' : a.ranked_disabled ? '排位受限' : '正常'), td); return tr; }), 5);
    $('previous').disabled = offset === 0; $('next').disabled = !result.more; $('page-label').textContent = '第' + (offset / 30 + 1) + '页';
  } else if (view === 'community') {
    const supported = capability('communityModeration');
    const searchSupported = capability('communitySearch');
    featureNotice('community-upgrade', !supported ? '当前服务器不支持社区审核接口。请升级服务器后再管理公告板；其他管理功能仍可使用。' : !searchSupported ? '当前服务器不支持公告板搜索与状态筛选。请升级服务器后使用筛选；其他审核功能仍可使用。' : '', !supported || !searchSupported);
    $('community-query').disabled = !searchSupported;
    $('community-status').disabled = !searchSupported;
    $('community-search').disabled = !searchSupported;
    if (!supported) {
      rows('community-rows', [], 4);
      $('community-previous').disabled = true;
      $('community-next').disabled = true;
      $('community-page').textContent = '暂不可用';
      return;
    }
    const restoreSupported = capability('communityRestore');
    const query = searchSupported ? '&q=' + encodeURIComponent(communityQuery) + '&status=' + encodeURIComponent(communityStatus) : '';
    const result = await api('community?offset=' + communityOffset + query); if (ticket !== generation) return;
    $('community-previous').disabled = communityOffset === 0;
    $('community-next').disabled = !result.more || communityOffset >= 1000000;
    $('community-page').textContent = '第' + (communityOffset / 100 + 1) + '页';
    const entries = [
      ...(Array.isArray(result.posts) ? result.posts : []).map(p => ({ kind: '帖子', type: 'post', id: p.id, author: p.author?.name || p.author?.id, text: (p.title ? p.title + '：' : '') + p.body, date: p.createdAt, hidden: p.hidden, deleted: p.deleted })),
      ...(Array.isArray(result.replies) ? result.replies : []).map(p => ({ kind: '回复', type: 'reply', id: p.id, author: p.author?.name || p.author?.id, text: p.body, date: p.createdAt, hidden: p.hidden, deleted: p.deleted })),
    ];
    entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    rows('community-rows', entries.map(entry => {
      const tr = document.createElement('tr'), action = document.createElement('td');
      tr.append(cell(entry.kind, entry.author), cell(entry.text), cell(date(entry.date)));
      const status = document.createElement('span'); status.className = entry.deleted ? 'community-status-deleted' : entry.hidden ? 'community-status-hidden' : 'community-status-visible'; status.textContent = entry.deleted ? '作者已删除' : entry.hidden ? '已隐藏' : '可见'; action.append(status);
      if (entry.hidden || entry.deleted) {
        if (restoreSupported && !entry.deleted) action.append(actionButton('community-restore-' + entry.type, entry.id, '恢复后玩家可以在社区看到这条内容。'));
      } else if (supported) action.append(actionButton('community-hide', entry.type + ':' + entry.id, '隐藏后玩家将无法在社区看到这条内容。'));
      tr.append(action); return tr;
    }), 4);
  } else if (view === 'matches') {
    const result = await api('matches?status=' + $('match-filter').value); if (ticket !== generation) return;
    rows('match-rows', result.rows.map(m => { const tr = document.createElement('tr'); const winner = m.winner_id === m.first_id ? m.first_name : m.second_name; tr.append(cell(m.first_name + ' vs ' + m.second_name, m.id), cell(m.season_id), cell(m.status === 'assigned' ? '准备 / 进行中' : m.status === 'void' ? '作废 · 不计分' : m.winner_id ? winner + ' 获胜' : '和局'), cell(date(m.created_at))); const td = document.createElement('td'); if (m.status === 'assigned') td.append(actionButton('void-match', m.id, '关闭异常对局并释放双方席位，不增减积分。若对局已正常结束，将保留结算并拒绝作废。')); else td.textContent = m.reason || '—'; tr.append(td); return tr; }), 5);
  } else if (view === 'audit') {
    const result = await api('audit'); if (ticket !== generation) return;
    rows('audit-rows', result.rows.map(a => { const tr = document.createElement('tr'); tr.append(cell(date(a.created_at)), cell(names[a.action] || a.action), cell(a.value), cell(a.reason)); return tr; }), 4);
  }
}
async function refresh() {
  if (stopped || busy || document.documentElement?.dataset?.remoteOpsBusy === 'true') return; const ticket = ++generation;
  try { const value = await api('snapshot'); if (ticket !== generation) return; snapshot = value; renderSnapshot(); await loadView(ticket); }
  catch (error) {
    if (ticket !== generation || document.documentElement?.dataset?.remoteOpsBusy === 'true') return;
    const message = error?.message || '';
    if (/尚未连接服务器|请先填写 SSH 连接配置并连接指挥台/.test(message)) {
      $('connection').textContent = '尚未连接本机服务器 · 请先连接指挥台';
      clearStaleConnectionNotice();
      return;
    }
    $('connection').textContent = '连接或读取失败 · 数据可能已过期'; notice(message || '连接失败，请确认服务器仍在运行');
  }
}
function actionButton(action, value, text) { const button = document.createElement('button'); button.textContent = names[action] + '…'; button.onclick = () => confirmAction(action, value, text); return button; }
async function perform(action, value, extra = {}) {
  if (busy || stopped) return; busy = true; ++generation; document.querySelectorAll('button').forEach(b => { b.disabled = true; }); notice('正在执行，请稍候…');
  try { await api('action', { action, value, ...extra }); if (action === 'map-pool') delete $('map-pool-form').dataset.edited; if (action === 'smtp-save') { $('smtp-password').value = ''; delete $('smtp-form').dataset.loaded; } if (action === 'announcement') delete $('announcement-input').dataset.edited; if (action === 'stop') { stopped = true; $('connection').textContent = '停止请求已接受'; notice('服务器正在保存数据并停止。请等待服务终端显示数据库已停止，再关闭终端或备份。重新启动请运行 Start-Official.cmd。'); }
    else notice(action === 'mail-check' ? 'SMTP连接与认证通过；请通过注册流程确认真实送达。' : '操作成功，管理操作已记录。');
  } catch (error) { notice(error.message); }
  finally { busy = false; if (!stopped) { document.querySelectorAll('button').forEach(b => { b.disabled = false; }); await refresh(); } }
}
async function confirmAction(action, value, text, extra = {}) {
  if (busy || stopped || $('confirm').open) return;
  $('confirm-reason').value = ''; $('confirm-reason').required = !['maintenance', 'ban', 'unban', 'season', 'stop'].includes(action);
  $('confirm-title').textContent = names[action]; $('confirm-text').textContent = text; $('confirm').returnValue = ''; $('confirm').showModal();
  $('confirm').addEventListener('close', () => { if ($('confirm').returnValue === 'ok') void perform(action, value, { ...extra, reason: $('confirm-reason').value.trim() }); }, { once: true });
}
document.querySelectorAll('[data-view]').forEach(button => { button.onclick = () => { view = button.dataset.view; document.querySelectorAll('main section').forEach(s => { s.hidden = s.id !== view; }); document.querySelectorAll('[data-view]').forEach(b => { if (b === button) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }); if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'smooth' }); void refresh(); }; });
$('search').onsubmit = event => { event.preventDefault(); query = $('query').value.trim(); offset = 0; void refresh(); };
$('previous').onclick = () => { offset = Math.max(0, offset - 30); void refresh(); }; $('next').onclick = () => { offset += 30; void refresh(); };
$('refresh').onclick = refresh; $('match-filter').onchange = refresh; $('mail-check').onclick = () => perform('mail-check', '');
if ($('community-refresh')) $('community-refresh').onclick = refresh;
if ($('community-previous')) $('community-previous').onclick = () => { communityOffset = Math.max(0, communityOffset - 100); void refresh(); };
if ($('community-next')) $('community-next').onclick = () => { communityOffset += 100; void refresh(); };
$('maintenance').onclick = () => { if (snapshot) void confirmAction('maintenance', snapshot.settings.maintenance ? 'off' : 'on', snapshot.settings.maintenance ? '恢复后将继续分配新对局。' : '开启后停止新增匹配；正在进行的对局不受影响。'); };
$('new-season').onclick = () => { const id = $('season-id').value.trim(); if (!/^[a-z0-9-]{1,40}$/.test(id)) { notice('赛季编号只能包含小写字母、数字、连字符，1–40字符。'); return; } void confirmAction('season', id, '开启正式赛季 ' + id + '？当前积分保留在旧赛季，新赛季从1000开始。此操作不能撤销，请先开启维护并确认对局全部结束。'); };
$('stop').onclick = () => confirmAction('stop', '', '确认正常停止服务器？有未结束对局时会拒绝操作。停止后需要重新运行 Start-Official.cmd；重启后仍处于维护状态。');
if (!token) { notice('请运行 Open-Control-Panel.cmd 打开管理面板。刷新此页会清除管理会话。'); $('connection').textContent = '缺少本机管理会话'; } else { void refresh(); setInterval(() => { if (!document.hidden && !$('confirm').open) void refresh(); }, 5000); }

$('capacity-form').onsubmit = e => { e.preventDefault(); void confirmAction('capacity', $('capacity-input').value, '保存并发上限，已有比赛继续。'); };
$('announcement-input').oninput = () => { $('announcement-input').dataset.edited = 'true'; };
$('announcement-form').onsubmit = e => { e.preventDefault(); void confirmAction('announcement', $('announcement-input').value, '保存后，玩家入口会显示新的公告。'); };
$('queue-clear').onclick = () => confirmAction('queue-clear', '', '取消所有等待中的匹配，已有比赛继续。');
$('backup-create').onclick = () => confirmAction('backup-create', '', '维护且无比赛时，短暂停服并创建数据库备份。完成后保持维护状态。');
$('smtp-form').onsubmit = e => { e.preventDefault(); const smtp = {}; for (const key of ['host', 'user', 'from', 'password']) smtp[key] = $('smtp-' + key).value; smtp.port = Number($('smtp-port').value); void confirmAction('smtp-save', '', '检查新SMTP连接，成功后保存；不发送邮件。', { smtp }); };

$('community-query').oninput = () => { communityQuery = $('community-query').value.trim(); };
$('community-status').onchange = () => { communityStatus = $('community-status').value; };
if ($('community-search')) $('community-search').onclick = () => { communityQuery = $('community-query').value.trim(); communityStatus = $('community-status').value; communityOffset = 0; void refresh(); };
if ($('community-query')) $('community-query').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); $('community-search').click(); } };
$('map-pool-form').onchange = event => { if (event.target.matches('input[type="checkbox"]')) $('map-pool-form').dataset.edited = 'true'; };
$('map-pool-form').onsubmit = e => { e.preventDefault(); if (!capability('rankedMapCatalog')) { notice('当前服务器不支持资源包地图目录，请升级服务器。'); return; } const maps = Array.from(document.querySelectorAll('#map-pool-options input:checked:not(:disabled)'), input => input.value); if (maps.length < 3) { notice('至少保留3张可用地图。'); return; } void confirmAction('map-pool', JSON.stringify(maps), '保存地图池，仅对之后匹配的新对局生效。若之前有失效地图，保存后才会解除排位阻止。'); };
