import { describe, expect, it } from 'vitest'
import { compileContentGraph, CONTENT_GRAPH_VERSION, type ContentGraph } from '../../electron-editor/content-graph'

describe('existing host compatibility capabilities', () => {
  it('retains lexicographic ordering of string identifiers', () => {
    const graph:ContentGraph = {version:CONTENT_GRAPH_VERSION,surface:'skill',entry:'return',nodes:[
      {id:'return',kind:'return',value:{kind:'binary',op:'<',left:{kind:'literal',value:'a-10'},right:{kind:'literal',value:'a-2'}}},
    ]}
    const execute = new Function(`return (${compileContentGraph(graph).code})`)()
    expect(execute({})).toBe('a-10' < 'a-2')
  })
  it('performs JSON conversion once at the selected effect node', () => {
    const graph:ContentGraph = {version:CONTENT_GRAPH_VERSION, surface:'skill', entry:'branch', nodes:[
      {id:'branch',kind:'branch',condition:{kind:'ref',name:'context.enabled'},yes:'serialize',no:'none'},
      {id:'serialize',kind:'call',capability:'JSON.stringify',args:[{kind:'ref',name:'context.value'}],result:'serialized',next:'parse'},
      {id:'parse',kind:'call',capability:'JSON.parse',args:[{kind:'ref',name:'serialized'}],result:'copy',next:'done'},
      {id:'done',kind:'return',value:{kind:'ref',name:'copy'}},
      {id:'none',kind:'return'},
    ]}
    const execute = new Function(`return (${compileContentGraph(graph).code})`)()
    let calls = 0
    const value = {toJSON:() => { calls++; return {count:calls} }}
    expect(execute({enabled:false,value})).toBeUndefined()
    expect(calls).toBe(0)
    expect(execute({enabled:true,value})).toEqual({count:1})
    expect(calls).toBe(1)
  })
  it('counts unique selections at the effect node and preserves native iteration', () => {
    const graph:ContentGraph = {version:CONTENT_GRAPH_VERSION, surface:'pending', entry:'count', nodes:[
      {id:'count',kind:'call',capability:'collection.uniqueCount',args:[{kind:'ref',name:'ctx.ids'}],result:'count',next:'done'},
      {id:'done',kind:'return',value:{kind:'ref',name:'count'}},
    ]}
    const execute = new Function(`return (${compileContentGraph(graph).code})`)()
    let iterations = 0
    const ids = { *[Symbol.iterator]() { iterations++; yield 'a'; yield 'a'; yield 'b' } }
    expect(execute({ids})).toBe(2)
    expect(iterations).toBe(1)
    expect(() => execute({ids:42})).toThrow(TypeError)
  })
  it('keeps continuation helpers on the pending receiver', () => {
    const graph:ContentGraph = {version:CONTENT_GRAPH_VERSION,surface:'pending',entry:'status',nodes:[
      {id:'status',kind:'call',capability:'ctx.addStatusEffectById',args:[{kind:'literal',value:'piece'},{kind:'object',entries:[{key:'type',value:{kind:'literal',value:'divine-shield'}}]}],next:'done'},
      {id:'done',kind:'return'},
    ]}
    const execute = new Function(`return (${compileContentGraph(graph).code})`)()
    const calls:unknown[] = []
    const ctx = {addStatusEffectById(this:unknown,...args:unknown[]) { calls.push({receiver:this,args}) }}
    execute(ctx)
    expect(calls).toEqual([{receiver:ctx,args:['piece',{type:'divine-shield'}]}])
    expect(() => compileContentGraph({...graph,surface:'skill'})).toThrow(/ctx.addStatusEffectById 禁止用于 skill/)
  })
  it('rejects the skill-only selector object on card entries', () => {
    const graph:ContentGraph = {version:CONTENT_GRAPH_VERSION,surface:'card',entry:'query',nodes:[
      {id:'query',kind:'call',capability:'select.getPieceAt',args:[{kind:'literal',value:1},{kind:'literal',value:2}],next:'done'},
      {id:'done',kind:'return'},
    ]}
    expect(() => compileContentGraph(graph)).toThrow(/select.getPieceAt 禁止用于 card/)
    expect(() => compileContentGraph({...graph,surface:'skill'})).not.toThrow()
  })
})
