/* Shared presentation only: no game commands or click handlers. */
(function (root) {
  'use strict'
  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    })
  }
  function artSource(image) {
    if (typeof image !== 'string' || image.length > 240 || !/\.(?:jpe?g|png|webp)$/i.test(image)) return null
    if (!image.split('/').every(function (part) { return !!part && part !== '.' && part !== '..' && /^[a-z0-9][a-z0-9._-]*$/i.test(part) })) return null
    return 'images/card-art/' + image
  }
  function render(card, definition, options) {
    const def = definition || {}, instance = card || {}, opts = options || {}
    const cardId = instance.cardId || def.id || ''
    const presentation = instance.presentation && typeof instance.presentation === 'object' ? instance.presentation : {}
    const cost = instance.actionPointCost != null ? instance.actionPointCost : (def.actionPointCost ?? 0)
    const src = Object.prototype.hasOwnProperty.call(opts, 'artSrc') ? opts.artSrc : artSource(def.image)
    const icon = escape(String(def.name || cardId || '牌').slice(0, 1))
    const art = src
      ? `<img src="${escape(src)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:8px 8px 0 0" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span style="display:none;font-size:28px;width:100%;height:100%;align-items:center;justify-content:center">${icon}</span>`
      : `<span style="font-size:28px">${icon}</span>`
    const badge = typeof presentation.badge === 'string' && presentation.badge ? `<span class="card-content-badge">${escape(presentation.badge)}</span>` : ''
    const description = typeof presentation.description === 'string' ? presentation.description : (def.description || '暂无描述')
    const type = def.type === 'reactive' ? '触发' : def.type === 'passive' ? '持续' : '主动'
    const cooldown = def.cooldownTurns ?? def.cooldown ?? 0
    return `<div class="card-mana-gem ${cost === 0 ? 'free' : ''}">${escape(cost)}</div>
      <div class="card-art">${art}${badge}</div>
      <div class="card-name-banner">${escape(def.name || cardId)}</div>
      <div class="card-body"><div class="card-desc">${escape(description)}</div>
      <div class="card-type-badge">${type}${cooldown > 0 ? `<span class="card-cooldown"> CD${escape(cooldown)}</span>` : ''}</div></div>`
  }
  function preview(cardId, definition) {
    const def = definition || {}
    return `<article class="card-item related-hand-card${def.type === 'reactive' ? ' card-reactive' : ''}" aria-label="${escape((def.name || cardId) + '，行动点 ' + (def.actionPointCost ?? 0))}">${render({ cardId }, def)}</article>`
  }
  root.HandCardFace = Object.freeze({ render, preview })
})(typeof window !== 'undefined' ? window : globalThis)
