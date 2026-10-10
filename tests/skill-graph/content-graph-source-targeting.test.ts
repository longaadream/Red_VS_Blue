import { describe, expect, it } from 'vitest'
import { compileContentGraph, CONTENT_GRAPH_VERSION, type ContentGraph } from '../../electron-editor/content-graph'
import { extractTargetSpecsFromCode } from '../../lib/game/targeting'

describe('serialized source targeting compatibility', () => {
  const message = '引号\'"、反斜线\\、换行\n、零\0、分隔\u2028\u2029、孤立代理\ud800'
  const child:ContentGraph = {version:CONTENT_GRAPH_VERSION,surface:'card',entry:'select',nodes:[
    {id:'select',kind:'call',capability:'selectTarget',args:[{kind:'object',entries:[
      {key:'type',value:{kind:'literal',value:'piece'}},
      {key:'filter',value:{kind:'literal',value:'ally'}},
      {key:'range',value:{kind:'literal',value:99}},
    ]}],next:'done'},
    {id:'done',kind:'return',value:{kind:'literal',value:message}},
  ]}
  for (const kind of ['source','materializeSource'] as const) it(`${kind} preserves source bytes and the legacy scanner`, () => {
    const parent:ContentGraph = kind === 'source'
      ? {version:CONTENT_GRAPH_VERSION,surface:'skill',entry:'done',nodes:[{id:'done',kind:'return',value:{kind:'source',graph:child}}]}
      : {version:CONTENT_GRAPH_VERSION,surface:'skill',entry:'source',nodes:[
          {id:'source',kind:'materializeSource',graph:child,bindings:{binding:{kind:'literal',value:message}},result:'code',next:'done'},
          {id:'done',kind:'return',value:{kind:'ref',name:'code'}},
        ]}
    const compiled = compileContentGraph(parent).code
    expect(extractTargetSpecsFromCode(compiled,'skill')).toEqual([{kind:'target',type:'piece',filter:'ally',range:99}])
    const source = new Function(`return (${compiled})`)()({}) as string
    if (kind === 'source') expect(source).toBe(compileContentGraph(child).code)
    const selections:unknown[] = []
    const execute = new Function('selectTarget',`return (${source})`)((options:unknown)=>{selections.push(options)})
    expect(execute({})).toBe(message)
    expect(selections).toEqual([{type:'piece',filter:'ally',range:99}])
  })
})
