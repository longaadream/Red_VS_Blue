;(function () {
  'use strict'
  function mount() {
    const entry = document.getElementById('rulebookButton')
    if (!entry) return
    const pawn = (x, y, rotation, fallen) => '<g transform="translate(' + x + ' ' + y + ') rotate(' + rotation + ')" class="rb-pawn"><path d="M-19 29q19-7 38 0l5 10q-24 9-48 0Z"/><path d="M-10 24-7 3h14l3 21 9 5q-20 5-38 0Z"/><path d="m-13-13 5 4 8-10 7 10 6-4-3 16h-20Z"/><path d="m-14 32 28 0m-20-17-2 8m18 9 4 3" class="rb-hatch"/>' + (fallen ? '<path d="m-5-4 10 8m-10 0 10-8" class="rb-cut"/>' : '<path d="m0-7 4 5-4 5-4-5Z" class="rb-blue"/>') + '</g>'
    const label = (x, y, value, cls) => '<text x="' + x + '" y="' + y + '" class="' + (cls || '') + '">' + value + '</text>'
    const arrow = '<path d="M113 77q36-14 70-4m-13-11 16 11-17 11" class="rb-arrow"/>'
    const illustration = (name, body) => '<svg viewBox="0 0 380 155" role="img" aria-label="' + name + '">' + body + '</svg>'
    const energy = illustration('行动点从1点逐回合增长至10点',
      '<path d="m28 36 29-9 22 15-2 52-27 8-25-19Z" class="rb-blue"/><path d="m31 39 24-8 17 15-1 43-21 8-21-17Z" class="rb-hatch"/>' + label(43, 76, '1', 'rb-number') + arrow + '<path d="m195 28 25-8 22 14-1 52-26 8-23-18Z" class="rb-blue"/><path d="m222 42 27-7 22 15-3 48-24 9-23-16Z" class="rb-blue"/>' + label(235, 84, '2', 'rb-number') + '<path d="M284 71h21" class="rb-arrow"/><path d="m319 34 33-8 18 25-4 41-34 8-19-21Z"/>' + label(326, 77, '10', 'rb-number') + label(30, 136, '从 1 点开始', 'rb-note') + label(212, 136, '补满 · 上限 10', 'rb-note'))
    const deploy = illustration('所有棋子五格以内不可部署，第六格可部署且首次移动免费',
      '<path d="m12 94 74-68 76 65-73 46Z" class="rb-redwash"/><path d="m24 91 64-54 62 52-62 38Z" class="rb-dashed"/>' + pawn(87, 63, -5, false) + '<path d="m27 93 20-14m-3 30 20-14m49 1 20-13" class="rb-hatch"/>' + label(19, 151, '≤ 5 格 ×', 'rb-note rb-redtext') + '<path d="M159 80q26-17 50-3m-9-10 11 10-14 10" class="rb-arrow"/>' + pawn(248, 61, 5, false) + '<path d="M260 112q48 8 84-22m-16 1 19-4-3 16" class="rb-arrow rb-greenstroke"/>' + label(218, 149, '第 6 格起 ✓', 'rb-note rb-greentext') + '<g transform="translate(322 41) rotate(9)"><path d="m-22-19 45 3-2 36-42-1Z"/><text x="-15" y="7" class="rb-note">0 点</text></g>')
    const ending = illustration('一方核心全部死亡则该方败北，2v2按队伍判定',
      pawn(73, 73, -73, true) + pawn(142, 72, 66, true) + '<path d="m35 117 131-2m-119 10 108-2" class="rb-hatch"/><path d="M193 42v69m5-71-1 67" class="rb-dashed"/><path d="M238 131 244 22l80 9-17 19 20 23-85-9"/><path d="m266 42 29 17m-28 1 28-18" class="rb-cut"/>' + label(27, 150, '己方核心全灭', 'rb-note') + label(262, 112, '败北', 'rb-number rb-redtext'))
    const crystal = illustration('核心死亡在原地留下充能结晶，走上去拾取获得一点充能',
      pawn(65, 82, -74, true) + arrow + '<path d="m234 18 27 42-29 53-28-53Z" class="rb-blue"/><path d="m234 18-6 44 4 51m-28-53 24 2 33-2" class="rb-hatch"/><path d="m192 38-12-8m93 5 14-12m-14 69 12 6m-96-12-11 7" class="rb-arrow"/><path d="M303 70q18 5 30-5m-10-5 12 4-7 11" class="rb-arrow"/>' + label(326, 51, '+1', 'rb-number') + label(161, 144, '走上去，拾取充能', 'rb-note'))
    const section = (number, title, art, caption) => '<section class="rb-rule"><h3><span>' + number + '</span>' + title + '</h3>' + art + '<p>' + caption + '</p></section>'
    const panel = document.createElement('dialog')
    panel.className = 'rulebook'
    panel.id = 'rulebook'
    panel.setAttribute('aria-labelledby', 'rulebookTitle')
    panel.innerHTML = '<header><div class="rb-heading"><small>RED vs BLUE · 对战速查</small><h2 id="rulebookTitle">上桌，记住这四件事</h2></div><button type="button" data-close aria-label="关闭规则书">×</button></header><div class="rb-sheet">' +
      section('Ⅰ', '新回合，行动点 +1', energy, '每次自己的回合，上限 +1 并补满。') +
      section('Ⅱ', '部署：离所有棋子 >5 格', deploy, '敌我都算，横竖相加。<br>部署当回合，首次普通移动免费。') +
      section('Ⅲ', '核心全灭，游戏结束', ending, '保护己方核心。2v2 按整支队伍判定。') +
      section('Ⅳ', '核心倒下，留下充能', crystal, '结晶留在原地，走上去获得 1 点充能。') +
      '</div><footer><span>● 行动点　◇ 充能点</span><span>PVP 基础规则 · 联机对局不会暂停</span></footer>'
    document.body.appendChild(panel)
    let hint = null
    const roomId = new URLSearchParams(location.search).get('roomId')
    const hintKey = roomId ? 'rvb-rulebook-seen:' + roomId : null
    let seen = false
    try { seen = hintKey && sessionStorage.getItem(hintKey) === '1' } catch { /* Storage may be unavailable; the page still remembers dismissal. */ }
    if (entry.closest('.topbar') && !seen) {
      hint = document.createElement('span')
      hint.id = 'rulebookHint'
      hint.className = 'rulebook-hint'
      hint.textContent = '点书本，查看规则 ↑'
      entry.appendChild(hint)
      entry.setAttribute('aria-describedby', hint.id)
    }
    panel.querySelector('[data-close]').onclick = () => panel.close()
    panel.addEventListener('keydown', event => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); panel.close() }
    })
    panel.addEventListener('close', () => { entry.setAttribute('aria-expanded', 'false'); entry.focus() })
    entry.onclick = () => {
      if (hint) { hint.remove(); hint = null; entry.removeAttribute('aria-describedby') }
      try { if (hintKey) sessionStorage.setItem(hintKey, '1') } catch { /* Dismissal still holds until this page closes. */ }
      if (!panel.open) panel.showModal()
      entry.setAttribute('aria-expanded', 'true')
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
  else mount()
})()
