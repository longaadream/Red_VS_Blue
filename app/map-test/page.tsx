"use client"

import { useState, useEffect } from "react"
import { loadMaps, getAllMaps, getMapById } from "@/lib/game/map-repository"
import { GameBoard } from "@/components/game-board"

export default function MapTestPage() {
  const [maps, setMaps] = useState(getAllMaps())
  const [loading, setLoading] = useState(true)
  const [selectedMapId, setSelectedMapId] = useState<string | undefined>(undefined)

  useEffect(() => {
    async function testMapLoading() {
      setLoading(true)
      await loadMaps()
      const loadedMaps = getAllMaps()
      setMaps(loadedMaps)
      if (loadedMaps.length > 0) {
        setSelectedMapId(loadedMaps[0].id)
      }
      setLoading(false)
      console.log('Loaded maps:', loadedMaps)
    }
    testMapLoading()
  }, [])

  const selectedMap = selectedMapId ? getMapById(selectedMapId) : undefined

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">地图加载测试</h1>
      
      {loading ? (
        <div>加载中...</div>
      ) : (
        <div>
          <div className="mb-4">
            <h2 className="text-xl font-semibold mb-2">地图列表</h2>
            <ul className="list-disc pl-6">
              {maps.map(map => (
                <li key={map.id}>
                  {map.name} ({map.width}x{map.height}) - {map.tiles.length} 个格子
                  <button 
                    onClick={() => setSelectedMapId(map.id)}
                    className="ml-2 px-2 py-1 bg-blue-500 text-white rounded"
                  >
                    查看
                  </button>
                </li>
              ))}
            </ul>
          </div>
          
          {selectedMap && (
            <div className="mb-4">
              <h2 className="text-xl font-semibold mb-2">地图详情</h2>
              <div className="mb-2">
                <strong>ID:</strong> {selectedMap.id}<br />
                <strong>名称:</strong> {selectedMap.name}<br />
                <strong>尺寸:</strong> {selectedMap.width}x{selectedMap.height}<br />
                <strong>格子数量:</strong> {selectedMap.tiles.length}
              </div>
              <div className="mb-2">
                <strong>前5个格子:</strong>
                <ul className="list-disc pl-6">
                  {selectedMap.tiles.slice(0, 5).map(tile => (
                    <li key={tile.id}>
                      ({tile.x}, {tile.y}) - {tile.props.type} - walkable: {tile.props.walkable}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mb-4">
                <strong>地图渲染:</strong>
                <div className="mt-2">
                  <GameBoard map={selectedMap} />
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}