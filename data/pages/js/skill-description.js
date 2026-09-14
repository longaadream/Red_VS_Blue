(function (root) {
  'use strict'

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
    })
  }

  function render(description, keywords) {
    const text = String(description || '')
    const names = Array.from(new Set((Array.isArray(keywords) ? keywords : [])
      .filter(function (name) { return typeof name === 'string' && name.length > 0 })))
      .sort(function (a, b) { return b.length - a.length || a.localeCompare(b) })
    let result = ''
    let plainStart = 0
    for (let cursor = 0; cursor < text.length;) {
      const keyword = names.find(function (name) { return text.startsWith(name, cursor) })
      if (!keyword) { cursor++; continue }
      result += escapeHtml(text.slice(plainStart, cursor))
      result += '<strong class="skill-description-keyword">' + escapeHtml(keyword) + '</strong>'
      cursor += keyword.length
      plainStart = cursor
    }
    return result + escapeHtml(text.slice(plainStart))
  }

  const guideKey = 'rvb_skill_reading_guide_v1'
  let acknowledged = false
  let guide = null

  function showGuide(manual) {
    if (guide || (!manual && acknowledged)) return
    try { if (!manual && root.localStorage.getItem(guideKey) === '1') return } catch { /* 本页仍可记住确认。 */ }
    const previousFocus = document.activeElement
    guide = document.createElement('dialog')
    guide.className = 'skill-reading-guide'
    guide.setAttribute('aria-labelledby', 'skill-reading-guide-title')
    guide.innerHTML = '<h2 id="skill-reading-guide-title">技能描述怎么看</h2>' +
      '<dl><dt>空地格（5）</dt><dd>选择5格内的空地格；（>6）表示6格外。</dd>' +
      '<dt>沉默[3]</dt><dd>沉默持续3回合。</dd>' +
      '<dt>中毒 x 2</dt><dd>强度或层数为2，具体效果看关键词说明。</dd>' +
      '<dt>2x攻击力</dt><dd>数值等于攻击力的2倍。</dd>' +
      '<dt><strong>粗体关键词</strong></dt><dd>状态或机制，可在关键词说明中查看含义。</dd></dl>' +
      '<p>句号分开的效果依次独立执行；逗号或“并”连接的后续效果，需要前项成功。</p>' +
      '<button type="button" autofocus>知道了</button>'
    guide.addEventListener('cancel', function (event) { event.preventDefault() })
    guide.addEventListener('keydown', function (event) { event.stopPropagation() })
    guide.querySelector('button').addEventListener('click', function () {
      acknowledged = true
      try { root.localStorage.setItem(guideKey, '1') } catch { /* 存储不可用时仅本页免打扰。 */ }
      guide.close()
      guide.remove()
      guide = null
      if (previousFocus && previousFocus.isConnected) previousFocus.focus()
    })
    document.body.appendChild(guide)
    guide.showModal()
  }

  root.RvBSkillDescription = Object.freeze({ render: render, showGuide: showGuide })
})(globalThis)
