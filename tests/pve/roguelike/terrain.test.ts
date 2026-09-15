import {expect,it} from 'vitest'
import {adventureContent} from '@/lib/pve/roguelike/content'
import {campaignAct} from '@/lib/pve/roguelike/campaign'
import {generateTerrain} from '@/lib/pve/roguelike/terrain'
it('creates coherent, reproducible and distinct terrain profiles',()=>{
 const variants=new Set<string>()
 for(const profile of ['streets','ruins','fortress'] as const){
  const grid=generateTerrain(64,64,42,profile)
  expect(grid).toEqual(generateTerrain(64,64,42,profile))
  expect(grid).not.toEqual(generateTerrain(64,64,43,profile))
  variants.add(JSON.stringify(grid))
  expect(grid.flat().filter(t=>t!=='.').length).toBeGreaterThan(700)
 }
 expect(variants.size).toBe(3)
})
it('retains terrain and connects every encounter formation and facility across three acts',()=>{
 for(let act=0;act<3;act++)for(let seed=0;seed<12;seed++){
  const content=campaignAct(adventureContent,act,seed),grid=content.map.layout
  expect(grid.join('').split('').filter(t=>t!=='.').length).toBeGreaterThan(500)
  const camp=content.sites.find(s=>s.kind==='camp')!,travel=[camp],reachable=new Set([`${camp.x},${camp.y}`])
  const outside=(x:number,y:number)=>!content.zones.some(z=>x>=z.x&&x<z.x+z.width&&y>=z.y&&y<z.y+z.height)
  for(let i=0;i<travel.length;i++)for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
    const x=travel[i].x+dx,y=travel[i].y+dy,k=`${x},${y}`
    if(grid[y]?.[x]==='.'&&outside(x,y)&&!reachable.has(k)){reachable.add(k);travel.push({...camp,x,y})}
  }
  for(let y=0;y<grid.length;y++)for(let x=0;x<grid[y].length;x++)if(grid[y][x]==='.'&&outside(x,y))expect(reachable.has(`${x},${y}`)).toBe(true)
  for(const zone of content.zones){
   const marker=content.sites.find(s=>s.id===zone.id)!,queue=[marker],seen=new Set([`${marker.x},${marker.y}`])
   for(let i=0;i<queue.length;i++)for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
    const x=queue[i].x+dx,y=queue[i].y+dy,key=`${x},${y}`
    if(x>=zone.x&&x<zone.x+zone.width&&y>=zone.y&&y<zone.y+zone.height&&grid[y][x]==='.'&&!seen.has(key)){seen.add(key);queue.push({...marker,x,y})}
   }
   for(const enemy of content.enemyLineup.filter(e=>e.zone===zone.id))expect(seen.has(`${enemy.x},${enemy.y}`)).toBe(true)
   expect(seen.size).toBeGreaterThan(30)
  }
 }
},30000)
