import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { describe,it,expect,vi } from 'vitest'

describe('adventure camera intent',()=>{
  it('zooms when entering a region, preserves combat panning, and recenters only on request',()=>{
    const focusCell=vi.fn(()=>true)
    const world={seed:42,actNumber:1,active:null as string|null,captainId:'captain',zones:[{id:'battle',x:10,y:10,width:12,height:12}]}
    const snapshot={world,revision:0}
    const context=createContext({window:{BattleRenderer3D:{focusCell},matchMedia:()=>({matches:true})},adventureSnapshot:snapshot,G:{map:{id:'map'},pieces:[{instanceId:'captain',currentHp:7,x:5,y:55}]}})
    new Script(readFileSync('data/pages/js/adventure/world-ui.js','utf8')).runInContext(context)
    new Script('focusAdventureAct()').runInContext(context)
    expect(focusCell).toHaveBeenLastCalledWith(5,55,44)
    snapshot.revision++;new Script('focusAdventureAct()').runInContext(context)
    expect(focusCell).toHaveBeenLastCalledWith(5,55,undefined)
    world.active='battle';snapshot.revision++;new Script('focusAdventureAct()').runInContext(context)
    expect(focusCell).toHaveBeenLastCalledWith(15.5,15.5,44)
    focusCell.mockClear();snapshot.revision++;new Script('focusAdventureAct()').runInContext(context)
    expect(focusCell).not.toHaveBeenCalled()
    new Script('focusAdventureAct(true)').runInContext(context)
    expect(focusCell).toHaveBeenCalledWith(15.5,15.5,44)
  })
})
