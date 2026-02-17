import { loadJsonFiles } from './file-loader'
import { createMapFromAscii, type AsciiMapConfig, type BoardMap } from './map'

let mapsCache: Record<string, BoardMap> = {}
let isLoading = false

// 加载地图数据
export async function loadMaps() {
  if (isLoading) return
  
  isLoading = true
  try {
    // 直接从 /api/maps 获取地图数据
    const response = await fetch('/api/maps')
    if (!response.ok) {
      throw new Error(`Failed to fetch maps: ${response.status}`)
    }
    const mapConfigs = await response.json() as Record<string, AsciiMapConfig>
    const maps: Record<string, BoardMap> = {}
    
    console.log('Map configs:', mapConfigs)
    
    // 遍历每个地图配置
    Object.values(mapConfigs).forEach(config => {
      console.log('Processing map:', config)
      try {
        const map = createMapFromAscii(config)
        maps[map.id] = map
        console.log('Created map:', map)
        // 检查第一个格子的类型
        if (map.tiles.length > 0) {
          console.log('First tile type:', map.tiles[0].props.type)
        }
      } catch (error) {
        console.error(`Error creating map from config ${config.id}:`, error)
      }
    })
    
    console.log('Final maps:', maps)
    mapsCache = maps
  } catch (error) {
    console.error('Error loading maps:', error)
  } finally {
    isLoading = false
  }
}

// 获取所有地图
export function getAllMaps(): BoardMap[] {
  return Object.values(mapsCache)
}

// 根据ID获取地图
export function getMapById(id: string): BoardMap | undefined {
  return mapsCache[id]
}

// 检查地图是否存在
export function mapExists(id: string): boolean {
  return id in mapsCache
}

// 清空地图缓存（用于测试或重新加载）
export function clearMapsCache() {
  mapsCache = {}
}
