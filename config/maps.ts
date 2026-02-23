import { getMapById, getAllMaps, loadMaps, type BoardMap } from "@/lib/game/map-repository"

// 预加载地图数据
loadMaps().catch(error => {
  console.error('Error preloading maps:', error)
})

export const DEFAULT_MAP_ID = "arena-8x6"

// 获取地图
export async function getMapAsync(id: string): Promise<BoardMap | undefined> {
  // 确保地图数据已经加载
  await loadMaps()
  return getMapById(id)
}

// 同步获取地图（用于不需要等待加载完成的场景）
export function getMap(id: string): BoardMap | undefined {
  return getMapById(id)
}

// 获取所有地图
export async function listMapsAsync(): Promise<BoardMap[]> {
  // 确保地图数据已经加载
  await loadMaps()
  return getAllMaps()
}

// 同步获取所有地图（用于不需要等待加载完成的场景）
export function listMaps(): BoardMap[] {
  return getAllMaps()
}

// 导出GameMap类型
export type GameMap = BoardMap

// 导出getAllMaps函数
export { getAllMaps }

// 加载地图数据（用于需要手动触发加载的场景）
export { loadMaps }


