/* Local capability stays in memory; reopening the launcher creates a fresh tab. */
const token = location.hash.slice(1);
history.replaceState(null, '', '/');
const $ = id => document.getElementById(id);
let view = 'overview', snapshot, offset = 0, query = '', busy = false, stopped = false, generation = 0;
const names = { maintenance: '匹配维护', ban: '封禁账号', unban: '解封账号', season: '切换赛季', stop: '停止服务', kick: '踢下线', 'rank-disable': '限制排位资格', 'rank-enable': '恢复排位资格', 'cooldown-clear': '解除匹配冷却', 'queue-clear': '清空匹配队列', capacity: '修改并发上限', announcement: '更新公告', 'void-match': '作废异常对局', 'smtp-save': '修改SMTP', 'backup-create': '创建备份', 'backup-check': '校验备份', 'backup-restore': '恢复备份' };
const date = value => value ? new Date(value).toLocaleString('zh-CN') : '尚无记录';
function notice(text) { $('notice').textContent = text; }
async function api(route, body) {
  const response = await fetch('/api/' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(body?.action?.startsWith('backup-') ? 300000 : 30000) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '服务暂时不可用'); return result;
}
function details(id, pairs) { $(id).replaceChildren(...pairs.flatMap(([key, value]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = key; dd.textContent = String(value); return [dt, dd]; })); }
function cell(text, sub) { const td = document.createElement('td'); td.textContent = String(text ?? '—'); if (sub) { const small = document.createElement('small'); small.textContent = sub; td.append(small); } return td; }
function rows(id, entries, columns) { if (entries.length) $(id).replaceChildren(...entries); else { const tr = document.createElement('tr'), td = cell('暂无记录'); td.colSpan = columns; tr.append(td); $(id).replaceChildren(tr); } }
function renderSnapshot() {
  const s = snapshot; $('active').textContent = s.counts.active; $('queued').textContent = s.counts.queued; $('connections').textContent = s.connections; $('account-count').textContent = s.counts.accounts;
  $('capacity').textContent = '并发上限 ' + s.health.maxMatches + ' 局'; $('season-label').textContent = s.settings.season_id;
  $('connection').textContent = s.health.settlementHealthy ? (s.settings.maintenance ? '维护中 · 已有对局继续' : '运行中 · 接受新匹配') : '排位结算异常 · 请检查终端';
  $('player-link').href = s.playerUrl;
  details('runtime', [['已运行', Math.floor(s.runtime.uptimeSeconds / 60) + ' 分钟'], ['服务内存', s.runtime.memoryMiB + ' MiB'], ['数据库', '已连接 · PostgreSQL'], ['数据库连接池', s.runtime.poolActive + ' 使用中 / ' + s.runtime.poolWaiting + ' 等待'], ['排位结算', s.health.settlementHealthy ? '正常' : '异常，请检查服务终端'], ['累计结算', s.counts.settled + ' 局']]);
  const m = s.mail; details('mail-details', [['SMTP 服务器', m.host + ':' + m.port], ['连接检查', m.connected === null ? '本次启动尚未检查' : m.connected ? '连接与认证通过' : '失败，请检查配置'], ['检查时间', date(m.checkedAt)], ['提交 SMTP 成功', m.sent + ' 封（不代表已送达收件箱）'], ['发送失败', m.failed + ' 封'], ['最近成功', date(m.lastSentAt)], ['最近失败', date(m.lastFailedAt)]]);
  $('maintenance-state').textContent = s.settings.maintenance ? '已开启维护，不再分配新对局。' : '匹配开放中。'; $('maintenance').textContent = s.settings.maintenance ? '恢复匹配…' : '开启维护…';
  $('updated').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');
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
  } else if (view === 'matches') {
    const result = await api('matches?status=' + $('match-filter').value); if (ticket !== generation) return;
    rows('match-rows', result.rows.map(m => { const tr = document.createElement('tr'); const winner = m.winner_id === m.first_id ? m.first_name : m.second_name; tr.append(cell(m.first_name + ' vs ' + m.second_name, m.id), cell(m.season_id), cell(m.status === 'assigned' ? '准备 / 进行中' : m.status === 'void' ? '作废 · 不计分' : m.winner_id ? winner + ' 获胜' : '和局'), cell(date(m.created_at))); const td = document.createElement('td'); if (m.status === 'assigned') td.append(actionButton('void-match', m.id, '关闭异常对局并释放双方席位，不增减积分。若对局已正常结束，将保留结算并拒绝作废。')); else td.textContent = m.reason || '—'; tr.append(td); return tr; }), 5);
  } else if (view === 'audit') {
    const result = await api('audit'); if (ticket !== generation) return;
    rows('audit-rows', result.rows.map(a => { const tr = document.createElement('tr'); tr.append(cell(date(a.created_at)), cell(names[a.action] || a.action), cell(a.value), cell(a.reason)); return tr; }), 4);
  }
}
async function refresh() {
  if (stopped || busy) return; const ticket = ++generation;
  try { const value = await api('snapshot'); if (ticket !== generation) return; snapshot = value; renderSnapshot(); await loadView(ticket); }
  catch (error) { if (ticket === generation) { $('connection').textContent = '连接或读取失败 · 数据可能已过期'; notice(error.message || '连接失败，请确认服务器仍在运行'); } }
}
function actionButton(action, value, text) { const button = document.createElement('button'); button.textContent = names[action] + '…'; button.onclick = () => confirmAction(action, value, text); return button; }
async function perform(action, value, extra = {}) {
  if (busy || stopped) return; busy = true; ++generation; document.querySelectorAll('button').forEach(b => { b.disabled = true; }); notice('正在执行，请稍候…');
  try { await api('action', { action, value, ...extra }); if (action === 'smtp-save') { $('smtp-password').value = ''; delete $('smtp-form').dataset.loaded; } if (action === 'announcement') delete $('announcement-input').dataset.edited; if (action === 'stop') { stopped = true; $('connection').textContent = '停止请求已接受'; notice('服务器正在保存数据并停止。请等待服务终端显示数据库已停止，再关闭终端或备份。重新启动请运行 Start-Official.cmd。'); }
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
document.querySelectorAll('[data-view]').forEach(button => { button.onclick = () => { view = button.dataset.view; document.querySelectorAll('main section').forEach(s => { s.hidden = s.id !== view; }); document.querySelectorAll('[data-view]').forEach(b => { if (b === button) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }); void refresh(); }; });
$('search').onsubmit = event => { event.preventDefault(); query = $('query').value.trim(); offset = 0; void refresh(); };
$('previous').onclick = () => { offset = Math.max(0, offset - 30); void refresh(); }; $('next').onclick = () => { offset += 30; void refresh(); };
$('refresh').onclick = refresh; $('match-filter').onchange = refresh; $('mail-check').onclick = () => perform('mail-check', '');
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
