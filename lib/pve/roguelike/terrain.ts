import { deriveStreamSeed, mulberry32 } from '../../game/rule-runtime'

export type TerrainProfile = 'streets' | 'ruins' | 'fortress'
export type TerrainKind = 'open' | 'streets' | 'ruins' | 'gorge'
const profiles:Record<TerrainProfile,TerrainKind[]>={
  streets:['open','streets','streets','ruins','gorge'],
  ruins:['open','streets','ruins','ruins','gorge','gorge'],
  fortress:['open','streets','streets','streets','ruins','gorge'],
}

/** Jittered region centres produce coherent terrain, with an independent seeded stream. */
export function generateTerrain(width:number,height:number,seed:number,profile:TerrainProfile):string[][] {
  const random=mulberry32(deriveStreamSeed(seed,`terrain-regions-v1:${profile}`)), kinds=profiles[profile]
  const centres:Array<{x:number;y:number;kind:TerrainKind;phase:number}>=[]
  const size=18, offset=Math.floor(random()*kinds.length)
  for(let y=0;y<height;y+=size)for(let x=0;x<width;x+=size)
    centres.push({x:x+4+random()*10,y:y+4+random()*10,kind:kinds[(centres.length+offset)%kinds.length],phase:Math.floor(random()*8)})
  const grid=Array.from({length:height},()=>Array<string>(width).fill('#'))
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    let region=centres[0],distance=Infinity
    for(const centre of centres){const d=(x-centre.x)**2+(y-centre.y)**2;if(d<distance){distance=d;region=centre}}
    const u=(x+region.phase)%10,v=(y+region.phase)%10
    let tile='.'
    if(region.kind==='streets'){
      // Courtyard buildings separated by streets, with doors on opposite sides.
      if(u>=2&&u<=7&&v>=2&&v<=7&&(u===2||u===7||v===2||v===7))
        tile=(v===4&&(u===2||u===7))?'.':'#'
    }else if(region.kind==='ruins'){
      if((u===3&&v>=2&&v<=7)||(v===6&&u>=3&&u<=8))tile=random()<.3?'C':'#'
      if(tile!=='.'&&random()<.25)tile='.'
    }else if(region.kind==='gorge'){
      // Winding impassable ridges; periodic bridges leave alternate crossings.
      const ridge=(x+Math.round(3*Math.sin((y+region.phase)/5))+region.phase+20)%11
      if(ridge<4&&(y+region.phase)%13>2)tile='O'
      else if(ridge===4&&(y+region.phase)%7===0)tile='C'
    }else if(u===4&&v===4)tile='C'
    grid[y][x]=tile
  }
  return grid
}
