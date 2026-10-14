import { describe, expect, it } from 'vitest'
import { compileContentGraph, CONTENT_GRAPH_VERSION, type ContentGraph } from '../../electron-editor/content-graph'

const graph:ContentGraph = {
  version:CONTENT_GRAPH_VERSION,surface:'skill',entry:'loop',nodes:[
    {id:'loop',kind:'loop',loop:'forIn',iterable:{kind:'ref',name:'context.value'},item:'key',body:{entry:'record',end:'end',nodes:[
      {id:'record',kind:'call',capability:'array.push',args:[{kind:'ref',name:'context.keys'},{kind:'ref',name:'key'}],next:'delete'},
      {id:'delete',kind:'delete',target:{kind:'get',object:{kind:'ref',name:'context.value'},key:'removed'},next:'end'},
      {id:'end',kind:'regionEnd'},
    ]},next:'done'},
    {id:'done',kind:'return',value:{kind:'ref',name:'context.keys'}},
  ],
}

describe('native property enumeration graph', () => {
  it('retains inherited enumerable keys and deletion during enumeration', () => {
    const makeValue = () => Object.defineProperty(Object.assign(Object.create({inherited:1}),{first:1,removed:2,last:3}), 'hidden', {value:4,enumerable:false})
    const legacy = (value:Record<string,unknown>) => {
      const keys:string[] = []
      for (const key in value) { keys.push(key); delete value.removed }
      return keys
    }
    const execute = new Function(`return (${compileContentGraph(graph).code})`)()
    expect(execute({value:makeValue(),keys:[]})).toEqual(legacy(makeValue()))
    expect(execute({value:makeValue(),keys:[]})).toEqual(['first','last','inherited'])
  })
  it('evaluates the source once and keeps null enumeration empty', () => {
    const execute = new Function(`return (${compileContentGraph(graph).code})`)()
    let reads = 0
    expect(execute({get value() { reads++; return null },keys:[]})).toEqual([])
    expect(reads).toBe(1)
  })
  it('rejects an unknown loop kind instead of silently treating it as while', () => {
    const malformed = JSON.parse(JSON.stringify(graph))
    malformed.nodes[0].loop = 'futureLoop'
    expect(() => compileContentGraph(malformed)).toThrow(/loop 类型无效/)
  })
})
