"use client"

import { useState, useEffect } from "react"
import { loadMaps, getAllMaps, getMapById } from "@/lib/game/map-repository"

export default function BrowserMapTestPage() {
  const [maps, setMaps] = useState(getAllMaps())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function testMapLoading() {
      setLoading(true)
      setError(null)
      try {
        await loadMaps()
        const loadedMaps = getAllMaps()
        setMaps(loadedMaps)
        console.log('Loaded maps in browser:', loadedMaps)
        
        // 检查第一个地图的格子类型
        if (loadedMaps.length > 0) {
          const firstMap = loadedMaps[0]
          console.log('First map:', firstMap)
          console.log('First 10 tiles:', firstMap.tiles.slice(0, 10))
          
          // 统计格子类型
          const typeCount = {}
          firstMap.tiles.forEach(tile => {
            const type = tile.props.type
            typeCount[type] = (typeCount[type] || 0) + 1
          })
          console.log('Tile type count:', typeCount)
        }
      } catch (err) {
        console.error('Error loading maps:', err)
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }
    testMapLoading()
  }, [])

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">浏览器地图加载测试</h1>
      
      {loading ? (
        <div>加载中...</div>
      ) : error ? (
        <div className="text-red-500">错误: {error}</div>
      ) : (
        <div>
          <div className="mb-4">
            <h2 className="text-xl font-semibold mb-2">加载的地图</h2>
            <ul className="list-disc pl-6">
              {maps.map(map => (
                <li key={map.id}>
                  {map.name} ({map.width}x{map.height}) - {map.tiles.length} 个格子
                </li>
              ))}
            </ul>
          </div>
          
          {maps.length > 0 && (
            <div className="mb-4">
              <h2 className="text-xl font-semibold mb-2">第一个地图的格子类型统计</h2>
              <div className="bg-gray-100 p-4 rounded">
                <p>请打开浏览器控制台查看详细的地图数据和格子类型统计</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}