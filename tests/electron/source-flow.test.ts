import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeContentFlow, editFlowNode } from '../../electron-editor/source-flow'

describe('existing skill and rule source flows', () => {
  it('draws every manifest entry without executing or rewriting its script', () => {
    let count = 0
    for (const category of ['skills', 'rules'] as const) {
      const folder = join(process.cwd(), 'data', category)
      const ids = readdirSync(folder).filter(f => f.endsWith('.json') && f !== 'manifest.json').map(f => f.slice(0, -5))
      for (const id of ids) {
        const document = JSON.parse(readFileSync(join(folder, id + '.json'), 'utf8'))
        const original = JSON.stringify(document), flow = analyzeContentFlow(category, document)
        expect(flow.summary.nodes, id).toBeGreaterThan(0)
        expect(flow.fields.flatMap(f => f.diagnostics), id).toEqual([])
        expect(JSON.stringify(document)).toBe(original); count++
      }
    }
    expect(count).toBeGreaterThan(250)
    expect(analyzeContentFlow('skills', { code: 'throw new Error("must not execute");' }).summary.nodes).toBeGreaterThan(0)
  })
  it('includes template-installed rules for existing passives without inventing skill calls', () => {
    const pieces = readdirSync('data/pieces').filter(f => f.endsWith('.json') && f !== 'manifest.json').map(f => JSON.parse(readFileSync(join('data/pieces', f), 'utf8')))
    for (const [skill, rule] of [['kenshin-tenken-passive','rule-kenshin-tenken'], ['tirion-divine-glory','rule-tirion-divine-glory'], ['watcher-form','rule-watcher-form'], ['hashirama-edo-regen','rule-hashirama-edo-regen']]) {
      const flow = analyzeContentFlow('skills', JSON.parse(readFileSync('data/skills/' + skill + '.json', 'utf8')), pieces)
      expect(flow.links.some(l => l.id === rule && l.reason.includes('不等同于技能调用'))).toBe(true)
    }
  })
  it('keeps branches, loop continuation and callbacks in distinct control paths', () => {
    const [field] = analyzeContentFlow('skills', { code: 'function executeSkill(){ for(let i=0;i<3;i++){if(i===1)continue; use(i)} items.forEach(x=>{if(x)return; use(x)}); return 7; never(); }' }).fields
    const section = field.sections.find(s => s.id === field.entry)!
    expect(section.nodes.some(n => n.kind === 'loop')).toBe(true)
    expect(section.nodes.some(n => n.source === 'never();')).toBe(false)
    expect(section.nodes.some(n => n.source === 'use(x)')).toBe(false)
    const jump = section.nodes.find(n => n.source === 'continue;')!
    const destination = section.edges.find(e => e.from === jump.id)!.to
    expect(section.nodes.find(n => n.id === destination)!.source).toBe('i++')
    expect(field.sections).toHaveLength(3)
  })
  it('routes no-code rules into their actual referenced SkillCode', () => {
    const flow = analyzeContentFlow('rules', { trigger: { event: 'onPieceDied' }, effect: { type: 'triggerSkill', skillId: 'test-skill' } })
    expect(flow.links).toContainEqual({ category: 'skills', id: 'test-skill', reason: '触发技能（受限规则调用环境）' })
    expect(flow.fields[0].sections[0].nodes.some(n => n.source.includes('test-skill'))).toBe(true)
  })
  it('edits only the selected source range and rejects stale or invalid changes', () => {
    const document = { id: 'edit', code: '// preserved\nfunction executeSkill(){ if (yes) return 1; return 2; }', extension: { untouched: true } }
    const [field] = analyzeContentFlow('skills', document).fields, section = field.sections.find(s => s.id === field.entry)!
    const node = section.nodes.find(n => n.source === 'return 2;')!
    const request = { field: field.key, hash: field.hash, section: section.id, node: node.id, replacement: 'return 3;' }
    expect(editFlowNode('skills', document, request)).toEqual({ ...document, code: document.code.replace('return 2;', 'return 3;') })
    expect(() => editFlowNode('skills', { ...document, code: document.code + '\n' }, request)).toThrow('源码已改变')
    expect(() => editFlowNode('skills', document, { ...request, replacement: 'if (' })).toThrow('语法无效')
    expect(() => editFlowNode('skills', { ...document, skillGraph: {} }, request)).toThrow('原图')
  })
  it('separates serialized pending callbacks and marks unknown constructs honestly', () => {
    const flow = analyzeContentFlow('rules', { skillCode: 'return { effectCode: "function(ctx){ function helper(){return 1} return helper() }" };' })
    const pending = flow.fields.find(f => f.readOnly)!
    expect(pending.entry).toBe('function-0')
    expect(analyzeContentFlow('skills', { code: 'try { run() } finally { cleanup() }' }).summary.opaque).toBe(1)
  })
})
