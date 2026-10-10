import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { importContentGraph } from '../../electron-editor/content-graph-import'
import { compileContentGraph } from '../../electron-editor/content-graph'

const frozen = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8'))

describe('explicit content graph import', () => {
  it('lowers real healing, damage and queued healing into capability nodes without source blocks', () => {
    for (const [path, field, surface] of [
      ['data/skills/light-of-the-light.json', 'code', 'skill'],
      ['data/skills/ulquiorra-cero.json', 'code', 'skill'],
      ['data/rules/rule-reap.json', 'skillCode', 'rule'],
    ] as const) {
      const original = frozen.entries[path.replace(/^data\//, '').replace(/\.json$/, '')]
      const graph = importContentGraph(original[field], surface)
      expect(graph.nodes.every(node => ['bind', 'call', 'branch', 'return', 'set'].includes(node.kind))).toBe(true)
      expect(graph.nodes.some(node => node.kind === 'call')).toBe(true)
      expect(compileContentGraph(graph).code).toContain(surface === 'rule' ? 'context.healQueue.push' : 'function executeSkill(context)')
      expect(JSON.stringify(graph)).not.toContain(original[field])
    }
  })
  it('does not silently wrap unsupported labels or arbitrary calls', () => {
    for (const source of [
      'function executeSkill(context) { outer: while(context.piece) { break outer; } return 1; }',
      'function executeSkill(context) { context.arbitraryFunction(); return 1; }',
    ]) expect(() => importContentGraph(source, 'skill')).toThrow()
  })
  it('preserves left-to-right order for nested effect arguments and fields', () => {
    const source = 'function executeSkill(context) { return dealDamage({before:context.value}, [Math.random(),context.value], context.value+Date.now()); }'
    const run = (code: string) => {
      const context = {value: 2}
      const calls: string[] = []
      const math = {random: () => { calls.push('random'); context.value = 9; return 0.25 }}
      const date = {now: () => { calls.push('clock'); context.value = 11; return 100 }}
      const damage = (...args: unknown[]) => ({args})
      const execute = new Function('Math', 'Date', 'dealDamage', code + ';return executeSkill;')(math, date, damage)
      return {result: execute(context), context, calls}
    }
    expect(run(compileContentGraph(importContentGraph(source, 'skill')).code)).toEqual(run(source))
  })
  it('captures an element base before an effectful index can mutate it', () => {
    const source = 'function executeSkill(context) { var values=[10]; var replace=function() { values=[20]; return 0; }; return values[replace()]; }'
    const generated = compileContentGraph(importContentGraph(source, 'skill')).code
    const run = (code: string) => new Function(code + ';return executeSkill;')()({})
    expect(run(generated)).toBe(run(source))
    expect(run(generated)).toBe(10)
  })
  it('captures array method and receiver before effectful arguments', () => {
    const source = 'function executeSkill(context) { context.items.push(Math.random()); return context.items.length; }'
    const generated = compileContentGraph(importContentGraph(source, 'skill')).code
    const run = (code: string) => {
      const events: string[] = []
      const items: number[] = []
      Object.defineProperty(items, 'push', {configurable:true, get() { events.push('method'); return Array.prototype.push }})
      const context = {items: undefined as unknown as number[]}
      Object.defineProperty(context, 'items', {configurable:true, get() { events.push('receiver'); return items }})
      const math = {random() { events.push('random'); return 7 }}
      const execute = new Function('Math', code + ';return executeSkill;')(math)
      return {result:execute(context), events}
    }
    expect(run(generated)).toEqual(run(source))
    expect(run(generated).events.slice(0, 3)).toEqual(['receiver', 'method', 'random'])
  })
  it('captures shorthand object fields before a later effect', () => {
    const source = 'function executeSkill(context) { var x=1; var replace=function() { x=2; return 3; }; return dealDamage({x},context.target,replace()); }'
    const generated = compileContentGraph(importContentGraph(source, 'skill')).code
    const run = (code: string) => new Function('dealDamage', code + ';return executeSkill;')((...args: unknown[]) => ({args}))({target:{id:'t'}})
    expect(run(generated)).toEqual(run(source))
    expect(run(generated).args[0]).toEqual({x:1})
  })
  it('rejects local variables named undefined instead of changing nullish behavior', () => {
    const source = 'function executeSkill(context) { var undefined=1; return context.x ?? Math.random(); }'
    expect(() => importContentGraph(source, 'skill')).toThrow(/undefined/)
  })
  it('evaluates logical and conditional effects only on the selected path', () => {
    const source = 'function executeSkill(context) { var andValue=context.enabled&&Math.random(); var orValue=context.enabled||Math.random(); var nullishValue=context.maybe??Math.random(); var conditionalValue=context.flag?Math.random():Date.now(); return {andValue:andValue,orValue:orValue,nullishValue:nullishValue,conditionalValue:conditionalValue,value:context.value}; }'
    const run = (code: string, initial: {enabled: boolean, maybe: number | boolean | string | null, flag: boolean | number}) => {
      const context = {...initial, value: 1}
      const calls: string[] = []
      const math = {random: () => { calls.push('random'); context.value += 1; return context.value }}
      const date = {now: () => { calls.push('clock'); context.value += 10; return context.value }}
      const execute = new Function('Math', 'Date', code + ';return executeSkill;')(math, date)
      return {result: execute(context), calls}
    }
    const generated = compileContentGraph(importContentGraph(source, 'skill')).code
    for (const initial of [
      {enabled: false, maybe: null, flag: false},
      {enabled: true, maybe: 0, flag: true},
      {enabled: false, maybe: 4, flag: true},
      {enabled: false, maybe: false, flag: 0},
      {enabled: false, maybe: '', flag: 1},
    ]) expect(run(generated, initial)).toEqual(run(source, initial))
  })
  it('rejects function var declarations that are unreachable but still hoisted', () => {
    const source = 'function executeSkill(context) { var x=1; var f=function() { return x; var x=2; }; return f(); }'
    expect(() => importContentGraph(source, 'skill')).toThrow(/var/)
  })
  it('rejects unreachable var declarations in loop initializers and iterators', () => {
    expect(() => importContentGraph('function executeSkill(context) { var f=function() { return x; for (var x=2; false;) {} }; return f(); }', 'skill')).toThrow(/var/)
    expect(() => importContentGraph('function executeSkill(context) { return x; for (var x of []) {} }', 'skill')).toThrow(/var/)
    expect(() => importContentGraph('function executeSkill(context) { return x; for (var x in {}) {} }', 'skill')).toThrow(/var/)
  })
  it('uses capability type expressions without breaking local helper shadowing', () => {
    const globalGraph = importContentGraph('function executeSkill(context) { return typeof dealDamage; }', 'skill')
    const globalReturn = globalGraph.nodes.find(node => node.kind === 'return')
    expect(globalReturn?.kind === 'return' && globalReturn.value).toMatchObject({kind:'capabilityType',capability:'dealDamage'})
    const localGraph = importContentGraph('function executeSkill(context) { var dealDamage=1; return typeof dealDamage; }', 'skill')
    const localReturn = localGraph.nodes.find(node => node.kind === 'return')
    expect(localReturn?.kind === 'return' && localReturn.value).toMatchObject({kind:'unary',op:'typeof',argument:{kind:'ref',name:'dealDamage'}})
    const nestedGraph = importContentGraph('function executeSkill(context) { var helper=function(dealDamage) { return typeof dealDamage; }; return typeof dealDamage; }', 'skill')
    const nestedReturn = nestedGraph.nodes.find(node => node.kind === 'return')
    expect(nestedReturn?.kind === 'return' && nestedReturn.value).toMatchObject({kind:'capabilityType',capability:'dealDamage'})
  })
  it('lowers effectful callbacks and helper functions into nested graphs', () => {
    const source = 'function executeSkill(context) { var total=0; var apply=function(value) { if(value<0) return; total+=value; }; context.values.forEach(function(value) { apply(value); }); return total; }'
    const graph = importContentGraph(source,'skill')
    const generated = compileContentGraph(graph).code
    const run = (code:string) => new Function(code+';return executeSkill;')()({values:[1,-2,3]})
    expect(graph.nodes.some(node => node.kind === 'invoke')).toBe(true)
    expect(run(generated)).toBe(4)
    expect(run(generated)).toBe(run(source))
    expect(JSON.stringify(graph)).not.toContain(source)
  })
  it('captures operands before seeded random and clock effects, exactly once', () => {
    const source = 'function executeSkill(context) { var id="status-"+Date.now(); var result=context.value+Math.random(); return {id:id,result:result}; }'
    const generated = compileContentGraph(importContentGraph(source,'skill')).code
    const run = (code:string) => {
      const context = {value:2}
      const calls:string[] = []
      const clock = {now:() => {calls.push('clock');return 123}}
      const math = {random:() => {calls.push('random');context.value=99;return 0.25}}
      const result = new Function('Math','Date',code+';return executeSkill;')(math,clock)(context)
      return {result,context,calls}
    }
    expect(run(generated)).toEqual(run(source))
    expect(run(generated).result).toEqual({id:'status-123',result:2.25})
  })
  it('rejects optional evaluation and lexical scopes that cannot yet be preserved', () => {
    for (const source of [
      'function executeSkill(context) { { let x=1; } return typeof x; }',
      'function executeSkill(context) { const x=1; x=2; return x; }',
      'function executeSkill(context) { return context.items?.find(x=>x.id===1); }',
      'function executeSkill(context) { return dealDamage?.(context.piece,context.target,1); }',
      'function executeSkill(context) { const x=battle; const battle=context.battle; return x; }',
      'function executeSkill() { return context.piece; }',
    ]) expect(() => importContentGraph(source, 'skill')).toThrow()
  })
  it('preserves collection order, captured values and indexed writes', () => {
    const old = 'function executeSkill(context) { var threshold = context.threshold; var allies = context.pieces.filter(function(p) { return p.hp > threshold; }); var names = allies.map(p => p.name).join(","); context.pieces[0].hp += 2; return {names:names,hp:context.pieces[0].hp,missing:undefined}; }'
    const graph = importContentGraph(old, 'skill')
    const code = compileContentGraph(graph).code
    expect(graph.nodes.some(node => node.kind === 'set')).toBe(true)
    const run = (source: string) => {
      const state = {threshold: 1, pieces: [{name:'甲',hp:2},{name:'乙',hp:1},{name:'丙',hp:4}]}
      const result = new Function(source + '; return executeSkill;')()(state)
      return {result,state}
    }
    expect(run(code)).toEqual(run(old))
  })
  it('executes a movement effect exactly once before testing its result', () => {
    const source = 'function executeSkill(context) { if (!flow.effects.displace([], "teleport").success) return {success:true,message:"位移被阻挡，本次位移效果取消"}; return {success:true,message:"完成"}; }'
    const graph = importContentGraph(source, 'skill')
    const generated = compileContentGraph(graph).code
    const run = (code: string, success: boolean) => {
      const calls: unknown[] = []
      const flow = {effects: {displace: (...args: unknown[]) => { calls.push(args); return {success} }}}
      return {result:new Function('flow', code + ';return executeSkill;')(flow)({}),calls}
    }
    for (const success of [false,true]) expect(run(generated,success)).toEqual(run(source,success))
    expect(graph.nodes.filter(node => node.kind === 'call')).toHaveLength(1)
  })
  it('preserves loop update, continue, break and outer return', () => {
    const sources = [
      'function executeSkill(context) { var total=0; for(var i=0;i<6;i++){ if(i===1) continue; if(i===4) break; total+=i; } return total; }',
      'function executeSkill(context) { var i=0; while(i<5) { i++; if(i===3) return i; } return -1; }',
    ]
    for (const source of sources) {
      const graph = importContentGraph(source,'skill')
      expect(graph.nodes.some(node => node.kind === 'loop')).toBe(true)
      const run = (code:string) => new Function(code+';return executeSkill;')()({})
      expect(run(compileContentGraph(graph).code)).toEqual(run(source))
    }
  })
  it('lowers for-in with the native enumerable-key iteration', () => {
    const source = 'function executeSkill(context) { var keys=[]; for (var key in context.values) keys.push(key); return keys.join(","); }'
    const graph = importContentGraph(source, 'skill')
    expect(graph.nodes.some(node => node.kind === 'loop' && node.loop === 'forIn')).toBe(true)
    const generated = compileContentGraph(graph).code
    const context = {values:{a:1,b:2}}
    expect(new Function(generated + ';return executeSkill;')()(context)).toBe(new Function(source + ';return executeSkill;')()(context))
    expect(() => importContentGraph('function executeSkill(context) { for await (var key of context.values) return key; }', 'skill')).toThrow(/for-await/)
  })
  it('lowers reduce, string methods, templates and uninitialized top-level var bindings', () => {
    const source = 'function executeSkill(context) { var cloneX, cloneY; var total=context.values.reduce((sum,value)=>sum+value,0); var label=`${context.prefix}:${context.text.toLowerCase()}:${context.text.toUpperCase()}:${context.text.split(",").length}`; return {total:total,label:label,missing:[cloneX,cloneY]}; }'
    const graph = importContentGraph(source, 'skill')
    expect(JSON.stringify(graph)).toContain('"method":"reduce"')
    const generated = compileContentGraph(graph).code
    const context = {values:[1,2,3],prefix:'P',text:'A,b'}
    expect(new Function(generated + ';return executeSkill;')()(context)).toEqual(new Function(source + ';return executeSkill;')()(context))
    const dynamicTemplate = 'function executeSkill(context) { return `before-${Date.now()}-${Math.random()}-${context.suffix}`; }'
    const dynamicGraph = importContentGraph(dynamicTemplate, 'skill')
    const runDynamic = (code: string) => {
      const calls: string[] = []
      const date = {now() { calls.push('date'); return 4 }}
      const math = {random() { calls.push('random'); return 0.5 }}
      const execute = new Function('Date', 'Math', code + ';return executeSkill;')(date, math)
      return {result:execute({suffix:'after'}),calls}
    }
    expect(runDynamic(compileContentGraph(dynamicGraph).code)).toEqual(runDynamic(dynamicTemplate))
    const effectful = 'function executeSkill(context) { var seen=0; var total=context.values.reduce(function(sum,value) { seen += value; return sum + value; },0); return {total:total,seen:seen}; }'
    const effectfulGraph = importContentGraph(effectful, 'skill')
    expect(effectfulGraph.nodes.some(node => node.kind === 'invoke')).toBe(true)
    expect(new Function(compileContentGraph(effectfulGraph).code + ';return executeSkill;')()({values:[1,2,3]})).toEqual({total:6,seen:6})
    const targeting = importContentGraph('function executeSkill(context) { return selectTarget({type:"grid",range:context.battle.map.tiles.reduce(function(maximum,tile) { return Math.max(maximum, tile.x); },0),filter:"all"}); }', 'skill')
    const select = targeting.nodes.find(node => node.kind === 'call' && (node.capability ?? node.helper) === 'selectTarget')
    const options = select?.kind === 'call' ? select.args[0] : undefined
    const range = options?.kind === 'object' && Array.isArray(options.entries)
      ? options.entries.find(entry => entry.key === 'range')?.value
      : undefined
    expect(range).toMatchObject({kind:'collection',method:'reduce'})
  })
  it('lowers for-of, delete, try and throw with the original control flow', () => {
    const source = 'function executeSkill(context) { for (var value of context.values) { if (value < 0) continue; context.total += value; } try { delete context.remove; if (context.fail) throw `bad:${context.name}`; } catch (error) { context.error = error; } return {total:context.total,remove:context.remove,error:context.error}; }'
    const graph = importContentGraph(source, 'skill')
    expect(graph.nodes.some(node => node.kind === 'loop')).toBe(true)
    expect(graph.nodes.some(node => node.kind === 'try')).toBe(true)
    expect(JSON.stringify(graph)).toContain('"kind":"delete"')
    expect(JSON.stringify(graph)).toContain('"kind":"throw"')
    const generated = compileContentGraph(graph).code
    for (const fail of [false, true]) {
      const oldContext = {values:[1,-2,3],total:0,remove:'gone',fail,name:'N',error:undefined as unknown}
      const newContext = structuredClone(oldContext)
      const oldResult = new Function(source + ';return executeSkill;')()(oldContext)
      const newResult = new Function(generated + ';return executeSkill;')()(newContext)
      expect(newResult).toEqual(oldResult)
      expect(newContext).toEqual(oldContext)
    }
  })
  it('evaluates non-local increment references once and applies ToNumber', () => {
    const source = 'function executeSkill(context) { context.box.value++; context.items[context.index]--; return {value:context.box.value,item:context.items[context.index]}; }'
    const generated = compileContentGraph(importContentGraph(source, 'skill')).code
    const run = (code: string) => {
      const events: string[] = []
      const box = {value:'4'}
      const items = ['8']
      const context = {box:undefined as unknown as typeof box,items:undefined as unknown as string[],index:undefined as unknown as string}
      Object.defineProperty(context, 'box', {get() { events.push('box'); return box }})
      Object.defineProperty(context, 'items', {get() { events.push('items'); return items }})
      Object.defineProperty(context, 'index', {get() { events.push('index'); return '0' }})
      const execute = new Function(code + ';return executeSkill;')()
      return {result:execute(context),events}
    }
    expect(run(generated)).toEqual(run(source))
    expect(run(generated).result).toEqual({value:5,item:7})
  })
  it('keeps array mutation order and queue append results', () => {
    const source = 'var values=context.values; var length=values.push(7); var removed=values.splice(0,1); values.sort(function(a,b){return a-b;}); var queued=context.damageQueue.push({damage:values[0]}); return {length:length,removed:removed,queued:queued};'
    const generated = compileContentGraph(importContentGraph(source,'rule')).code
    const run = (code:string) => {
      const context = {values:[4,2],damageQueue:[]}
      const result = new Function('context',code)(context)
      return {result,context}
    }
    expect(run(generated)).toEqual(run(source))
  })
  it('preserves zero and multiple arguments to legacy healing queue push', () => {
    const source = 'var count=context.healQueue.push({healer:context.piece,target:context.piece,heal:1},{healer:context.piece,target:context.piece,heal:2}); var empty=context.healQueue.push(); return {count:count,empty:empty};'
    const generated = compileContentGraph(importContentGraph(source,'rule')).code
    const run = (code:string) => {
      const context = {piece:{id:'p'},healQueue:[]}
      return {result:new Function('context',code)(context),context}
    }
    expect(run(generated)).toEqual(run(source))
    expect(run(generated).context.healQueue).toHaveLength(2)
  })
  it('does not introduce a Boolean name lookup when lowering truthiness', () => {
    const source = 'function executeSkill(context){var Boolean=context.convert;if(context.enabled)return 1;return 0;}'
    const generated = compileContentGraph(importContentGraph(source,'skill')).code
    const run = (code:string) => new Function(code+';return executeSkill;')()({convert:null,enabled:true})
    expect(run(generated)).toBe(run(source))
  })
  it('retains branch-dependent helper order and exact return messages', () => {
    const old = 'function executeSkill(context) { var target = selectTarget({type:"piece"}); if (!target) return {success:false,message:"无目标"}; var value = Math.floor(context.piece.attack * 0.75); var result = dealDamage(context.piece,target,value,"magical",battle,"x"); return {success:true,message:"伤害:"+result.damage}; }'
    const code = compileContentGraph(importContentGraph(old, 'skill')).code
    function run(source: string, target: object | null) {
      const calls: unknown[] = []
      const execute = new Function('selectTarget', 'dealDamage', 'battle', source + '; return executeSkill;')(
        (options: unknown) => { calls.push(['target', options]); return target },
        (...args: unknown[]) => { calls.push(['damage', ...args]); return { damage: 3 } }, {},
      )
      return { result: execute({ piece: { attack: 5 } }), calls }
    }
    expect(run(code, null)).toEqual(run(old, null))
    expect(run(code, { instanceId: 't' })).toEqual(run(old, { instanceId: 't' }))
  })
  it('alpha-renames block bindings without changing object keys or callback parameters', () => {
    const source = 'function executeSkill(context) { const tile=1; { let tile=2; context.value={tile}; } return context.items.map(tile => tile.x).concat(tile); }'
    const graph = importContentGraph(source, 'skill')
    const generated = compileContentGraph(graph).code
    const context: {items:{x:number}[], value?: unknown} = {items:[{x:3}]}
    const result = new Function(generated + ';return executeSkill;')()(context)
    expect(result).toEqual([3, 1])
    expect(context.value).toEqual({tile:2})
    const serialized = JSON.stringify(graph)
    expect(serialized).toContain('__rvb_lexical_')
    expect(serialized).toContain('"key":"tile"')
  })
  it('checks const writes by binding identity instead of spelling', () => {
    const source = 'function executeSkill(context) { const value=1; { let value=2; value=3; context.inner=value; } return value; }'
    const generated = compileContentGraph(importContentGraph(source, 'skill')).code
    const context = {inner:0}
    expect(new Function(generated + ';return executeSkill;')()(context)).toBe(1)
    expect(context.inner).toBe(3)
    expect(() => importContentGraph('function executeSkill(context) { const value=1; { let value=2; } value=3; return value; }', 'skill')).toThrow(/const/)
  })
  it('rejects lexical references before initialization, including self initialization', () => {
    expect(() => importContentGraph('function executeSkill(context) { return value; const value=1; }', 'skill')).toThrow(/初始化前/)
    expect(() => importContentGraph('function executeSkill(context) { const value=value; return value; }', 'skill')).toThrow(/初始化前/)
  })
  it('supports noncaptured loop lexical bindings and rejects per-iteration closure capture', () => {
    const source = 'function executeSkill(context) { let total=0; for (let index=0; index<3; index++) total += index; return total; }'
    const generated = compileContentGraph(importContentGraph(source, 'skill')).code
    expect(new Function(generated + ';return executeSkill;')()({})).toBe(3)
    expect(() => importContentGraph('function executeSkill(context) { for (let index=0; index<2; index++) context.items.push(() => index); return context.items.length; }', 'skill')).toThrow(/闭包捕获/)
  })
  it('lowers a top-level nonrecursive function declaration with live captures', () => {
    const source = 'function executeSkill(context) { let value=1; function read() { return value; } value=2; return read(); }'
    const generated = compileContentGraph(importContentGraph(source, 'skill')).code
    expect(new Function(generated + ';return executeSkill;')()({})).toBe(2)
    expect(() => importContentGraph('function executeSkill(context) { return read(); function read() { return 1; } }', 'skill')).toThrow(/首次引用/)
    expect(() => importContentGraph('function executeSkill(context) { function read() { return read(); } return read(); }', 'skill')).toThrow(/递归/)
  })
  it('imports the frozen shadow-step-teleport block bindings', () => {
    const source = frozen.entries['skills/shadow-step-teleport'].code as string
    const graph = importContentGraph(source, 'skill')
    expect(graph.nodes.length).toBeGreaterThan(0)
    expect(compileContentGraph(graph).code).toContain('executeSkill')
  })
  it('lowers new Set size through an effect capability with source order', () => {
    const source = 'function executeSkill(context) { return new Set([Math.random(), Math.random(), context.value]).size; }'
    const graph = importContentGraph(source, 'skill')
    expect(graph.nodes.some(node => node.kind === 'call' && node.capability === 'collection.uniqueCount')).toBe(true)
    const generated = compileContentGraph(graph).code
    const run = (code: string) => {
      const events: string[] = []
      const math = {random() { events.push('random'); return events.length === 1 ? 1 : 1 }}
      const execute = new Function('Math', code + ';return executeSkill;')(math)
      return {result: execute({value:2}), events}
    }
    expect(run(generated)).toEqual(run(source))
    expect(run(generated)).toEqual({result:2, events:['random','random']})
  })
  it('rejects a local Set shadow instead of changing constructor semantics', () => {
    expect(() => importContentGraph('function executeSkill(context) { const Set=context.Set; return new Set(context.values).size; }', 'skill')).toThrow(/Set/)
  })
  it('binds collection and invoke member methods before effectful arguments or callbacks', () => {
    for (const source of [
      'function executeSkill(context) { return context.items.slice(null, Math.random()); }',
      'function executeSkill(context) { return context.items.map(function(item) { Math.random(); return item; }); }',
      'function executeSkill(context) { context.items.forEach(function(item) { Math.random(); context.total += item; }); return context.total; }',
    ]) {
      const graph = importContentGraph(source, 'skill')
      const generated = compileContentGraph(graph).code
      const run = (code: string) => {
        const events: string[] = []
        const items = [1, 2]
        const method = source.includes('slice') ? 'slice' : source.includes('map') ? 'map' : 'forEach'
        Object.defineProperty(items, method, {configurable:true, get() { events.push('method'); return Array.prototype[method as 'slice' | 'map' | 'forEach'] }})
        const context: {items:number[], total:number} = {items, total:0}
        Object.defineProperty(context, 'items', {configurable:true, get() { events.push('receiver'); return items }})
        const math = {random() { events.push('random'); return 1 }}
        const execute = new Function('Math', code + ';return executeSkill;')(math)
        return {result: execute(context), events}
      }
      expect(run(generated)).toEqual(run(source))
      expect(run(generated).events.slice(0, 3)).toEqual(['receiver', 'method', 'random'])
    }
  })
  it('lowers nonlocal new Error with ordered arguments and rejects shadowing', () => {
    const source = 'function executeSkill(context) { return new Error(String(context.value)); }'
    const graph = importContentGraph(source, 'skill')
    expect(graph.nodes.some(node => node.kind === 'call' && node.capability === 'error.create')).toBe(true)
    const generated = compileContentGraph(graph).code
    const result = new Function(generated + ';return executeSkill;')()({value:7})
    expect(result).toBeInstanceOf(Error)
    expect(result.message).toBe('7')
    expect(() => importContentGraph('function executeSkill(context) { const Error=context.Error; return new Error("x"); }', 'skill')).toThrow(/Error/)
    expect(() => importContentGraph('function executeSkill(context) { return new Error(1,2); }', 'skill')).toThrow(/Error/)
  })
  it('supports top-level helper declarations in inline rule hosts', () => {
    const source = 'var value=1; function read() { return value+1; } value=2; return read();'
    const graph = importContentGraph(source, 'rule')
    expect(graph.nodes.some(node => node.kind === 'bind' && node.expr?.kind === 'function')).toBe(true)
    expect(compileContentGraph(graph).code).toContain('function')
  })
  it('lowers only the unshadowed global Boolean as a structured callback', () => {
    const graph = importContentGraph('function executeSkill(context) { return context.items.filter(Boolean); }', 'skill')
    const filter = graph.nodes.find(node => node.kind === 'return')
    expect(filter?.kind === 'return' && filter.value).toMatchObject({kind:'collection',method:'filter',args:[{kind:'lambda',parameters:['value']}]})
    const local = importContentGraph('function executeSkill(context) { var Boolean=context.predicate; return context.items.filter(Boolean); }', 'skill')
    expect(local.nodes.some(node => node.kind === 'invoke')).toBe(true)
  })
})
