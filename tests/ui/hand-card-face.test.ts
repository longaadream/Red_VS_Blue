import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, Script } from 'node:vm'
import { describe, expect, it } from 'vitest'

const context = createContext({})
new Script(readFileSync(resolve('data/pages/js/hand-card-face.js'), 'utf8')).runInContext(context)
const face = context.HandCardFace

describe('shared read-only hand card face', () => {
  it('preserves runtime cost, description and enhancement badge', () => {
    const html = face.render({cardId:'example',actionPointCost:0,presentation:{description:'强化后的实际效果',badge:'强化'}},{name:'测试牌',actionPointCost:2,description:'基础效果',type:'reactive',cooldownTurns:3})
    expect(html).toContain('free">0')
    expect(html).toContain('强化后的实际效果')
    expect(html).not.toContain('基础效果')
    expect(html).toContain('card-content-badge">强化')
    expect(html).toContain('触发')
    expect(html).toContain('CD3')
  })
  it('renders complete descriptions and local nested art without playable controls', () => {
    const description = '完整效果。'.repeat(60)
    const html = face.preview('example',{name:'测试牌',description,image:'pack/example.webp',type:'passive'})
    expect(html).toContain(description)
    expect(html).toContain('images/card-art/pack/example.webp')
    expect(html).toContain('持续')
    expect(html).not.toMatch(/onclick|onCardClick|<button|tabindex/)
  })
  it('escapes resource metadata and rejects external or traversing image names', () => {
    for(const image of ['../secret.png','https://example.com/a.png','a.jpg?x=1','a\\b.jpg','x\" onload=\"evil.jpg']) {
      const html = face.preview('example',{name:'<script>bad</script>',description:'<img src=x>',image})
      expect(html).not.toContain('<img')
      expect(html).not.toContain('<script>')
      expect(html).toContain('&lt;script&gt;')
    }
  })
})
