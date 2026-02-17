import { getMapById, getAllMaps, loadMaps, type BoardMap } from "@/lib/game/map-repository"

// 预加载地图数据
loadMaps().catch(error => {
  console.error('Error preloading maps:', error)
})

export const DEFAULT_MAP_ID = "arena-8x6"

// 获取地图
export function getMap(id: string): BoardMap | undefined {
  return getMapById(id)
}

// 获取所有地图
export function listMaps(): BoardMap[] {
  return getAllMaps()
}

// 加载地图数据（用于需要手动触发加载的场景）
export { loadMaps }


