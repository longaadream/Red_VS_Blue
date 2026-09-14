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

  root.RvBSkillDescription = Object.freeze({ render: render })
})(globalThis)
