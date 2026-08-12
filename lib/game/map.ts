export type TileId = string

export type TileType = "floor" | "wall" | "spawn" | "cover" | "hole" | "lava" | "spring" | "chargepad"

export interface TileProperties {
  /** 是否可以走过去 */
  walkable: boolean
  /** 子弹是否可以穿过 */
  bulletPassable: boolean
  /** 地形类型，可扩展做特殊规则 */
  type: TileType
  /** 高度、伤害等可选信息 */
  height?: number
  /** 每回合造成真实伤害（如熔岩格） */
  damagePerTurn?: number
  /** 每回合回复HP（如治愈泉） */
  healPerTurn?: number
  /** 每回合给站在上面的棋子提供充能点（如充能台） */
  chargePerTurn?: number
  /** 是否是暗影步目标位置 */
  shadowStepTarget?: boolean
  /** 子弹是否可以穿过（别名） */
  bullet?: boolean
}

export interface Tile {
  id: TileId
  /** 网格坐标（0,0 在左上角） */
  x: number
  y: number
  props: TileProperties
}

export interface BoardMap {
  id: string
  name: string
  width: number
  height: number
  /** 所有格子，一般按 x+y 排序 */
  tiles: Tile[]
  rules?: unknown[]
}

/** 用于“字符画地图”的图例 */
export interface LegendEntry extends TileProperties {
  /** 在 layout 里用的单个字符，比如 "." "#" "S" */
  char: string
}

export interface AsciiMapConfig {
  id: string
  name: string
  /** 每一行的字符串，长度应当一致 */
  layout: string[]
  /** 字符 -> 格子属性 的映射 */
  legend: LegendEntry[]
}

const legendByChar = (legend: LegendEntry[]): Record<string, LegendEntry> => {
  const dict: Record<string, LegendEntry> = {}
  for (const entry of legend) {
    dict[entry.char] = entry
  }
  return dict
}

/**
 * 从“字符画”定义生成一个 BoardMap
 *
 * 例如：
 * layout: [
 *   "########",
 *   "#..S..#",
 *   "########",
 * ]
 */
export function createMapFromAscii(config: AsciiMapConfig): BoardMap {
  const { id, name, layout, legend } = config
  if (layout.length === 0) {
    throw new Error("layout must not be empty")
  }

  const width = layout[0]!.length
  const height = layout.length
  const dict = legendByChar(legend)

  const tiles: Tile[] = []

  layout.forEach((row, y) => {
    if (row.length !== width) {
      throw new Error("all layout rows must have the same length")
    }

    Array.from(row).forEach((ch, x) => {
      const def = dict[ch]
      if (!def) {
        throw new Error(`no legend entry for character "${ch}"`)
      }

      tiles.push({
        id: `${id}-${x}-${y}`,
        x,
        y,
        props: {
          walkable: def.walkable,
          bulletPassable: def.bulletPassable,
          type: def.type,
          height: def.height,
          damagePerTurn: def.damagePerTurn,
          healPerTurn: def.healPerTurn,
          chargePerTurn: def.chargePerTurn,
        },
      })
    })
  })

  return { id, name, width, height, tiles }
}

